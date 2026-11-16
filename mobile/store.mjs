// Keeps bridge credentials in the OS store and persists only dispatch metadata.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
const exec = promisify(execFile);
const service = 'com.zhang.codex-mobile-control';
const validName = name => /^[a-z0-9-]{1,40}$/.test(name);
export const dataDirectory = () => process.platform === 'win32'
  ? path.join(process.env.LOCALAPPDATA ?? os.homedir(), 'CodexMobileControl')
  : path.join(os.homedir(), 'Library', 'Application Support', 'CodexMobileControl');
export function writePrivate(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = file + '.' + crypto.randomUUID() + '.tmp';
  const fd = fs.openSync(temp, 'wx', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value)); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  fs.renameSync(temp, file);
  // An acknowledged dispatch fence must survive a process restart. Flushing
  // the directory also preserves the rename on filesystems that support it.
  try { const parent = fs.openSync(path.dirname(file), 'r'); try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); } } catch {}
}
function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return fallback; throw Error('本工具保存的数据不可读，请保留现场并检查'); }
}
export class Secrets {
  constructor(dir = dataDirectory()) { this.dir = dir; this.cache = new Map(); }
  async get(name, { create = false, value = null } = {}) {
    if (!validName(name)) throw Error('Invalid credential name');
    if (this.cache.has(name)) return this.cache.get(name);
    let secret = null;
    if (process.platform === 'darwin') {
      try {
        secret = (await exec('/usr/bin/security', ['find-generic-password', '-a', os.userInfo().username, '-s', service + '.' + name, '-w'],
          { timeout: 15000, maxBuffer: 4096 })).stdout.trim();
      } catch (e) { if (e.code !== 44) throw Error('系统钥匙串暂不可用'); }
      if (!secret && (create || value)) {
        secret = value ?? crypto.randomBytes(32).toString('base64url');
        // Only a newly generated bridge key is passed to this OS tool. It is
        // never copied from Codex, printed, or placed in shell command text.
        await exec('/usr/bin/security', ['add-generic-password', '-a', os.userInfo().username,
          '-s', service + '.' + name, '-w', secret], { timeout: 15000, maxBuffer: 4096 });
      }
    } else if (process.platform === 'win32') {
      const file = path.join(this.dir, name + '.dpapi'), stored = readJson(file, null);
      const python = process.env.MOBILE_CONTROL_PYTHON ?? 'D:\\python\\python.exe';
      const script = fileURLToPath(new URL('../src/win_secret.py', import.meta.url));
      const transform = (operation, value) => new Promise((resolve, reject) => {
        const child = execFile(python, [script], { windowsHide: true, timeout: 15000, maxBuffer: 8192 }, (error, stdout) => {
          if (error) reject(Error('Windows 凭据保护失败'));
          else { try { resolve(JSON.parse(stdout).value); } catch { reject(Error('Windows 凭据响应无效')); } }
        });
        child.stdin.end(JSON.stringify({ operation, value }));
      });
      if (stored) secret = await transform('unprotect', stored.value);
      else if (create || value) {
        secret = value ?? crypto.randomBytes(32).toString('base64url');
        writePrivate(file, { value: await transform('protect', secret) });
      }
    } else throw Error('Unsupported credential store');
    if (value && secret !== value) throw Error('已配对密钥不同，未覆盖现有配对');
    if (secret) this.cache.set(name, secret);
    return secret;
  }
}
export class Journal {
  constructor(dir = dataDirectory()) {
    this.file = path.join(dir, 'operations.json');
    const rows = readJson(this.file, []);
    if (!Array.isArray(rows) || rows.length > 10000) throw Error('发送收据格式异常');
    this.records = new Map(rows.map(r => [r.operationId, r]));
  }
  save(record) {
    const clean = Object.fromEntries(['operationId', 'fingerprint', 'threadId', 'methodKey', 'owner',
      'expectedTurnId', 'generation', 'status', 'turnId', 'intentFingerprint', 'semanticFence', 'apiFingerprint'].filter(k => record[k] !== undefined).map(k => [k, record[k]]));
    const previous = this.records.get(clean.operationId);
    for (const key of ['semanticFence', 'apiFingerprint']) if (clean[key] == null && previous?.[key]) clean[key] = previous[key];
    const next = new Map(this.records); next.set(clean.operationId, clean);
    writePrivate(this.file, [...next.values()]); this.records.set(clean.operationId, clean);
  }
}
export const secretEqual = (a, b) => crypto.timingSafeEqual(crypto.createHash('sha256').update(String(a)).digest(), crypto.createHash('sha256').update(String(b)).digest());
