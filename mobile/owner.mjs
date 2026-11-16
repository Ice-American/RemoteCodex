// Control only the existing Desktop owner; never start or resume a separate engine.
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { Pipe } from '../src/transport.mjs';
import { applyPatches, activeTurnId, runtimeStatus } from '../src/state.mjs';
import { composeQueuedMessage } from '../src/queue.mjs';
import { OWNER_METHODS, OWNER_SUPPORTED_VERSIONS, OWNER_HANDSHAKE_VERSION } from './protocols.mjs';

const WRITES = new Set(['start', 'steer', 'userInput', 'commandApproval', 'fileApproval',
  'permissions', 'mcpElicitation', 'interrupt', 'settings', 'queue']);
const uuid = value => typeof value === 'string' && /^[a-f0-9-]{36}$/i.test(value);
const canonical = value => Array.isArray(value) ? '[' + value.map(canonical).join(',') + ']'
  : value && typeof value === 'object' ? '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}'
    : JSON.stringify(value);
const digest = value => createHash('sha256').update(canonical(value)).digest('hex');
const clone = value => structuredClone(value);
const validOwner = value => typeof value === 'string' && value.length > 0 && value.length <= 200;
const revision = value => Number.isSafeInteger(value) && value >= 0 || typeof value === 'string' && value.length > 0 && value.length <= 200;
const failure = (message, code = 'OWNER_UNAVAILABLE') => Object.assign(Error(message), { code });

