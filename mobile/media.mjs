// Projects only message-backed images into opaque, thread-scoped handles.
// The HTTP layer must authenticate first; callers never supply filesystem paths.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { MessageMedia, imageType } from '../src/message-media.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const threadIdPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const handlePattern = /^[a-f0-9]{64}$/;
const MAX_GIF = 64 * 1024 * 1024, MAX_IMAGE = 25 * 1024 * 1024;
const sizeLimit = type => type === 'image/gif' ? MAX_GIF : MAX_IMAGE;
const mediaError = (message,code) => Object.assign(Error(message),{code});
const identity = stat => [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
const safeName = value => String(value || '图片').replace(/[\r\n\0]/g, '').slice(0, 240) || '图片';
const textTypes = new Set(['text', 'inputText', 'input_text', 'output_text']);
const urlValue = value => typeof value === 'string' ? value : typeof value?.url === 'string' ? value.url : null;
const contents = item => Array.isArray(item?.content) ? item.content : Array.isArray(item?.input) ? item.input : [];

export function nativeImageContent(content) {
  return content?.type === 'image' && typeof content.data === 'string' && typeof content.mimeType === 'string';
}
export function itemImageSource(content) {
  if (!content || typeof content !== 'object') return null;
  if (content.type === 'localImage') return typeof content.path === 'string' ? content.path : null;
  if (nativeImageContent(content)) {
    // MCP ImageContent has raw base64 and a MIME declaration, not a URL. Do
    // not search arbitrary result fields or decode bytes during message reads.
    const {data,mimeType} = content;
    if (!['image/png','image/jpeg','image/webp','image/gif'].includes(mimeType) || !data.length ||
        data.length > 4 * Math.ceil(sizeLimit(mimeType) / 3) || data.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) return null;
    return 'data:' + mimeType + ';base64,' + data;
  }
  if (['image', 'Image', 'inputImage', 'input_image', 'output_image'].includes(content.type))
    return urlValue(content.url) ?? urlValue(content.image_url) ?? urlValue(content.imageUrl);
  return null;
}
export function itemVisibleText(item) {
  return typeof item?.text === 'string' ? item.text : contents(item)
    .filter(content => textTypes.has(content?.type)).map(content => content.text ?? '').join('\n');
}
export function itemHasImages(item) {
  return contents(item).some(content => nativeImageContent(content) || !!itemImageSource(content)) ||
    item?.type === 'imageGeneration' && typeof (item.savedPath ?? item.result) === 'string' ||
    typeof itemVisibleText(item) === 'string' && /!\[[^\]]*\]\([^\n]+\)/.test(itemVisibleText(item)) ||
    /^\s*# Files (?:mentioned|pasted) by the user:/.test(itemVisibleText(item)) &&
      /^##\s+.+?:\s+(?:[A-Za-z]:[\\/]|\/)[^\r\n]+\.(?:png|jpe?g|webp|gif)\s*$/im.test(itemVisibleText(item));
}

