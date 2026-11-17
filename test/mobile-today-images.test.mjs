import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {ThreadCatalog} from '../mobile/history.mjs';
import {MobileMedia} from '../mobile/media.mjs';
const id='00000000-0000-4000-8000-000000000001';
const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a4v8AAAAASUVORK5CYII=';
const image=(call,at)=>({timestamp:at,type:'response_item',payload:{type:'function_call_output',call_id:call,output:[{type:'input_image',image_url:'data:image/png;base64,'+png}]}});
async function fixture(t,rows){const home=await fs.mkdtemp(path.join(os.tmpdir(),'today-images-'));t.after(()=>fs.rm(home,{recursive:true,force:true}));const dir=path.join(home,'sessions');await fs.mkdir(dir);const file=path.join(dir,'rollout-'+id+'.jsonl');await fs.writeFile(file,rows.map(JSON.stringify).join('\n')+'\n');return{file,catalog:new ThreadCatalog(home,{now:()=>Date.parse('2026-11-17T12:00:00Z')}),media:new MobileMedia()};}
test('today gallery scans all saved rows across the Shanghai day rather than a latest-message limit',async t=>{
 const rows=[image('yesterday','2026-11-16T15:59:59Z'),...Array.from({length:120},(_,i)=>image('today-'+i,'2026-11-16T16:00:00.000Z')),image('tomorrow','2026-11-17T16:00:00Z')];
 const {catalog,media}=await fixture(t,rows);const result=await catalog.readTodayImages(id,{media,date:'2026-11-17'});
 assert.equal(result.complete,true);assert.deepEqual(result.issues,[]);assert.equal(result.images.length,120);assert.equal(result.images[0].messageId,'today-0');assert.equal(result.images.at(-1).messageId,'today-119');
 for(const picture of result.images){assert.equal(picture.at,Date.parse('2026-11-16T16:00:00Z'));assert.deepEqual(Object.keys(picture).sort(),['at','contentKey','id','messageId','name']);}
 assert.equal(JSON.stringify(result).includes(png),false);
});
test('today gallery refreshes append, keeps call scopes distinct and uses runtime Shanghai date by default',async t=>{
 const {file,catalog,media}=await fixture(t,[image('one','2026-11-17T08:00:00Z')]);
 assert.equal((await catalog.readTodayImages(id,{media})).images.length,1);
 await fs.appendFile(file,JSON.stringify(image('two','2026-11-17T08:01:00Z'))+'\n');
 const result=await catalog.readTodayImages(id,{media});assert.equal(result.date,'2026-11-17');assert.equal(result.images.length,2);assert.notEqual(result.images[0].messageId,result.images[1].messageId);
});
test('gallery timestamps are ordered even when a duplicate tool wrapper arrives after another call',async t=>{
 const {catalog,media}=await fixture(t,[image('one','2026-11-17T08:00:00Z'),image('two','2026-11-17T08:01:00Z'),image('one','2026-11-17T08:02:00Z')]);
 const result=await catalog.readTodayImages(id,{media});assert.equal(result.complete,true);
 assert.deepEqual(result.images.map(i=>i.messageId),['two','one']);
});