export class OwnerClient extends EventEmitter {
  constructor({ socketPath, verifyEndpoint, pipeFactory = path => new Pipe(path, 'desktop'),
    protocolVersions = {}, hostId = 'local', timeoutMs = 15000, operations = new Map(),
    onOperation = () => {}, maxOperations = 10000 } = {}) {
    super();
    if (typeof socketPath !== 'string' || !socketPath || typeof verifyEndpoint !== 'function')
      throw Error('A socket path and endpoint verifier are required');
    Object.assign(this, { socketPath, verifyEndpoint, pipeFactory, protocolVersions, hostId,
      timeoutMs, operations, onOperation, maxOperations });
    this.generation = 0;
    this.sequence = 0;
    this.connected = false;
    this.owners = new Map();
    this.snapshots = new Map();
    this.waiters = new Set();
    this.followIntents = new Map();
    this.nativeSubscriptions = new Map();
    // A process restart cannot establish whether an earlier write reached
    // Desktop. Retain its fence and expose uncertainty instead of replaying it.
    for (const [id, record] of this.operations) {
      if (record?.status === 'dispatched') {
        const unknown = { ...record, status: 'unknown', message: 'The previous process ended before the outcome was confirmed.' };
        this.onOperation(clone(unknown));
        this.operations.set(id, unknown);
      }
    }
  }
  version(key) {
    const method = OWNER_METHODS[key];
    if (!method) throw failure('Unknown owner method', 'UNSUPPORTED_METHOD');
    // initialize is the transport handshake. Its success is live evidence;
    // it must not be invented as a static protocol-table observation.
    if (key === 'initialize') return OWNER_HANDSHAKE_VERSION;
    const map = this.protocolVersions.versions ?? this.protocolVersions;
    const value = map[method] ?? map[key];
    if (!Number.isSafeInteger(value) || !OWNER_SUPPORTED_VERSIONS[key]?.includes(value))
      throw failure('Owner protocol has not been observed: ' + key, 'UNSUPPORTED_METHOD');
    return value;
  }
  subscribe(listener) {
    this.on('change', listener);
    return () => this.off('change', listener);
  }
  publish(type, values = {}) {
    const event = { type, generation: this.generation, ...values };
    // A failing SSE consumer must not interrupt receipt persistence or IPC.
    for (const listener of this.listeners('change')) {
      try { listener(clone(event)); } catch {}
    }
  }
  async connect() {
    if (this.connected) return this.identity;
    if (this.connecting) return this.connecting;
    const generation = ++this.generation;
    const pending = this.open(generation);
    this.connecting = pending;
    try { return await pending; }
    finally { if (this.connecting === pending) this.connecting = null; }
  }
  async open(generation) {
    this.version('initialize');
    const before = await this.verifyEndpoint(this.socketPath);
    if (!before || before.verified === false) throw failure('Endpoint identity was not verified');
    if (generation !== this.generation) throw failure('Connection superseded');
    const pipe = this.pipeFactory(this.socketPath, 'desktop');
    this.pipe = pipe;
    const frame = value => this.receive(value, pipe, generation);
    const lost = () => this.invalidate(pipe, generation, 'Owner connection interrupted');
    pipe.on('frame', frame);
    pipe.on('disconnected', lost);
    this.handlers = { pipe, frame, lost };
    try {
      await pipe.connect();
      const after = await this.verifyEndpoint(this.socketPath);
      if (!after || after.verified === false || canonical(before) !== canonical(after))
        throw failure('Endpoint identity changed during connection');
      if (this.pipe !== pipe || this.generation !== generation || pipe.socket?.destroyed)
        throw failure('Connection changed during verification');
      this.identity = clone(after);
      this.connected = true;
      this.handshake = { version: OWNER_HANDSHAKE_VERSION, source: 'live-owner-initialize' };
      this.abort = new AbortController();
      this.publish('connection', { connected: true });
      return clone(this.identity);
    } catch (error) {
      this.invalidate(pipe, generation, 'Owner connection could not be verified');
      pipe.close();
      throw error;
    }
  }
  invalidate(pipe, generation, reason) {
    if (pipe !== this.pipe || generation !== this.generation) return;
    this.connected = false;
    this.handshake = null;
    this.generation++;
    this.abort?.abort();
    for (const intent of this.followIntents.values()) intent.abort();
    this.followIntents.clear();
    this.nativeSubscriptions.clear();
    this.owners.clear();
    this.snapshots.clear();
    for (const waiter of this.waiters) waiter.reject(failure(reason));
    this.waiters.clear();
    this.publish('connection', { connected: false, reason });
  }
  close() {
    const pipe = this.pipe;
    if (!pipe) return;
    this.invalidate(pipe, this.generation, 'Owner connection closed');
    if (this.handlers?.pipe === pipe) {
      pipe.off('frame', this.handlers.frame);
      pipe.off('disconnected', this.handlers.lost);
    }
    pipe.close();
    this.pipe = null;
    this.identity = null;
  }
  currentConnection() {
    if (!this.connected || !this.pipe || this.pipe.socket?.destroyed)
      throw failure('Read the owner state again after reconnecting');
    return { pipe: this.pipe, generation: this.generation, signal: this.abort.signal };
  }
  async #rpc(key, params, options = {}) {
    const connection = this.currentConnection(), version = this.version(key);
    const { signal, ...requestOptions } = options;
    const signals = [connection.signal, ...(signal ? [signal] : [])];
    if (signals.some(value => value.aborted)) throw failure('Owner request cancelled', 'SUBSCRIPTION_CANCELLED');
    let abortListener;
    const disconnected = new Promise((_, reject) => {
      abortListener = () => {
        const cancelled = signal?.aborted && !connection.signal.aborted;
        reject(failure(cancelled ? 'Owner subscription cancelled' : 'Owner connection interrupted',
          cancelled ? 'SUBSCRIPTION_CANCELLED' : 'CONNECTION_INTERRUPTED'));
      };
      for (const value of signals) value.addEventListener('abort', abortListener, { once: true });
    });
    try {
      const response = await Promise.race([connection.pipe.request(OWNER_METHODS[key], params,
        { version, timeoutMs: options.timeoutMs ?? this.timeoutMs, ...requestOptions }), disconnected]);
      if (!this.connected || connection.pipe !== this.pipe || connection.generation !== this.generation)
        throw failure('Owner response belongs to an old connection', 'CONNECTION_INTERRUPTED');
      return response;
    } finally { for (const value of signals) value.removeEventListener('abort', abortListener); }
  }
  async follow(threadId) {
    if (!uuid(threadId)) throw failure('Invalid thread ID');
    const connection = this.currentConnection();
    this.followIntents.get(threadId)?.abort();
    const intent = new AbortController();
    this.followIntents.set(threadId, intent);
    this.owners.delete(threadId);
    this.unknown(threadId, 'Refreshing Desktop owner');
    const result = await this.#rpc('owner', { hostId: this.hostId, conversationId: threadId }, { signal: intent.signal });
    if (!validOwner(result.handledByClientId)) throw failure('No live Desktop owner was found');
    if (connection.generation !== this.generation || this.followIntents.get(threadId) !== intent || intent.signal.aborted)
      throw failure('Owner subscription was cancelled or changed', 'SUBSCRIPTION_CANCELLED');
    const owner = { threadId, owner: result.handledByClientId,
      supportsUntrustedAppInput: result.result?.supportsUntrustedAppInput === true,
      generation: this.generation };
    const prior = this.nativeSubscriptions.get(threadId);
    // Unsubscribe the old recipient if Desktop ownership moved. The broadcast
    // changes only this client's follower, never the native task's lifetime.
    if (prior && prior.owner !== owner.owner)
      connection.pipe.broadcast(OWNER_METHODS.following,
        { hostId: this.hostId, conversationId: threadId, following: false }, this.version('following'), [prior.owner]);
    this.owners.set(threadId, owner);
    this.nativeSubscriptions.set(threadId, owner);
    connection.pipe.broadcast(OWNER_METHODS.following,
      { hostId: this.hostId, conversationId: threadId, following: true }, this.version('following'), [owner.owner]);
    if (intent.signal.aborted) throw failure('Owner subscription was cancelled', 'SUBSCRIPTION_CANCELLED');
    return clone(owner);
  }
  unfollow(threadId) {
    if (!uuid(threadId)) throw failure('Invalid thread ID');
    const native = this.nativeSubscriptions.get(threadId);
    this.followIntents.get(threadId)?.abort();
    this.followIntents.delete(threadId);
    this.nativeSubscriptions.delete(threadId);
    this.owners.delete(threadId);
    // Clear local facts before sending, so a queued frame cannot revive a
    // departed chat. Dispatched writes keep their independent receipt fence.
    this.unknown(threadId, 'Owner subscription cancelled');
    for (const waiter of this.waiters)
      if (waiter.threadId === threadId) waiter.reject(failure('Owner subscription cancelled', 'SUBSCRIPTION_CANCELLED'));
    let notificationSent = false;
    if (native && this.connected && native.generation === this.generation) {
      try {
        this.currentConnection().pipe.broadcast(OWNER_METHODS.following,
          { hostId: this.hostId, conversationId: threadId, following: false }, this.version('following'), [native.owner]);
        notificationSent = true;
      } catch {
        // There is no native ACK for this broadcast. A throwing transport can
        // already have sent it; do not replay an uncertain notification.
        notificationSent = null;
      }
    }
    const result = { threadId, subscribed: false, notificationSent, confirmed: false };
    this.publish('unfollowed', result);
    return result;
  }
  supports(threadId, key) {
    if (!this.connected || !this.pipe || this.pipe.socket?.destroyed) return false;
    try { this.version(key); } catch { return false; }
    if (!WRITES.has(key)) return true;
    const owner = this.owners.get(threadId), snapshot = this.snapshots.get(threadId);
    if (!owner?.supportsUntrustedAppInput || !snapshot?.status.confirmed ||
        owner.generation !== this.generation || snapshot.generation !== this.generation || snapshot.owner !== owner.owner)
      return false;
    if (key === 'start') return snapshot.status.type === 'idle';
    if (key === 'steer') return snapshot.status.type === 'running';
    if (key === 'interrupt') return typeof snapshot.activeTurnId === 'string' && !!snapshot.activeTurnId;
    return true;
  }
  snapshot(threadId) {
    const value = this.connected && this.snapshots.get(threadId);
    return value ? clone(value) : null;
  }
  async freshSnapshot(threadId, { timeoutMs = this.timeoutMs } = {}) {
    const minimum = this.sequence;
    this.unknown(threadId, 'Waiting for a fresh owner snapshot');
    const owner = await this.follow(threadId);
    this.currentConnection();
    if (this.owners.get(threadId)?.owner !== owner.owner || !this.nativeSubscriptions.has(threadId))
      throw failure('Owner subscription was cancelled', 'SUBSCRIPTION_CANCELLED');
    const ready = this.snapshots.get(threadId);
    if (ready?.sequence > minimum) return clone(ready);
    return new Promise((resolve, reject) => {
      const waiter = { threadId, minimum, resolve, reject };
      const timer = setTimeout(() => {
        this.waiters.delete(waiter);
        reject(failure('Fresh owner snapshot timed out'));
      }, timeoutMs);
      waiter.resolve = value => { clearTimeout(timer); this.waiters.delete(waiter); resolve(clone(value)); };
      waiter.reject = error => { clearTimeout(timer); this.waiters.delete(waiter); reject(error); };
      this.waiters.add(waiter);
    });
  }
  unknown(threadId, reason) {
    this.snapshots.delete(threadId);
    this.publish('unknown', { threadId, reason });
  }
  receive(frame, pipe, generation) {
    if (!this.connected || this.pipe !== pipe || this.generation !== generation || frame.type !== 'broadcast' ||
        frame.method !== OWNER_METHODS.stream) return;
    const threadId = frame.params?.conversationId, owner = this.owners.get(threadId);
    if (!owner || frame.sourceClientId !== owner.owner || frame.params?.hostId !== this.hostId) return;
    try {
      if (frame.version !== this.version('stream')) throw Error('Owner stream protocol changed');
      const change = frame.params.change;
      if (!change || !revision(change.revision)) throw Error('Invalid owner revision');
      const previous = this.snapshots.get(threadId);
      let state;
      if (change.type === 'snapshot') state = clone(change.conversationState);
      else if (change.type === 'patches' && previous && previous.revision === change.baseRevision && Array.isArray(change.patches))
        state = applyPatches(previous.state, change.patches);
      else throw Error('Owner stream revision gap');
      if (!state || state.id !== threadId) throw Error('Owner snapshot thread mismatch');
      const snapshot = { threadId, owner: owner.owner, generation, revision: change.revision,
        sequence: ++this.sequence, observedAt: Date.now(), state,
        activeTurnId: activeTurnId(state), status: runtimeStatus(state), source: 'official-desktop-owner-IPC-live' };
      this.snapshots.set(threadId, snapshot);
      this.publish('snapshot', { threadId, snapshot: clone(snapshot) });
      for (const waiter of this.waiters)
        if (waiter.threadId === threadId && snapshot.sequence > waiter.minimum) waiter.resolve(snapshot);
    } catch (error) { this.unknown(threadId, error.message); }
  }
  assertWrite(threadId, { expectedOwner, expectedTurnId } = {}) {
    this.currentConnection();
    const owner = this.owners.get(threadId), snapshot = this.snapshots.get(threadId);
    if (!snapshot || !owner || snapshot.generation !== this.generation || snapshot.owner !== owner.owner)
      throw failure('A fresh live owner snapshot is required');
    if (owner.supportsUntrustedAppInput !== true)
      throw failure('The Desktop owner does not accept input from this client', 'INPUT_NOT_SUPPORTED');
    if (expectedOwner !== owner.owner || expectedTurnId !== snapshot.activeTurnId)
      throw failure('The owner or active turn changed; review the current state', 'STALE_OWNER_STATE');
    if (!snapshot.status.confirmed) throw failure('The Desktop runtime state is unknown');
    return snapshot;
  }
  operation(record) {
    // A caller can persist this receipt before dispatch. Throwing prevents a write.
    this.onOperation(clone(record));
    this.operations.set(record.operationId, record);
    this.publish('operation', { operation: clone(record) });
  }
  async requestToOwner(threadId, methodKey, params, {
    operationId, expectedOwner, expectedTurnId, timeoutMs = this.timeoutMs,
    validateResponse, intentFingerprint,
  } = {}) {
    if (!WRITES.has(methodKey) || !OWNER_METHODS[methodKey]) throw failure('Owner method is not writable', 'UNSUPPORTED_METHOD');
    if (!uuid(threadId) || typeof operationId !== 'string' || !/^[\w-]{8,160}$/.test(operationId))
      throw failure('A valid thread and operation ID are required');
    if (!params || typeof params !== 'object' || Array.isArray(params) ||
        params.conversationId != null && params.conversationId !== threadId ||
        params.threadId != null && params.threadId !== threadId)
      throw failure('Owner request thread mismatch');
    const input = { ...clone(params), conversationId: threadId };
    const fingerprint = digest([threadId, methodKey, input, expectedOwner, expectedTurnId]);
    const previous = this.operations.get(operationId);
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw failure('Operation ID was already used for another request');
      return { ...clone(previous), deduplicated: true };
    }
    if (this.operations.size >= this.maxOperations) throw failure('Operation receipt limit reached');
    this.version(methodKey);
    const snapshot = this.assertWrite(threadId, { expectedOwner, expectedTurnId });
    if (methodKey === 'start' && (snapshot.status.type !== 'idle' || input.turnStart?.request?.threadId !== threadId))
      throw failure('Start requires the same idle Desktop thread');
    if (methodKey === 'steer' && snapshot.status.type !== 'running')
      throw failure('Steer requires the currently running turn');
    if (methodKey === 'interrupt' && (typeof expectedTurnId !== 'string' || !expectedTurnId))
      throw failure('Interrupt requires a confirmed active turn');
    const record = { operationId, fingerprint, threadId, methodKey, owner: expectedOwner,
      expectedTurnId, generation: this.generation, status: 'dispatched',
      ...(intentFingerprint ? { intentFingerprint } : {}) };
    this.operation(record);
    // No await occurs between the final state check and sending the one request.
    try {
      this.assertWrite(threadId, { expectedOwner, expectedTurnId });
      const response = await this.#rpc(methodKey, input, { targetClientId: expectedOwner, timeoutMs });
      // Current Desktop puts the method on the response envelope. Some older
      // owners repeat it inside result; if present that copy must also match.
      // The wire success envelope, verified owner and method-specific result
      // are all required. An absent redundant field is not a lost delivery.
      if (response.type !== 'response' || response.resultType !== 'success' ||
          response.handledByClientId !== expectedOwner || response.method !== OWNER_METHODS[methodKey] ||
          !response.result || typeof response.result !== 'object' ||
          Object.hasOwn(response.result, 'method') && response.result.method !== OWNER_METHODS[methodKey])
        throw failure('Owner acknowledgement did not match the request');
      const result = response.result?.result;
      const turnId = result?.turn?.id ?? result?.turnId ?? result?.interruptedTurnId ?? null;
      if (methodKey === 'start' && (typeof turnId !== 'string' || !turnId)) throw failure('Start acknowledgement lacks a turn ID');
      if (methodKey === 'steer' && turnId !== expectedTurnId) throw failure('Steer acknowledgement belongs to another turn');
      if (methodKey !== 'start' && expectedTurnId != null && turnId != null && turnId !== expectedTurnId)
        throw failure('Owner acknowledgement belongs to another turn');
      const responseThread = result?.turn?.threadId ?? result?.threadId;
      if (responseThread != null && responseThread !== threadId) throw failure('Acknowledgement belongs to another thread');
      const confirmed = methodKey === 'start' || methodKey === 'steer' ? true
        : methodKey === 'settings' && this.version(methodKey) === 2 ? result?.applied === true
          : result?.ok === true;
      if (!confirmed || result?.ok === false || result?.applied === false ||
          methodKey === 'interrupt' && result?.interruptedTurnId !== expectedTurnId ||
          validateResponse && validateResponse(response, snapshot) !== true)
        throw failure('Owner did not confirm the requested action');
      const submitted = { ...record, status: 'submitted', turnId };
      this.operation(submitted);
      return clone(submitted);
    } catch {
      const unknown = { ...record, status: 'unknown', message: 'Submission outcome is unknown; refresh the official state before deciding what to do.' };
      // Keep the in-memory fence even if writing a later receipt fails.
      this.operations.set(operationId, unknown);
      try { this.operation(unknown); } catch {}
      return clone(unknown);
    }
  }
  async sendText(threadId, text, { operationId, expectedOwner, expectedTurnId, mode } = {}) {
    if (typeof text !== 'string' || !text.trim() || text.length > 20000) throw failure('Text must contain 1–20000 characters');
    const intentFingerprint = digest([threadId, text, expectedOwner, expectedTurnId, mode ?? 'start']);
    const prior = this.operations.get(operationId);
    if (prior) {
      if (prior.intentFingerprint !== intentFingerprint) throw failure('Operation ID was already used for another message');
      return { ...clone(prior), deduplicated: true };
    }
    const snapshot = this.assertWrite(threadId, { expectedOwner, expectedTurnId });
    const input = [{ type: 'text', text, text_elements: [] }];
    if (snapshot.status.type === 'idle') {
      if (mode != null && mode !== 'start') throw failure('The thread is idle; review before starting a new turn');
      return this.requestToOwner(threadId, 'start', { turnStart: { request: {
        threadId, input, clientUserMessageId: operationId,
      } } }, { operationId, expectedOwner, expectedTurnId, intentFingerprint });
    }
    if (snapshot.status.type !== 'running' || mode !== 'steer')
      throw failure('Choose steer explicitly for the current running turn; messages are not queued automatically');
    return this.requestToOwner(threadId, 'steer', { input, clientUserMessageId: operationId,
      restoreMessage: composeQueuedMessage(operationId, text, snapshot.state.cwd), attachments: [] },
    { operationId, expectedOwner, expectedTurnId, intentFingerprint });
  }
}
