import test from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs/promises';import path from 'node:path';import os from 'node:os';
import {ThreadCatalog,parseVisibleHistory} from '../mobile/history.mjs';
import {HistoryPagesReader} from '../mobile/history-pages.mjs';
import {MobileMedia} from '../mobile/media.mjs';
const id='00000000-0000-4000-8000-000000000001',other='00000000-0000-4000-8000-000000000002';
const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a4v8AAAAASUVORK5CYII=';
const event=(n,message='message '+n)=>({timestamp:'2026-11-17T08:00:'+String(n%60).padStart(2,'0')+'Z',type:'event_msg',payload:{type:'agent_message',message}});
const response=(n,text='message '+n)=>({timestamp:'2026-11-17T08:00:00Z',type:'response_item',payload:{type:'message',role:'assistant',channel:'final',id:'message-'+n,content:[{type:'output_text',text}]}});
async function fixture(t,rows,options={}){const home=await fs.mkdtemp(path.join(os.tmpdir(),'history-pages-'));t.after(()=>fs.rm(home,{force:true,recursive:true}));await fs.mkdir(path.join(home,'sessions'));const file=path.join(home,'sessions','rollout-'+id+'.jsonl'),text=rows.map(JSON.stringify).join('\n')+'\n';await fs.writeFile(file,text);return{file,text,catalog:new ThreadCatalog(home,{historyPages:options}),media:new MobileMedia()};}
test('body pages cover one projection without gaps, duplicates or the old 80/100 message cap',async t=>{
 const {catalog,media}=await fixture(t,Array.from({length:137},(_,i)=>response(i)));let cursor,all=[],pages=0;
 do{const result=await catalog.readPage(id,{limit:13,cursor,media});assert.equal(result.complete,true);assert.equal(result.source,'local-history');all.unshift(...result.messages);cursor=result.nextCursor;pages++;}while(cursor);
 assert.equal(pages,11);assert.equal(all.length,137);assert.deepEqual(all.map(m=>m.id),Array.from({length:137},(_,i)=>'message-'+i));
});
test('distant event/response and tool wrappers keep full-parser identity, order and duplicate rules across pages',async t=>{
 const rows=[event(0,'same text'),{type:'response_item',payload:{type:'function_call_output',call_id:'tool-call',output:[{type:'input_image',image_url:'data:image/png;base64,'+png}]}},response('orphan','response-only text'),...Array.from({length:40},(_,i)=>event(i+1)),{type:'response_item',payload:{type:'message',role:'assistant',channel:'final',id:'paired-response',content:[{type:'output_text',text:'same text'},{type:'input_image',image_url:'data:image/png;base64,'+png}]}},{type:'event_msg',payload:{type:'item_completed',item:{type:'McpToolCall',id:'tool-call',status:'completed',result:{content:[{type:'image',mimeType:'image/png',data:png}]}}}}];
 const {catalog,media,text}=await fixture(t,rows);const expected=parseVisibleHistory(text,Infinity,{media:new MobileMedia(),threadId:id});let cursor,all=[];
 do{const page=await catalog.readPage(id,{media,limit:5,cursor});assert.equal(page.complete,true);all.unshift(...page.messages);cursor=page.nextCursor;}while(cursor);
 assert.deepEqual(all,expected);assert.equal(all.filter(m=>m.id==='tool-call').length,1);assert.equal(all.some(m=>m.text==='response-only text'),false);assert.equal(all[0].images.length,1);
});
test('only returned messages register media, including when a pairing group spans multiple pages',async t=>{
 const rows=Array.from({length:20},(_,i)=>({...event(i,'repeated text'),payload:{type:'agent_message',message:'repeated text',images:['data:image/png;base64,'+png]}}));
 const {catalog}=await fixture(t,rows);const seen=[];const media={decorateItem(thread,item){seen.push(item.id);return{text:item.text??'',images:[]};}};
 const result=await catalog.readPage(id,{media,limit:3});assert.equal(result.messages.length,3);assert.equal(seen.length,3);assert.deepEqual(new Set(seen),new Set(result.messages.map(m=>m.id)));
});
test('append preserves an older cursor snapshot while a fresh first page includes the new message',async t=>{
 const {catalog,media,file}=await fixture(t,Array.from({length:15},(_,i)=>response(i)));
 const first=await catalog.readPage(id,{media,limit:5});await fs.appendFile(file,JSON.stringify(response(15))+'\n');
 const older=await catalog.readPage(id,{media,limit:5,cursor:first.nextCursor});assert.deepEqual(older.messages.map(m=>m.id),['message-5','message-6','message-7','message-8','message-9']);
 const fresh=await catalog.readPage(id,{media,limit:5});assert.deepEqual(fresh.messages.map(m=>m.id),['message-11','message-12','message-13','message-14','message-15']);
});
test('rewrite, rotate, expired and cross-chat cursors fail explicitly without returning a wrong page',async t=>{
 const {catalog,media,file}=await fixture(t,Array.from({length:10},(_,i)=>response(i)));const first=await catalog.readPage(id,{media,limit:3});
 await assert.rejects(()=>catalog.historyPages.read(file,other,{media,cursor:first.nextCursor}),e=>e.code==='HISTORY_CURSOR_INVALID');
 await fs.writeFile(file,Array.from({length:11},(_,i)=>JSON.stringify(response(i,'rewrite '+i))).join('\n')+'\n');
 await assert.rejects(()=>catalog.readPage(id,{media,cursor:first.nextCursor}),e=>e.code==='HISTORY_CURSOR_EXPIRED');
 const second=await catalog.readPage(id,{media,limit:3});await fs.rename(file,file+'.old');await fs.writeFile(file,JSON.stringify(response('rotated'))+'\n');
 await assert.rejects(()=>catalog.readPage(id,{media,cursor:second.nextCursor}),e=>e.code==='HISTORY_CURSOR_EXPIRED');
 const reader=new HistoryPagesReader({project:()=>[]});await assert.rejects(()=>reader.read(file,id,{cursor:first.nextCursor}),e=>e.code==='HISTORY_CURSOR_EXPIRED');
});
test('invalid input is rejected before source access',async()=>{
 let reads=0;const reader=new HistoryPagesReader({project:()=>[],statFile:()=>{reads++;}});
 for(const cursor of ['../private','e30','x'.repeat(3000)])await assert.rejects(()=>reader.read('/private',id,{cursor}),e=>e.code==='HISTORY_CURSOR_INVALID');
 await assert.rejects(()=>reader.read('/private',id,{limit:0}),e=>e.code==='HISTORY_PAGE_INVALID');assert.equal(reads,0);
});
test('scan IO, retained records, byte and group budgets are explicit incomplete results',async t=>{
 const {file,catalog,media}=await fixture(t,Array.from({length:20},(_,i)=>response(i)));const reader=catalog.historyPages;
 reader.maxScanBytes=100;const io=await catalog.readPage(id,{media});assert.equal(io.complete,false);assert.ok(io.issues.includes('scan_budget'));assert.equal(io.messages.length,0);
 reader.maxScanBytes=100000;reader.maxRecords=3;const records=await catalog.readPage(id,{media});assert.ok(records.issues.includes('record_budget'));assert.equal(records.complete,false);
 reader.maxRecords=100;reader.maxDataBytes=100;const bytes=await catalog.readPage(id,{media});assert.ok(bytes.issues.includes('data_budget'));
 reader.maxDataBytes=100000;reader.maxGroupRecords=1;await fs.writeFile(file,[response(0,'same'),response(1,'same')].map(JSON.stringify).join('\n')+'\n');const group=await catalog.readPage(id,{media});assert.equal(group.complete,false);assert.ok(group.issues.includes('projection_budget'));assert.equal(reader.active,0);
});
test('cache has a cumulative byte budget and evicted cursors expire',async t=>{
 const {file,catalog,media}=await fixture(t,Array.from({length:6},(_,i)=>response(i)));const reader=catalog.historyPages;
 const first=await catalog.readPage(id,{media,limit:2});const firstBytes=reader.cacheBytes;reader.maxCacheBytes=firstBytes+100;
 await reader.read(file,other,{media,limit:2});assert.ok(reader.cacheBytes<=reader.maxCacheBytes);assert.equal(reader.cache.size,1);
 await assert.rejects(()=>catalog.readPage(id,{media,cursor:first.nextCursor}),e=>e.code==='HISTORY_CURSOR_EXPIRED');
});
test('one cancelled caller does not cancel another sharing a source read',async t=>{
 const {catalog,media}=await fixture(t,[response(0)]);const reader=catalog.historyPages;let enter,release,opens=0;
 const entered=new Promise(r=>{enter=r;});reader.openFile=async(...args)=>{opens++;if(opens===1){enter();await new Promise(r=>{release=r;});}return fs.open(...args);};
 const controller=new AbortController(),first=catalog.readPage(id,{media,signal:controller.signal}),second=catalog.readPage(id,{media});await entered;controller.abort(Error('cancel caller'));
 await assert.rejects(first,/cancel caller/);release();assert.equal((await second).complete,true);assert.equal(opens,2);
});
test('a timed-out source keeps its slot until a late file handle is safely closed',async t=>{
 const {catalog,media}=await fixture(t,[response(0)]);const reader=catalog.historyPages;reader.timeoutMs=15;let release,enter,closed=0;
 const entered=new Promise(r=>{enter=r;});reader.openFile=async(...args)=>{enter();await new Promise(r=>{release=r;});const h=await fs.open(...args);return{stat:(...args)=>h.stat(...args),close:async()=>{closed++;await h.close();}};};
 const pending=catalog.readPage(id,{media});await entered;const result=await pending;assert.equal(result.complete,false);assert.ok(result.issues.includes('history_timeout'));assert.equal(reader.active,1);
 release();for(let i=0;i<100&&reader.active;i++)await new Promise(r=>setTimeout(r,2));assert.equal(reader.active,0);assert.equal(closed,1);
});
test('cache-hit page projection yields, observes cancellation, and includes its work in the deadline',async t=>{
 const {catalog,media}=await fixture(t,Array.from({length:30},(_,i)=>response(i)));await catalog.readPage(id,{media});const reader=catalog.historyPages,project=reader.project;
 reader.project=(...args)=>{const end=performance.now()+3;while(performance.now()<end){}return project(...args);};reader.timeoutMs=15;
 await assert.rejects(()=>catalog.readPage(id,{media,limit:20}),e=>e.code==='HISTORY_READ_TIMEOUT');
 reader.timeoutMs=100;const controller=new AbortController();setTimeout(()=>controller.abort(Error('cancel page projection')),7);
 await assert.rejects(()=>catalog.readPage(id,{media,signal:controller.signal}),/cancel page projection/);
});
test('source projection CPU work is included in the scan deadline',async t=>{
 const {catalog,media}=await fixture(t,Array.from({length:10},(_,i)=>response(i)));const reader=catalog.historyPages,project=reader.project;reader.timeoutMs=8;
 reader.project=(...args)=>{const end=performance.now()+3;while(performance.now()<end){}return project(...args);};
 const result=await catalog.readPage(id,{media});assert.equal(result.complete,false);assert.ok(result.issues.includes('history_timeout'));assert.equal(reader.cache.size,0);
});
test('public results strip source paths and inline bytes while hidden tool material is excluded',async t=>{
 const rows=[{type:'event_msg',payload:{type:'agent_message',message:'![preview](/missing/private.png)'}},{type:'response_item',payload:{type:'function_call_output',call_id:'picture',output:[{type:'input_image',image_url:'data:image/png;base64,'+png},{type:'text',text:'private tool body'}],arguments:{secret:'private arguments'}}},{type:'response_item',payload:{type:'message',role:'assistant',channel:'analysis',content:[{type:'output_text',text:'private analysis'}]}}];
 const {catalog,media}=await fixture(t,rows);const result=await catalog.readPage(id,{media});
 for(const value of ['/missing/',png,'private tool body','private arguments','private analysis'])assert.equal(JSON.stringify(result).includes(value),false);
 assert.equal(result.messages.length,2);
});
test('a timed-out older page is atomic and retrying the same cursor leaves no gap',async t=>{
 const {catalog,media}=await fixture(t,Array.from({length:40},(_,i)=>response(i)));const reader=catalog.historyPages;
 const first=await catalog.readPage(id,{media,limit:10}),project=reader.project;reader.timeoutMs=12;
 reader.project=(...args)=>{const end=performance.now()+4;while(performance.now()<end){}return project(...args);};
 await assert.rejects(()=>catalog.readPage(id,{media,limit:10,cursor:first.nextCursor}),e=>e.code==='HISTORY_READ_TIMEOUT');
 reader.project=project;reader.timeoutMs=10000;let cursor=first.nextCursor,all=[...first.messages];
 while(cursor){const page=await catalog.readPage(id,{media,limit:10,cursor});all.unshift(...page.messages);cursor=page.nextCursor;}
 assert.deepEqual(all.map(m=>m.id),Array.from({length:40},(_,i)=>'message-'+i));
});
test('eviction while a page yields cannot return success with an unusable continuation',async t=>{
 const {catalog,media,file}=await fixture(t,Array.from({length:12},(_,i)=>response(i)));const reader=catalog.historyPages,first=await catalog.readPage(id,{media,limit:4});
 reader.maxCacheBytes=reader.cacheBytes+100;const open=reader.openFile;let calls=0,enter,release;
 const entered=new Promise(r=>{enter=r;});reader.openFile=async(...args)=>{if(++calls===2){enter();await new Promise(r=>{release=r;});}return open(...args);};
 const pending=catalog.readPage(id,{media,limit:4,cursor:first.nextCursor});pending.catch(()=>{});await entered;
 await reader.read(file,other,{media,limit:4});release();
 await assert.rejects(pending,e=>e.code==='HISTORY_CURSOR_EXPIRED');
});
test('inline payloads do not fill the source cache and returned page bytes remain original',async t=>{
 const original=Buffer.concat([Buffer.from(png,'base64'),Buffer.alloc(200000)]),large=original.toString('base64');
 const rows=Array.from({length:10},(_,i)=>({type:'response_item',payload:{type:'function_call_output',call_id:'picture-'+i,output:[{type:'input_image',image_url:'data:image/png;base64,'+large}]}}));
 const {catalog,media}=await fixture(t,rows,{maxDataBytes:40000});const page=await catalog.readPage(id,{media,limit:2});assert.equal(page.complete,true);assert.equal(page.messages.length,2);assert.ok(catalog.historyPages.cacheBytes<40000);assert.equal(media.references.size,1);
 for(const message of page.messages){const ref=message.images[0],read=await media.read(id,ref.id,ref.contentKey);assert.deepEqual(read.bytes,original);}
});
test('a page IO budget reduces a contiguous oldest edge without skipping remaining messages',async t=>{
 const rows=Array.from({length:12},(_,i)=>({type:'response_item',payload:{type:'function_call_output',call_id:'picture-'+i,output:[{type:'input_image',image_url:'data:image/png;base64,'+png}]}}));
 const {catalog,media}=await fixture(t,rows,{maxPageBytes:850});let cursor,all=[],pages=0;
 do{const page=await catalog.readPage(id,{media,limit:8,cursor});assert.equal(page.complete,true);assert.ok(page.messages.length<8);all.unshift(...page.messages);cursor=page.nextCursor;pages++;}while(cursor);
 assert.ok(pages>2);assert.deepEqual(all.map(m=>m.id),Array.from({length:12},(_,i)=>'picture-'+i));
});
test('active append preserves a verified prefix and the next first page includes the new row',async t=>{
 const {catalog,media,file}=await fixture(t,[response(0),response(1)]);const reader=catalog.historyPages,open=reader.openFile;let modified=false;
 reader.openFile=async(...args)=>{const h=await open(...args);return{stat:(...a)=>h.stat(...a),close:()=>h.close(),read:async(...a)=>{const value=await h.read(...a);if(!modified){modified=true;await fs.appendFile(file,JSON.stringify(response(2))+'\n');}return value;}};};
 const first=await catalog.readPage(id,{media,limit:1});assert.equal(first.complete,true);assert.equal(first.messages[0].id,'message-1');
 const old=await catalog.readPage(id,{media,limit:1,cursor:first.nextCursor});assert.equal(old.messages[0].id,'message-0');
 const fresh=await catalog.readPage(id,{media,limit:1});assert.equal(fresh.messages[0].id,'message-2');
});
test('rewrite hidden by a concurrent append invalidates the initial source epoch',async t=>{
 const {catalog,media,file}=await fixture(t,[response(0),response(1)]);const reader=catalog.historyPages,open=reader.openFile;let modified=false;
 reader.openFile=async(...args)=>{const h=await open(...args);return{stat:(...a)=>h.stat(...a),close:()=>h.close(),read:async(...a)=>{const value=await h.read(...a);if(!modified){modified=true;await fs.writeFile(file,[response(0,'changed'),response(1),response(2)].map(JSON.stringify).join('\n')+'\n');}return value;}};};
 const result=await catalog.readPage(id,{media});assert.equal(result.complete,false);assert.deepEqual(result.issues,['source_changed']);assert.equal(result.messages.length,0);assert.equal(reader.cache.size,0);
});