test('unchanged files use the signature cache and simultaneous requests share a single source scan',async t=>{
 const {file,catalog,media}=await fixture(t,[image('one','2026-11-17T08:00:00Z')]);let opens=0;
 catalog.todayImages.openFile=async(...args)=>{opens++;return fs.open(...args);};
 const results=await Promise.all([catalog.readTodayImages(id,{media}),catalog.readTodayImages(id,{media})]);assert.equal(opens,1);assert.equal(results[0].images.length,1);
 await catalog.readTodayImages(id,{media});assert.equal(opens,1);
 await fs.writeFile(file,JSON.stringify(image('replacement','2026-11-17T08:03:00Z'))+'\n');
 const replaced=await catalog.readTodayImages(id,{media});assert.equal(opens,2);assert.deepEqual(replaced.images.map(v=>v.messageId),['replacement']);
});
test('all today images remain listed when their rows are before more than two MiB of later tool output',async t=>{
 const rows=[image('early-picture','2026-11-17T08:00:00Z'),{timestamp:'2026-11-17T08:01:00Z',type:'response_item',payload:{type:'function_call_output',call_id:'private',output:'x'.repeat(2*1024*1024+100)}}];
 const {catalog,media}=await fixture(t,rows);const result=await catalog.readTodayImages(id,{media});assert.equal(result.complete,true);assert.equal(result.images.length,1);assert.equal(result.images[0].messageId,'early-picture');
});
test('gallery exposes only public pictures and deduplicates exact sources within a call',async t=>{
 const at='2026-11-17T08:00:00Z';const rows=[image('same',at),{timestamp:at,type:'event_msg',payload:{type:'item_completed',item:{type:'McpToolCall',id:'same',status:'completed',arguments:{secret:'private arguments'},result:{content:[{type:'text',text:'private body'},{type:'image',data:png,mimeType:'image/png',_meta:{private:'metadata'}}]}}}},image('another-call',at),{timestamp:at,type:'response_item',payload:{type:'message',role:'assistant',channel:'analysis',content:[{type:'input_image',image_url:'data:image/png;base64,'+png}]}},{timestamp:at,type:'response_item',payload:{type:'function_call_output',call_id:'string',output:JSON.stringify([{type:'input_image',image_url:'data:image/png;base64,'+png}])}}];
 const {catalog,media}=await fixture(t,rows);const result=await catalog.readTodayImages(id,{media});assert.equal(result.images.length,2);assert.equal(result.complete,true);
 for(const text of [png,'private arguments','private body','metadata'])assert.equal(JSON.stringify(result).includes(text),false);
});
test('a growing chat yields a verified complete saved prefix and the next read includes new images',async t=>{
 const {file,catalog,media}=await fixture(t,[image('one','2026-11-17T08:00:00Z')]);let changed=false;
 catalog.todayImages.openFile=async(...args)=>{const h=await fs.open(...args);return{stat:(...v)=>h.stat(...v),close:()=>h.close(),read:async(...v)=>{const r=await h.read(...v);if(!changed){changed=true;await fs.appendFile(file,JSON.stringify(image('two','2026-11-17T08:02:00Z'))+'\n');}return r;}};};
 const first=await catalog.readTodayImages(id,{media});assert.equal(first.complete,true);assert.equal(first.images.length,1);
 const next=await catalog.readTodayImages(id,{media});assert.equal(next.complete,true);assert.equal(next.images.length,2);
});
test('an append cannot hide a rewrite to the scanned image prefix',async t=>{
 const original=image('one','2026-11-17T08:00:00Z'),replacement=image('bad','2026-11-17T08:00:00Z');
 const {file,catalog,media}=await fixture(t,[original]);let changed=false;
 catalog.todayImages.openFile=async(...args)=>{const h=await fs.open(...args);return{stat:(...v)=>h.stat(...v),close:()=>h.close(),read:async(...v)=>{const r=await h.read(...v);if(!changed){changed=true;await fs.writeFile(file,[replacement,image('two','2026-11-17T08:02:00Z')].map(JSON.stringify).join('\n')+'\n');}return r;}};};
 const first=await catalog.readTodayImages(id,{media});assert.equal(first.complete,false);assert.ok(first.issues.includes('source_changed'));
 const next=await catalog.readTodayImages(id,{media});assert.equal(next.complete,true);assert.deepEqual(next.images.map(i=>i.messageId),['bad','two']);
});
test('scan timeout is bounded and closes a handle that arrives after the deadline',async t=>{
 const {catalog,media}=await fixture(t,[image('one','2026-11-17T08:00:00Z')]);let release,entered,closed=0;
 const started=new Promise(resolve=>{entered=resolve;});catalog.todayImages.scanTimeoutMs=20;
 catalog.todayImages.openFile=async(...args)=>{entered();await new Promise(resolve=>{release=resolve;});const h=await fs.open(...args);return{stat:(...v)=>h.stat(...v),close:async()=>{closed++;await h.close();}};};
 const pending=catalog.readTodayImages(id,{media});await started;const result=await pending;assert.equal(result.complete,false);assert.ok(result.issues.includes('scan_timeout'));assert.equal(catalog.todayImages.active,1);
 release();for(let i=0;i<100&&catalog.todayImages.active;i++)await new Promise(resolve=>setTimeout(resolve,5));assert.equal(closed,1);assert.equal(catalog.todayImages.active,0);
});
test('one cancelled caller cannot cancel another caller sharing a gallery scan',async t=>{
 const {catalog,media}=await fixture(t,[image('one','2026-11-17T08:00:00Z')]);let release,entered;
 const started=new Promise(resolve=>{entered=resolve;});catalog.todayImages.openFile=async(...args)=>{entered();await new Promise(resolve=>{release=resolve;});return fs.open(...args);};
 const controller=new AbortController();const first=catalog.readTodayImages(id,{media,signal:controller.signal}),second=catalog.readTodayImages(id,{media});await started;
 controller.abort(Error('cancel one'));await assert.rejects(first,/cancel one/);release();assert.equal((await second).complete,true);
});
test('oversized or malformed source rows are reported instead of silently claiming a complete day',async t=>{
 const {file,catalog,media}=await fixture(t,[image('one','2026-11-17T08:00:00Z'),{timestamp:'2026-11-17T08:01:00Z',type:'ignored',payload:{body:'x'.repeat(3000)}}]);catalog.todayImages.maxLineBytes=1024;
 await fs.appendFile(file,'{"unfinished":\n');const result=await catalog.readTodayImages(id,{media});assert.equal(result.images.length,1);assert.equal(result.complete,false);assert.ok(result.issues.includes('record_too_large'));assert.ok(result.issues.includes('invalid_record'));
});
test('unknown threads and invalid dates have explicit results without leaking source paths',async t=>{
 const {catalog,media}=await fixture(t,[]);const missing=await catalog.readTodayImages('00000000-0000-4000-8000-000000000002',{media});assert.equal(missing.complete,false);assert.deepEqual(missing.issues,['history_unavailable']);
 await assert.rejects(()=>catalog.readTodayImages(id,{media,date:'2026-02-30'}),/日期无效/);await assert.rejects(()=>catalog.readTodayImages('../private',{media}),/聊天标识/);
});

