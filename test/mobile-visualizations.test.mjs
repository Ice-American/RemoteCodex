import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MobileVisualizations } from '../mobile/visualizations.mjs';
import { MobileMedia } from '../mobile/media.mjs';
import { visibleItem } from '../mobile/history.mjs';

const id='01a1e32f-5746-7f91-997a-93c1ca1093c3',other='01a1e253-8d1a-74e2-ae85-591ba8dcb2fb';
const marker=(file,title='清单')=>'visualize'+JSON.stringify({path:file,title})+'';
async function fixture(t,options={}) {
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'cmc-visual-')),root=path.join(dir,'visualizations'),folder=path.join(root,'2026','11','17',id);
 await fs.mkdir(folder,{recursive:true});const file=path.join(folder,'checklist.html');
 const service=new MobileVisualizations({root,...options});
 t.after(async()=>{service.close();await fs.rm(dir,{recursive:true,force:true});});
 return {dir,root,folder,file,service,register:(text=marker(file))=>service.decorateItem(id,{type:'agentMessage',id:'message',text}).visualizations[0]};
}
test('only a public assistant marker under the exact chat directory grants a handle',async t=>{
 const {service,file,register}=await fixture(t);
 for(const item of [{type:'userMessage'},{type:'agentMessage',phase:'analysis'},{type:'agentMessage',delivery:'async'},{type:'mcpToolCall'}])
  assert.deepEqual(service.decorateItem(id,{...item,text:marker(file)}).visualizations,[]);
 for(const filePath of [path.join(os.tmpdir(),'private.html'),file.replace(id,other),file+'.json','https://example.com/file.html','\\\\server\\file.html']) {
  const value=service.decorateItem(id,{type:'agentMessage',text:marker(filePath)});
  assert.equal(value.visualizations.length,0);assert.ok(value.text.includes('暂不可用'));assert.ok(!value.text.includes(filePath));
 }
 const ref=register();assert.match(ref.id,/^[a-f0-9]{64}$/);assert.match(ref.contentKey,/^[a-f0-9]{64}$/);
 assert.deepEqual(register(),ref);assert.throws(()=>service.registered(other,ref.id,ref.contentKey));
 assert.throws(()=>service.registered(id,ref.id,'0'.repeat(64)));
});
test('live and saved visualization-only messages keep opaque refs without paths or HTML',async t=>{
 const {service,file}=await fixture(t),media=new MobileMedia({visualizations:service});t.after(()=>media.close());
 const projected=visibleItem({type:'agentMessage',id:'message',text:marker(file)},{media,threadId:id});
 assert.match(projected.text,/请重新加载网页/);assert.equal(projected.visualizations.length,1);
 assert.ok(!JSON.stringify(projected).includes(file));assert.ok(!JSON.stringify(projected).includes('path'));
 const plain='  ordinary text  ';
 assert.equal(visibleItem({type:'agentMessage',text:plain},{media,threadId:id}).text,plain);
});
test('a bounded real fragment gets a fresh nonce and opaque CSP on every response',async t=>{
 const {service,file,register}=await fixture(t);
 await fs.writeFile(file,'<div><a href="https://example.com/">来源</a><script>parent.exfiltrate()</script><details><summary>详情</summary>正文</details></div>');
 const ref=register(),a=await service.read(id,ref.id,ref.contentKey),b=await service.read(id,ref.id,ref.contentKey);
 const csp=a.headers['Content-Security-Policy'],html=a.bytes.toString();
 assert.match(csp,/script-src 'nonce-/);assert.match(csp,/connect-src 'none'/);assert.match(csp,/frame-src 'none'/);
 assert.match(csp,/sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox/);assert.ok(!csp.includes('allow-same-origin'));
 assert.notEqual(csp,b.headers['Content-Security-Policy']);assert.equal(a.headers['Cache-Control'],'no-store');
 assert.match(html,/<script nonce="[^"]+">/);assert.match(html,/<script>parent.exfiltrate\(\)<\/script>/);
 assert.match(html,/cmc-visualization-state/);assert.match(html,/ResizeObserver/);assert.match(html,/aria-controls/);
 assert.ok(!html.includes(file));
});
test('navigation tags, non-fragments, oversized content and changed files fail visibly',async t=>{
 const {service,file,register}=await fixture(t),ref=register();
 for(const body of ['<meta http-equiv="refresh" content="0;url=https://example.com">','<base href="https://example.com">','<html><body>document</body></html>','x'.repeat(1000001)]) {
  await fs.writeFile(file,body);
  await assert.rejects(service.read(id,ref.id,ref.contentKey),{code:'VISUALIZATION_UNSUPPORTED'});
 }
 const failure=service.failure(service.registered(id,ref.id,ref.contentKey),{code:'VISUALIZATION_PERMISSION'});
 assert.equal(failure.status,403);assert.match(failure.bytes.toString(),/status":"error"/);assert.match(failure.bytes.toString(),/role="alert"/);
 assert.equal(service.failure(service.registered(id,ref.id,ref.contentKey),{code:'VISUALIZATION_TIMEOUT'}).status,504);
});
test('a symlink cannot expose another directory or another chat',async t=>{
 const {dir,service,file,root,register}=await fixture(t),ref=register(),outside=path.join(dir,'private.html');
 await fs.writeFile(outside,'secret');await fs.symlink(outside,file);
 await assert.rejects(service.read(id,ref.id,ref.contentKey),{code:'VISUALIZATION_NOT_FOUND'});
 await fs.unlink(file);const foreign=path.join(root,'2026','11','17',other,'foreign.html');await fs.mkdir(path.dirname(foreign),{recursive:true});await fs.writeFile(foreign,'another chat');await fs.symlink(foreign,file);
 await assert.rejects(service.read(id,ref.id,ref.contentKey),{code:'VISUALIZATION_NOT_FOUND'});
});
test('timed-out opens retain the read budget and close their late handles',async t=>{
 let finish,closed=false;
 const pending=new Promise(resolve=>{finish=resolve;});
 const {service,file,folder,register}=await fixture(t,{readTimeoutMs:25,maxReads:1,openFile:()=>pending});
 await fs.writeFile(file,'<p>hello</p>');const ref=register(),secondFile=path.join(folder,'second.html');await fs.writeFile(secondFile,'<p>second</p>');const second=register(marker(secondFile));
 await assert.rejects(service.read(id,ref.id,ref.contentKey),{code:'VISUALIZATION_TIMEOUT'});
 assert.equal(service.activeReads,1);await assert.rejects(service.read(id,second.id,second.contentKey),{code:'VISUALIZATION_BUSY'});
 const handle=await fs.open(file,'r');finish({stat:(...args)=>handle.stat(...args),close:async()=>{closed=true;await handle.close();}});
 for(let n=0;n<20&&!closed;n++)await new Promise(resolve=>setTimeout(resolve,5));
 assert.equal(closed,true);assert.equal(service.activeReads,0);
});
