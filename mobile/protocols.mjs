// Inspect the installed Desktop's private owner protocol without loading its code.
import fs from 'node:fs';
import { createHash } from 'node:crypto';

export const OWNER_METHODS = Object.freeze({
  initialize: 'initialize',
  owner: 'thread-owner-discovery',
  following: 'thread-stream-following-changed',
  stream: 'thread-stream-state-changed',
  start: 'thread-follower-start-turn',
  steer: 'thread-follower-steer-turn',
  userInput: 'thread-follower-submit-user-input',
  commandApproval: 'thread-follower-command-approval-decision',
  fileApproval: 'thread-follower-file-approval-decision',
  permissions: 'thread-follower-permissions-request-approval-response',
  mcpElicitation: 'thread-follower-submit-mcp-server-elicitation-response',
  interrupt: 'thread-follower-interrupt-turn',
  settings: 'thread-follower-update-thread-settings',
  queue: 'thread-follower-set-queued-follow-ups-state',
});

// Observing a new version is not proof that our payload adapter understands it.
export const OWNER_SUPPORTED_VERSIONS = Object.freeze({
  initialize: [1], owner: [1], following: [1], stream: [11, 13], start: [2], steer: [1],
  userInput: [1], commandApproval: [1], fileApproval: [1], permissions: [1],
  mcpElicitation: [1], interrupt: [4], settings: [1, 2], queue: [3],
});

// This transport handshake is validated by the connection, not the ASAR table.
export const OWNER_HANDSHAKE_VERSION = 1;

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const escaped = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function readExactly(fd, size, position) {
  const buffer = Buffer.alloc(size);
  let read = 0;
  while (read < size) {
    const count = fs.readSync(fd, buffer, read, size - read, position + read);
    if (!count) throw Error('Incomplete ASAR read');
    read += count;
  }
  return buffer;
}

/** The digest covers inspected code records, not the entire ASAR archive. */
export function readOwnerProtocols(asarPath, {
  maxHeaderBytes = 16 * 1024 * 1024,
  maxCodeBytes = 32 * 1024 * 1024,
  maxTotalCodeBytes = 128 * 1024 * 1024,
} = {}) {
  const fd = fs.openSync(asarPath, 'r');
  try {
    const before = fs.fstatSync(fd);
    if (!before.isFile() || before.size < 16) throw Error('Invalid ASAR file');
    const prefix = readExactly(fd, 16, 0);
    const headerBytes = prefix.readUInt32LE(12);
    const dataOffset = 8 + prefix.readUInt32LE(4);
    if (headerBytes < 2 || headerBytes > maxHeaderBytes ||
        dataOffset < 16 + headerBytes || dataOffset > before.size)
      throw Error('Invalid ASAR header bounds');
    const header = JSON.parse(readExactly(fd, headerBytes, 16).toString('utf8'));
    const files = [];
    const walk = (entries, parent = '', depth = 0) => {
      if (depth > 32 || !entries || typeof entries !== 'object' || Array.isArray(entries))
        throw Error('Invalid ASAR directory');
      for (const [name, item] of Object.entries(entries)) {
        if (!item || typeof item !== 'object' || name.includes('/') || name.includes('\\') || name === '..')
          throw Error('Invalid ASAR entry');
        const key = parent + name;
        if (item.files) walk(item.files, key + '/', depth + 1);
        else if (/^\.vite\/build\/[^/]+\.js$/.test(key) && !item.unpacked && !item.link) {
          files.push({ key, item });
          if (files.length > 512) throw Error('Too many ASAR code files');
        }
      }
    };
    walk(header.files);
    const observations = new Map();
    const records = [];
    let total = 0;
    for (const { key, item } of files.sort((a, b) => a.key.localeCompare(b.key))) {
      const offset = Number(item.offset), size = item.size;
      if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(size) || size < 0 ||
          size > maxCodeBytes || offset + dataOffset + size > before.size)
        throw Error('Invalid ASAR code bounds');
      total += size;
      if (total > maxTotalCodeBytes) throw Error('ASAR code scan exceeds bound');
      const bytes = readExactly(fd, size, dataOffset + offset);
      const text = bytes.toString('utf8'), methods = {};
      for (const method of Object.values(OWNER_METHODS)) {
        const matches = [...text.matchAll(new RegExp('[\"\x27]' + escaped(method) + '[\"\x27]\\s*:\\s*(\\d+)\\b', 'g'))];
        const found = [...new Set(matches.map(match => Number(match[1])))];
        if (!found.length) continue;
        methods[method] = found.length === 1 ? found[0] : found;
        const values = observations.get(method) ?? new Set();
        for (const value of found) values.add(value);
        observations.set(method, values);
      }
      if (Object.keys(methods).length) records.push({ file: key, sha256: hash(bytes), methods });
    }
    const after = fs.fstatSync(fd);
    if (before.size !== after.size || before.ino !== after.ino || before.mtimeMs !== after.mtimeMs)
      throw Error('ASAR changed during protocol inspection');
    const versions = {}, conflicts = {};
    for (const [method, found] of observations) {
      const values = [...found].sort((a, b) => a - b);
      if (values.length === 1) versions[method] = values[0];
      else conflicts[method] = values;
    }
    const sha256 = hash(JSON.stringify(records));
    return { versions, conflicts, records, sha256, codeSha256: sha256, source: 'installed-desktop-asar-code' };
  } finally {
    fs.closeSync(fd);
  }
}