test('scan and retained-record budgets return explicit partial results and never cache overflow',async t=>{
 const {file,catalog,media}=await fixture(t,Array.from({length:8},(_,i)=>image('pic-'+i,'2026-11-17T08:00:00Z')));
 const reader=catalog.todayImages;reader.maxRecords=3;
 const count=await catalog.readTodayImages(id,{media});assert.equal(count.complete,false);assert.ok(count.issues.includes('record_budget'));assert.equal(count.images.length,3);assert.equal(reader.cache.size,0);
 reader.maxRecords=100;reader.maxDataBytes=800;
 const bytes=await catalog.readTodayImages(id,{media});assert.equal(bytes.complete,false);assert.ok(bytes.issues.includes('data_budget'));assert.equal(reader.cache.size,0);
 reader.maxDataBytes=100000;reader.maxScanBytes=100;
 const io=await catalog.readTodayImages(id,{media});assert.equal(io.complete,false);assert.ok(io.issues.includes('scan_budget'));assert.equal(reader.cache.size,0);
});
test('cache has a cumulative byte budget and refreshes a file evicted by another gallery',async t=>{
 const {file,catalog,media}=await fixture(t,[image('one','2026-11-17T08:00:00Z')]);const reader=catalog.todayImages;reader.maxCacheBytes=1800;let opens=0;
 reader.openFile=async(...args)=>{opens++;return fs.open(...args);};
 await reader.read(file,id,{media,date:'2026-11-17'});assert.equal(reader.cache.size,1);
 await reader.read(file,'00000000-0000-4000-8000-000000000002',{media,date:'2026-11-17'});assert.ok(reader.cacheBytes<=reader.maxCacheBytes);assert.equal(reader.cache.size,1);
 await reader.read(file,id,{media,date:'2026-11-17'});assert.equal(opens,3);
});
test('projection yields while retaining distant call and exact-text pairing semantics',async t=>{
 const at='2026-11-17T08:00:00Z';const paired={timestamp:at,type:'event_msg',payload:{type:'agent_message',message:'same message'}};
 const response={timestamp:at,type:'response_item',payload:{type:'message',role:'assistant',channel:'final',content:[{type:'output_text',text:'same message'},{type:'input_image',image_url:'data:image/png;base64,'+png}]}};
 const rows=[image('same-call',at),paired,...Array.from({length:90},(_,i)=>image('middle-'+i,at)),response,image('same-call',at)];
 const {catalog,media}=await fixture(t,rows);let heartbeats=0;const timer=setInterval(()=>{heartbeats++;},0);t.after(()=>clearInterval(timer));
 const result=await catalog.readTodayImages(id,{media});assert.equal(result.complete,true);assert.equal(result.images.length,92);assert.equal(result.images.filter(i=>i.messageId==='same-call').length,1);assert.ok(heartbeats>1);
});
test('cache-hit projection observes caller cancellation and deadline between bounded groups',async t=>{
 const {catalog,media}=await fixture(t,Array.from({length:15},(_,i)=>image('pic-'+i,'2026-11-17T08:00:00Z')));await catalog.readTodayImages(id,{media});
 const reader=catalog.todayImages,original=reader.project;reader.scanTimeoutMs=30;
 reader.project=(...args)=>{const end=performance.now()+5;while(performance.now()<end){}return original(...args);};
 const timeout=await catalog.readTodayImages(id,{media});assert.equal(timeout.complete,false);assert.ok(timeout.issues.includes('projection_timeout'));assert.ok(timeout.images.length<15);
 const controller=new AbortController();setTimeout(()=>controller.abort(Error('cancel projection')),10);
 await assert.rejects(()=>catalog.readTodayImages(id,{media,signal:controller.signal}),/cancel projection/);
});
test('an oversized single projection group is partial rather than one unbounded synchronous call',async t=>{
 const {catalog,media}=await fixture(t,[image('same','2026-11-17T08:00:00Z'),image('same','2026-11-17T08:01:00Z')]);catalog.todayImages.maxProjectionRecords=1;
 const result=await catalog.readTodayImages(id,{media});assert.equal(result.complete,false);assert.ok(result.issues.includes('projection_budget'));assert.equal(result.images.length,0);
});
test('many content items in one small row cannot bypass a projection group limit',async t=>{
 const row=image('many','2026-11-17T08:00:00Z');row.payload.output.push(...row.payload.output);
 const {catalog,media}=await fixture(t,[row]);catalog.todayImages.maxProjectionItems=1;
 const result=await catalog.readTodayImages(id,{media});assert.equal(result.complete,false);assert.ok(result.issues.includes('projection_budget'));assert.equal(result.images.length,0);
});
test('gallery output has an explicit image budget independent of source row size',async t=>{
 const {catalog,media}=await fixture(t,[image('one','2026-11-17T08:00:00Z'),image('two','2026-11-17T08:01:00Z')]);catalog.todayImages.maxImages=1;
 const result=await catalog.readTodayImages(id,{media});assert.equal(result.complete,false);assert.ok(result.issues.includes('image_budget'));assert.equal(result.images.length,1);
});
for(const [name,message] of [
 ['file citations',':codex-file-citation{path="/missing/one.png"} :codex-file-citation{path="/missing/two.png"}'],
 ['official user file wrappers','# Files mentioned by the user:\n## one: /missing/one.png\n## two: /missing/two.png']
])test('projection counts '+name+' before metadata probes',async t=>{
 const {catalog,media}=await fixture(t,[{timestamp:'2026-11-17T08:00:00Z',type:'event_msg',payload:{type:'user_message',message}}]);catalog.todayImages.maxProjectionItems=1;
 const result=await catalog.readTodayImages(id,{media});assert.equal(result.complete,false);assert.ok(result.issues.includes('projection_budget'));assert.equal(result.images.length,0);
});
test('the default day advances at Shanghai midnight and reads future saved pictures without an export',async t=>{
 const {catalog,media}=await fixture(t,[image('today','2026-11-17T15:59:59Z'),image('next-day','2026-11-17T16:00:00Z')]);
 catalog.now=()=>Date.parse('2026-11-17T15:59:59Z');const first=await catalog.readTodayImages(id,{media});assert.equal(first.date,'2026-11-17');assert.deepEqual(first.images.map(i=>i.messageId),['today']);
 catalog.now=()=>Date.parse('2026-11-17T16:00:01Z');const next=await catalog.readTodayImages(id,{media});assert.equal(next.date,'2026-11-18');assert.equal(next.complete,true);assert.deepEqual(next.images.map(i=>i.messageId),['next-day']);
});
