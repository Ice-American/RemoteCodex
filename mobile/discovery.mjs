// Verifies the running desktop endpoint without reading credentials or changing it.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
const exec = promisify(execFile);
const hash = data => createHash('sha256').update(JSON.stringify(data)).digest('hex');

export const codexHome = () => process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex');
export async function discoverNativeDesktop({ platform = process.platform, home = codexHome(), verifySignature = true } = {}) {
  if (platform === 'darwin') {
    const socketPath = path.join(home, 'ipc', 'ipc.sock');
    const st = await fs.lstat(socketPath);
    if (!st.isSocket() || st.uid !== process.getuid() || (st.mode & 0o022)) throw Error('官方会话接口权限异常');
    const { stdout } = await exec('/usr/sbin/lsof', ['-nP', '-a', '-U', '-Fpcn', socketPath], { timeout: 10000, maxBuffer: 1024 * 1024 });
    const records = []; let record;
    for (const line of stdout.split('\n')) {
      if (line[0] === 'p') { record = { pid: Number(line.slice(1)), names: [] }; records.push(record); }
      else if (record && line[0] === 'c') record.command = line.slice(1);
      else if (record && line[0] === 'n') record.names.push(line.slice(1));
    }
    const owner = records.find(r => r.command === 'ChatGPT' && r.names.includes(socketPath));
    if (!owner) throw Error('未找到官方桌面会话接口的进程');
    const image = (await exec('/bin/ps', ['-p', String(owner.pid), '-o', 'comm='], { timeout: 5000 })).stdout.trim();
    if (!image.endsWith('/ChatGPT.app/Contents/MacOS/ChatGPT')) throw Error('官方桌面路径未确认');
    const app = image.slice(0, -'/Contents/MacOS/ChatGPT'.length);
    const asarPath = path.join(app, 'Contents', 'Resources', 'app.asar');
    const startedAt = (await exec('/bin/ps', ['-p', String(owner.pid), '-o', 'lstart='], { timeout: 5000 })).stdout.trim();
    const fileIdentity = async () => Promise.all([image, asarPath].map(async file => {
      const f = await fs.stat(file); return [f.dev, f.ino, f.size, f.mtimeMs, f.ctimeMs];
    }));
    const files = await fileIdentity();
    // A new gateway connection performs one complete bundle verification.
    // Its handshake still checks process/socket/file identity before and after;
    // repeating the full resource scan three times adds seconds on this Mac.
    if (verifySignature) {
      await exec('/usr/bin/codesign', ['--verify', '--strict', app], { timeout: 20000 });
      const signature = await exec('/usr/bin/codesign', ['-dv', '--verbose=2', app], { timeout: 10000 });
      if (!signature.stderr.includes('Identifier=com.openai.codex') || !signature.stderr.includes('TeamIdentifier=2DC432GLL2'))
        throw Error('官方桌面签名未确认');
      if (JSON.stringify(files) !== JSON.stringify(await fileIdentity())) throw Error('官方桌面在验签期间发生变化');
    }
    const plist = await exec('/usr/bin/plutil', ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', path.join(app, 'Contents', 'Info.plist')]);
    return { platform, pid: owner.pid, image, socketPath, asarPath,
      home, version: plist.stdout.trim(), fingerprint: hash([owner.pid, startedAt, image, st.ino, st.uid, files]) };
  }
  if (platform === 'win32') {
    const python = process.env.MOBILE_CONTROL_PYTHON ?? 'D:\\python\\python.exe';
    const script = new URL('../src/win_probe.py', import.meta.url);
    const { fileURLToPath } = await import('node:url');
    const { stdout } = await exec(python, [fileURLToPath(script), '\\\\.\\pipe\\codex-ipc'],
      { windowsHide: true, timeout: 20000, maxBuffer: 1024 * 1024 });
    const p = JSON.parse(stdout).pipes?.find(v => v.pid && /\\WindowsApps\\OpenAI\.Codex_[^\\]+\\app\\ChatGPT\.exe$/i.test(v.image ?? ''));
    if (!p) throw Error('未确认运行中的官方 Windows 会话接口');
    return { platform, pid: p.pid, image: p.image, socketPath: p.path,
      asarPath: path.join(path.dirname(p.image), 'resources', 'app.asar'), home,
      version: /OpenAI\.Codex_([^_]+)_/.exec(p.image)?.[1] ?? null,
      fingerprint: hash([p.pid, p.image, p.path]) };
  }
  throw Error('本工具当前只接入 Mac 和 Windows 官方桌面');
}
