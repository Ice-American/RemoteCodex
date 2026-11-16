// Fences explicit new-chat requests before native dispatch; unknown results are never replayed.
import { requestFingerprint } from './requests.mjs';
import { validThreadId } from './history.mjs';

const validOperation = value => typeof value === 'string' && /^[\w-]{8,160}$/.test(value);
function selection(input, host) {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).some(key => !['host', 'operationId', 'projectId', 'prompt', 'title'].includes(key)) ||
      !validOperation(input.operationId) || typeof input.prompt !== 'string' || !input.prompt.trim() || input.prompt.length > 32000 ||
      input.projectId != null && (typeof input.projectId !== 'string' || !input.projectId.trim() || input.projectId.length > 200) ||
      input.title !== undefined && (typeof input.title !== 'string' || input.title.length > 200)) throw Error('新聊天参数无效，请检查内容与项目选择');
  if (input.host !== undefined && input.host !== host) throw Error('目标电脑不一致，请重新选择');
  return { projectId: input.projectId ?? null, prompt: input.prompt, ...(input.title === undefined ? {} : { title: input.title }) };
}
const unknown = deduplicated => ({ status: 'unknown', message: '创建结果尚未确认，请先查看聊天列表，勿重复创建', ...(deduplicated ? { deduplicated: true } : {}) });
function receiptView(record) {
  if (record.status === 'submitted' && validThreadId(record.threadId)) return { status: 'confirmed', threadId: record.threadId, message: '官方已创建聊天', deduplicated: true };
  if (record.status === 'submitted' && validOperation(record.clientThreadId)) return { status: 'submitted', clientThreadId: record.clientThreadId, message: '官方正在创建，请稍后查看聊天列表', deduplicated: true };
  return unknown(true);
}

export class CreationManager {
  constructor({ nativeTools, journal, hostId }) { this.nativeTools = nativeTools; this.journal = journal; this.hostId = hostId; this.inflight = new Map(); }
  async capability() { return this.nativeTools.capability(); }
  async create(input) {
    let args, apiFingerprint;
    try { args = selection(input, this.hostId); apiFingerprint = requestFingerprint({ host: this.hostId, method: 'create_thread', ...args }); }
    catch (error) { return { status: 'rejected', message: error.message }; }
    const operationId = input.operationId, previous = this.journal.records.get(operationId), active = this.inflight.get(operationId);
    // Receipt keys are shared with ordinary replies. A creation must never
    // reinterpret a reply's receipt, even if an operation ID collides.
    if (previous && (previous.methodKey !== 'create_thread' || previous.apiFingerprint !== apiFingerprint) || active && active.apiFingerprint !== apiFingerprint)
      return { status: 'rejected', message: '此操作标识已用于不同内容，请核对已有聊天' };
    if (active) return active.promise;
    if (previous) return receiptView(previous);
    if (this.journal.records.size >= 10000) return { status: 'rejected', message: '本工具收据已满，未派发创建请求' };
    // Publish the in-flight guard before preflight awaits, so concurrent HTTP
    // requests join exactly one native request even before its durable fence.
    const attempt = { apiFingerprint };
    const promise = Promise.resolve().then(async () => {
      let dispatched = false;
      const base = { operationId, apiFingerprint, methodKey: 'create_thread' };
      try {
        const result = await this.nativeTools.create(args, { beforeDispatch: () => {
          if (dispatched) throw Error('创建请求已派发');
          if (this.journal.records.size >= 10000) throw Error('本工具收据已满，未派发创建请求');
          this.journal.save({ ...base, status: 'dispatched' });
          dispatched = true;
        } });
        if (!dispatched) throw Error('官方创建接口未确认派发');
        if (validThreadId(result?.threadId)) {
          this.journal.save({ ...base, status: 'submitted', threadId: result.threadId });
          return { status: 'confirmed', threadId: result.threadId, message: '官方已创建聊天' };
        }
        if (validOperation(result?.clientThreadId)) {
          this.journal.save({ ...base, status: 'submitted', clientThreadId: result.clientThreadId });
          return { status: 'submitted', clientThreadId: result.clientThreadId, message: '官方正在创建，请稍后查看聊天列表' };
        }
        throw Error('官方创建结果无有效聊天标识');
      } catch (error) {
        // An RPC rejection or a lost ACK after the write cannot prove that the
        // desktop created nothing. Preserve the dispatch fence across restarts.
        if (dispatched) { try { this.journal.save({ ...base, status: 'unknown' }); } catch {} return unknown(false); }
        return { status: 'rejected', message: error.message || '创建准备失败，未派发请求' };
      }
    }).finally(() => this.inflight.delete(operationId));
    attempt.promise = promise; this.inflight.set(operationId, attempt); return promise;
  }
}
