// Authorize message-backed visual fragments without giving the phone a filesystem browser.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { codexHome } from './discovery.mjs';

const threadPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const handlePattern = /^[a-f0-9]{64}$/;
const hash = value => createHash('sha256').update(value).digest('hex');
const identity = stat => [stat.dev,stat.ino,stat.size,stat.mtimeNs,stat.ctimeNs].join(':');
const error = code => Object.assign(Error('内嵌内容暂时无法读取'),{code});
const escapeHTML = text => String(text).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const sandbox = 'allow-scripts allow-popups allow-popups-to-escape-sandbox';

// The wrapper supplies only the host primitives used by static visualizations.
// Original scripts never receive the response nonce and cannot run in this viewer.
const styles = `
:root{color-scheme:light dark;--font-size-base:14px;--background:light-dark(#fff,#191919);--foreground:light-dark(#202020,#eee);--muted-foreground:light-dark(#656565,#aaa);--border:light-dark(#e4e4e4,#454545);--primary:light-dark(#ececec,#414141);--primary-foreground:var(--foreground);--muted:light-dark(#f4f4f4,#292929);--card:var(--background);--card-foreground:var(--foreground);--accent:var(--muted);--accent-foreground:var(--foreground);--ring:light-dark(#5b7c9d,#90b4d8)}
*{box-sizing:border-box}body{margin:0;padding:8px;color:var(--foreground);background:var(--background);font:400 var(--font-size-base)/1.5 system-ui,sans-serif;overflow-wrap:anywhere}h1,h2,h3,p{margin:0}h1{font-size:1.35em}h2{font-size:1.15em}h3{font-size:1em}h1,h2,h3,strong{font-weight:500}button,input,select,textarea{font:inherit}button,a,summary{touch-action:manipulation}a{color:light-dark(#225c91,#9bc6ee)}button:focus-visible,a:focus-visible,summary:focus-visible{outline:2px solid var(--ring);outline-offset:2px}.nav{display:flex;flex-wrap:wrap;gap:4px}.nav-link,.btn{display:inline-flex;justify-content:center;align-items:center;min-height:44px;padding:8px 12px;border:0;border-radius:22px;color:var(--foreground);background:transparent;text-decoration:none}.nav-link.active,.btn-primary{background:var(--primary);color:var(--primary-foreground)}.nav-justified>*{flex:1}.text-small{font-size:.86em}.text-muted{color:var(--muted-foreground)}.text-destructive{color:light-dark(#a52b2b,#ffaaaa)}.viz-row,.viz-controls{display:flex;flex-wrap:wrap;gap:12px;align-items:center}.viz-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,200px),1fr));gap:12px}.card{padding:14px;border:1px solid var(--border);border-radius:12px;background:var(--card);color:var(--card-foreground)}.viz-badge{display:inline-block;padding:2px 8px;border-radius:12px;background:var(--muted)}.tabular-nums{font-variant-numeric:tabular-nums}[hidden]{display:none!important}img,svg,canvas,video{max-width:100%;height:auto}pre{white-space:pre-wrap;overflow-wrap:anywhere}.table{width:100%;border-collapse:collapse}.table th,.table td{padding:8px;text-align:left;border-bottom:1px solid var(--border)}.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%)}hr{border:0;border-top:1px solid var(--border)}
`;