export class MobileMedia {
  constructor({ platform = process.platform, openFile = (...args) => fs.promises.open(...args), readTimeoutMs = 8000, maxReads = 2 } = {}) {
    this.platform = platform;
    this.media = new MessageMedia();
    this.references = new Map();
    this.openFile = openFile; this.readTimeoutMs = readTimeoutMs;
    this.maxReads = Math.min(2,Math.max(1,Math.trunc(maxReads) || 2));
    this.activeReads = 0; this.inflight = new Map(); this.closed = false;
  }
  decorateItem(threadId, item) {
    if (!threadIdPattern.test(threadId ?? '')) throw Error('图片聊天标识无效');
    const text = itemVisibleText(item);
    const content = [{ type: 'text', text }, ...contents(item).flatMap(value => {
      let source = itemImageSource(value);
      if (!source) return [];
      // Keep the two supported path syntaxes distinct; never turn a Windows
      // path into a relative path on Mac or contact a network share.
      if (this.platform === 'win32' && /^\/[a-z]:[\\/]/i.test(source)) source = source.slice(1);
      return source.startsWith('data:') ? [{type:'image',url:source}] : [{type:'localImage',path:source}];
    })];
    const normalized = {...item, text, content};
    if (this.platform === 'win32' && typeof normalized.savedPath === 'string' && /^\/[a-z]:[\\/]/i.test(normalized.savedPath)) normalized.savedPath = normalized.savedPath.slice(1);
    // The upstream parser recognizes official user wrappers, local Markdown,
    // structured images and generated results. It registers references only;
    // image bytes are read later by the authenticated image request.
    const decorated = this.media.decorate(threadId, {turns:[{id:null,items:[normalized]}]}, {externalImages:true})
      .turns[0].items[0].bridgeDisplay;
    const candidates = [...(decorated.images ?? [])];
    // Official file citations and ordinary file links use the upstream file
    // registry. Promote only its exact, message-backed local image paths;
    // the original read authorization, pinned identity and size checks remain.
    for (const file of decorated.files ?? []) {
      const entry = this.media.attachments.get(threadId)?.get(file.id);
      if (!entry || !/\.(png|jpe?g|webp|gif)$/i.test(entry.file)) continue;
      const ref = this.media.add(threadId,entry.file,file.name,true,new Map(),JSON.stringify([null,item.id ?? null]));
      if (ref) candidates.push(ref);
    }
    // Upstream collects structured input images only for user messages. Newer
    // official assistant output can also contain output_image content blocks.
    if (item.type === 'agentMessage') for (const value of content) {
      const source = itemImageSource(value);
      if (!source) continue;
      const ref = this.media.add(threadId,source,undefined,true,new Map(),JSON.stringify([null,item.id ?? null]));
      if (ref) candidates.push(ref);
    }
    const images = [];
    for (const candidate of new Map(candidates.map(ref => [ref.id,ref])).values()) {
      if (!handlePattern.test(candidate.id ?? '')) continue;
      const entry = this.media.threads.get(threadId)?.get(candidate.id);
      let local = null;
      if (entry) {
        try {
          const real = fs.realpathSync(entry.file), stat = fs.statSync(real, {bigint:true});
          // A missing image retains its reference so the phone can explain the
          // failure. Its path is never included in the message or error.
          local = stat.isFile() ? {file:entry.file,real,identity:identity(stat)} : {file:entry.file};
        } catch { local = {file:entry.file}; }
      }
      const contentKey = candidate.contentKey ?? hash('inline:' + candidate.id);
      const ref = {id:candidate.id,contentKey,name:safeName(candidate.name)};
      const key = threadId + ':' + ref.id + ':' + contentKey;
      this.references.delete(key); this.references.set(key, {threadId,ref,local});
      while (this.references.size > 4096) this.references.delete(this.references.keys().next().value);
      images.push(ref);
    }
    return {text:typeof decorated.text === 'string' ? decorated.text : text,images};
  }
  async read(threadId, id, contentKey) {
    if (this.closed) throw mediaError('图片服务已关闭，请刷新后重试','MEDIA_CLOSED');
    if (!threadIdPattern.test(threadId ?? '') || !handlePattern.test(id ?? '') || !handlePattern.test(contentKey ?? '')) throw Error('图片引用无效');
    const key = threadId + ':' + id + ':' + contentKey;
    const registered = this.references.get(key);
    if (!registered) throw Error('图片未出现在已读取的此聊天中，请刷新聊天');
    if (!registered.local) return {...this.media.read(threadId,id),name:registered.ref.name};
    const existing = this.inflight.get(key);
    if (existing) return existing.promise;
    // macOS can hold an open while waiting for its Documents consent. Keep
    // its slot until that OS operation actually ends, even after HTTP timeout.
    // Repeated phone retries must not consume the remaining libuv threads.
    if (this.activeReads >= this.maxReads) throw mediaError('电脑正在等待图片读取权限，请稍后重试','MEDIA_BUSY');
    const record = {expired:false}; this.activeReads++;
    let timer, rejectDeadline;
    const deadline = new Promise((_,reject)=>{rejectDeadline=reject;});
    record.cancel = () => {record.expired=true;rejectDeadline(mediaError('图片服务已关闭，请刷新后重试','MEDIA_CLOSED'));};
    timer = setTimeout(()=>{record.expired=true;rejectDeadline(mediaError('电脑读取图片超时，请检查文稿访问权限后重试','MEDIA_TIMEOUT'));},this.readTimeoutMs);
    const work = Promise.resolve().then(()=>this.readLocal(registered,record)).finally(()=>{
      this.activeReads--; if(this.inflight.get(key)===record)this.inflight.delete(key);
    });
    record.promise = Promise.race([work,deadline]).finally(()=>clearTimeout(timer));
    this.inflight.set(key,record);
    return record.promise;
  }
  async readLocal({local,ref},record) {
    const check = () => {
      if (this.closed) throw mediaError('图片服务已关闭，请刷新后重试','MEDIA_CLOSED');
      if (record.expired) throw mediaError('电脑读取图片超时，请检查文稿访问权限后重试','MEDIA_TIMEOUT');
    };
    if (!local.real) throw Error('找不到原图，文件可能已移动或删除');
    let file;
    try {
      check(); const real = await fs.promises.realpath(local.file); check();
      if (real !== local.real) throw Error('原图已变化，请刷新聊天后重试');
      // Open asynchronously at the pinned canonical target. An OS consent
      // wait cannot block health checks. Any late handle closes in finally.
      file = await this.openFile(local.real,'r'); check();
      const before = await file.stat({bigint:true}); check();
      if (!before.isFile() || identity(before) !== local.identity) throw Error('原图已变化，请刷新聊天后重试');
      const header = Buffer.alloc(12); await file.read(header,0,header.length,0); check();
      const type = imageType(header);
      if (!type) throw Error('附件不是支持的图片格式');
      if (before.size > BigInt(sizeLimit(type))) throw Error('原图超过读取上限（GIF 64 MiB，其他图片 25 MiB）');
      const bytes = await file.readFile(); check();
      const after = await file.stat({bigint:true}); check();
      if (identity(after) !== local.identity || bytes.length !== Number(before.size)) throw Error('原图已变化，请刷新聊天后重试');
      return {bytes,type,name:ref.name};
    } catch (error) {
      if (error.code?.startsWith('MEDIA_')) throw error;
      if (['ENOENT','ENOTDIR'].includes(error.code)) throw Error('找不到原图，文件可能已移动或删除');
      if (['EACCES','EPERM'].includes(error.code)) throw mediaError('电脑没有读取原图的权限','MEDIA_PERMISSION');
      // Native filesystem errors include private paths. Return only a bounded
      // explanation at this boundary, even when an unexpected read fails.
      if (error.code) throw Error('暂时无法读取原图，请刷新聊天后重试');
      throw error;
    } finally { if (file) await file.close().catch(()=>{}); }
  }
  close() {
    this.closed = true;
    for (const record of this.inflight.values()) record.cancel();
    this.references.clear(); this.media = new MessageMedia();
  }
}