export function visualizationDocument(fragment,ref,{failure=null}={}) {
  const nonce = randomBytes(24).toString('base64');
  const csp = `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; img-src data: blob:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'; sandbox ${sandbox}`;
  const warning = /<\s*script\b|<\s*(?:img|video|audio|source|link)\b[^>]*(?:src|href)\s*=\s*["']?https?:|\bon[a-z]+\s*=/i.test(fragment)
    ? '<p>手机只运行内置的分类切换；此内容的自定义脚本和外部资源不会加载。</p>' : '';
  const state = JSON.stringify({id:ref.id,key:ref.contentKey,status:failure?'error':'ready',...(failure?{message:failure}:{})});
  const runtime = `(()=>{'use strict';const state=${state};const send=value=>parent.postMessage({...value,id:state.id,key:state.key},'*');send({type:'cmc-visualization-state',status:state.status,message:state.message});const content=document.getElementById('cmc-view-content');let scheduled=false,last=0;const resize=()=>{if(scheduled)return;scheduled=true;requestAnimationFrame(()=>{scheduled=false;const height=Math.ceil(content.getBoundingClientRect().height)+16;if(height!==last){last=height;send({type:'cmc-visualization-height',height:Math.max(120,Math.min(40000,height))});}});};new ResizeObserver(resize).observe(content);resize();document.addEventListener('click',event=>{const tab=event.target.closest?.('[role=tab]');if(!tab)return;const group=tab.closest('[role=tablist]');if(!group||tab.disabled||tab.getAttribute('aria-disabled')==='true')return;for(const peer of group.querySelectorAll('[role=tab]')){const selected=peer===tab;peer.setAttribute('aria-selected',String(selected));peer.classList.toggle('active',selected);const id=peer.getAttribute('aria-controls');const panel=id?document.getElementById(id):null;if(panel?.getAttribute('role')==='tabpanel')panel.hidden=!selected;}resize();});document.addEventListener('keydown',event=>{if(!['ArrowLeft','ArrowRight'].includes(event.key)||event.target.getAttribute?.('role')!=='tab')return;const tabs=[...event.target.closest('[role=tablist]').querySelectorAll('[role=tab]')].filter(tab=>!tab.disabled);const index=tabs.indexOf(event.target);const next=tabs[(index+(event.key==='ArrowRight'?1:tabs.length-1))%tabs.length];if(next){event.preventDefault();next.focus();next.click();}});for(const link of document.querySelectorAll('a')){try{const url=new URL(link.getAttribute('href'));if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw Error();link.href=url.href;link.target='_blank';link.rel='noopener noreferrer';link.removeAttribute('ping');link.removeAttribute('download');}catch{link.removeAttribute('href');}}})();`;
  const body = failure ? '<p role="alert">'+escapeHTML(failure)+'</p>' : warning+fragment;
  return {bytes:Buffer.from('<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>'+escapeHTML(ref.name)+'</title><style>'+styles+'</style></head><body><div id="cmc-view-content" style="display:flow-root">'+body+'</div><script nonce="'+nonce+'">'+runtime+'</script></body></html>'),
    headers:{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Content-Security-Policy':csp}};
}

export class MobileVisualizations {
  constructor({root=path.join(codexHome(),'visualizations'),platform=process.platform,openFile=(...args)=>fs.open(...args),readTimeoutMs=8000,maxReads=2}={}) {
    this.paths=platform==='win32'?path.win32:path.posix;this.root=this.paths.resolve(root);
    this.references=new Map();this.inflight=new Map();this.closed=false;this.activeReads=0;
    this.openFile=openFile;this.readTimeoutMs=readTimeoutMs;this.maxReads=Math.max(1,Math.min(2,maxReads));
  }
  allowedPath(threadId,file,root=this.root) {
    if(!threadPattern.test(threadId??'')||typeof file!=='string'||file.length>4096||!this.paths.isAbsolute(file)||/[\0\r\n]/.test(file))return null;
    const resolved=this.paths.resolve(file),parts=this.paths.relative(root,resolved).split(this.paths.sep);
    if(parts.length!==5||!/^\d{4}$/.test(parts[0])||!/^\d{2}$/.test(parts[1])||!/^\d{2}$/.test(parts[2])||
      parts[3].toLowerCase()!==threadId.toLowerCase()||! /^[a-z0-9][a-z0-9._-]{0,159}\.html$/i.test(parts[4]))return null;
    return resolved;
  }
  decorateItem(threadId,item) {
    const original=typeof item.text==='string'?item.text:'';
    if(item.type!=='agentMessage'||item.phase==='analysis'||item.channel==='analysis'||item.delivery==='async'||!original.includes('\uE200visualize\uE202'))return {text:original,visualizations:[]};
    const refs=[];
    const text=original.replace(/\uE200visualize\uE202([^\uE201]{1,8192})\uE201/g,(_,raw)=>{
      let value;try{value=JSON.parse(raw);}catch{return '[内嵌内容引用无效]';}
      const file=this.allowedPath(threadId,value?.path);
      if(!file||refs.length>=8)return '[内嵌内容暂不可用，请在电脑端查看]';
      const id=hash(threadId.toLowerCase()+':'+file),key=threadId.toLowerCase()+':'+id;
      let entry=this.references.get(key);
      if(!entry){const ref={id,contentKey:randomBytes(32).toString('hex'),name:String(value.title||'内嵌内容').replace(/[\0\r\n]/g,'').slice(0,120)};entry={threadId:threadId.toLowerCase(),file,ref};}
      this.references.delete(key);this.references.set(key,entry);while(this.references.size>4096)this.references.delete(this.references.keys().next().value);
      if(!refs.some(ref=>ref.id===id))refs.push({...entry.ref});
      // Old phone tabs may not understand the new structured field yet. Keep
      // a readable recovery hint instead of silently hiding artifact-only replies.
      return '内嵌内容请点“查看”。若没有查看按钮，请重新加载网页。';
    });
    return {text:text.trim(),visualizations:refs};
  }
  registered(threadId,id,key) {
    if(!threadPattern.test(threadId??'')||!handlePattern.test(id??'')||!handlePattern.test(key??''))throw error('VISUALIZATION_INVALID');
    const entry=this.references.get(threadId.toLowerCase()+':'+id);
    if(!entry||entry.ref.contentKey!==key)throw error('VISUALIZATION_NOT_FOUND');
    return entry;
  }
  async read(threadId,id,key) {
    const entry=this.registered(threadId,id,key);
    if(this.closed)throw error('VISUALIZATION_CLOSED');
    const cacheKey=entry.threadId+':'+id+':'+key,existing=this.inflight.get(cacheKey);
    if(existing)return existing.promise;
    if(this.activeReads>=this.maxReads)throw error('VISUALIZATION_BUSY');
    const record={expired:false};this.activeReads++;
    let timer,rejectDeadline;
    const deadline=new Promise((_,reject)=>{rejectDeadline=reject;});
    record.cancel=()=>{record.expired=true;rejectDeadline(error('VISUALIZATION_CLOSED'));};
    timer=setTimeout(()=>{record.expired=true;rejectDeadline(error('VISUALIZATION_TIMEOUT'));},this.readTimeoutMs);
    const work=this.readLocal(entry,record).finally(()=>{this.activeReads--;if(this.inflight.get(cacheKey)===record)this.inflight.delete(cacheKey);});
    record.promise=Promise.race([work,deadline]).finally(()=>clearTimeout(timer));this.inflight.set(cacheKey,record);
    return record.promise;
  }
  async readLocal(entry,record) {
    const check=()=>{if(this.closed||record.expired)throw error(this.closed?'VISUALIZATION_CLOSED':'VISUALIZATION_TIMEOUT');};
    let file;
    try{
      check();const root=await fs.realpath(this.root);check();const real=await fs.realpath(entry.file);check();
      if(!this.allowedPath(entry.threadId,real,root))throw error('VISUALIZATION_NOT_FOUND');
      const named=await fs.stat(real,{bigint:true});check();
      if(!named.isFile()||named.size>1000000n)throw error('VISUALIZATION_UNSUPPORTED');
      file=await this.openFile(real,'r');check();const before=await file.stat({bigint:true});check();
      if(!before.isFile()||identity(before)!==identity(named)||before.size>1000000n)throw error('VISUALIZATION_CHANGED');
      // A bounded positional read cannot grow with a concurrently appended file.
      const bytes=Buffer.alloc(Number(before.size));let offset=0;
      while(offset<bytes.length){const {bytesRead}=await file.read(bytes,offset,bytes.length-offset,offset);check();if(!bytesRead)break;offset+=bytesRead;}
      const after=await file.stat({bigint:true});check();
      if(offset!==bytes.length||identity(before)!==identity(after)||await fs.realpath(entry.file)!==real)throw error('VISUALIZATION_CHANGED');
      check();const fragment=new TextDecoder('utf-8',{fatal:true}).decode(bytes);
      // Navigation tags would replace the sandbox document before its trusted runtime can report status.
      if(/<\s*(?:meta|base)\b/i.test(fragment)||/<\s*(?:html|head|body)\b/i.test(fragment))throw error('VISUALIZATION_UNSUPPORTED');
      return visualizationDocument(fragment,entry.ref);
    }catch(cause){
      if(cause.code?.startsWith('VISUALIZATION_'))throw cause;
      throw error(['EACCES','EPERM'].includes(cause.code)?'VISUALIZATION_PERMISSION':['ENOENT','ENOTDIR'].includes(cause.code)?'VISUALIZATION_NOT_FOUND':'VISUALIZATION_UNSUPPORTED');
    }finally{if(file)await file.close().catch(()=>{});}
  }
  failure(entry,cause) {
    const code=cause?.code;
    const status=code==='VISUALIZATION_PERMISSION'?403:['VISUALIZATION_TIMEOUT','VISUALIZATION_BUSY'].includes(code)?504:404;
    const message=status===403?'电脑尚未允许读取此内嵌内容。':status===504?'内嵌内容读取超时或正在等待，请稍后重试。':code==='VISUALIZATION_UNSUPPORTED'?'此内嵌内容超出手机支持范围，请在电脑端查看。':'内嵌内容暂不可用，原文件可能已变化或缺失。';
    return {status,...visualizationDocument('',entry.ref,{failure:message})};
  }
  close(){this.closed=true;for(const record of this.inflight.values())record.cancel();this.references.clear();}
}
