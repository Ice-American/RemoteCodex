import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MobileMedia } from '../mobile/media.mjs';
import { visibleItem, visibleTurns, parseVisibleHistory } from '../mobile/history.mjs';

const thread = '00000000-0000-4000-8000-000000000001';
const other = '00000000-0000-4000-8000-000000000002';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a4v8AAAAASUVORK5CYII=', 'base64');
const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7','base64');
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(),'codex-mobile-image-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const file = path.join(root,'one.png'); await fs.writeFile(file,png);
  return {root,file,media:new MobileMedia()};
}
const local = file => ({type:'userMessage',id:'photo',content:[{type:'localImage',path:file}]});

test('structured user images retain image-only messages without transferring paths or data',async t=>{
  const {file,media}=await fixture(t);
  const item=visibleItem(local(file),{media,threadId:thread});
  assert.equal(item.role,'user');assert.equal(item.text,'');assert.equal(item.images.length,1);
  const ref=item.images[0];assert.deepEqual(Object.keys(ref).sort(),['contentKey','id','name']);
  assert.equal(JSON.stringify(item).includes(file),false);assert.equal(JSON.stringify(item).includes('base64'),false);
  assert.deepEqual(await media.read(thread,ref.id,ref.contentKey),{bytes:png,type:'image/png',name:'one.png'});
});
test('data image aliases and generation return opaque handles and original image bytes',async t=>{
  const {media}=await fixture(t);const source='data:image/png;base64,'+png.toString('base64');
  for(const content of [{type:'image',url:source},{type:'input_image',image_url:source},{type:'input_image',image_url:{url:source}}]){
    const item=visibleItem({type:'userMessage',content:[content]},{media,threadId:thread});
    assert.equal(item.images.length,1);const ref=item.images[0];assert.deepEqual((await media.read(thread,ref.id,ref.contentKey)).bytes,png);
    assert.equal(JSON.stringify(item).includes(source),false);
  }
  const generated=visibleItem({type:'imageGeneration',id:'generated',result:png.toString('base64')},{media,threadId:thread});
  assert.equal(generated.role,'assistant');assert.equal(generated.images.length,1);
  const ref=generated.images[0];assert.deepEqual((await media.read(thread,ref.id,ref.contentKey)).bytes,png);
});
test('assistant local Markdown and user file wrappers share authenticated image references',async t=>{
  const {file,media}=await fixture(t);
  const assistant=visibleItem({type:'agentMessage',id:'answer',text:'图片如下\n\n![设计稿](<'+file+'>)'},{media,threadId:thread});
  assert.equal(assistant.text.trim(),'图片如下');assert.equal(assistant.images.length,1);assert.equal(assistant.images[0].name,'设计稿');
  const user=visibleItem({type:'userMessage',content:[{type:'text',text:'# Files mentioned by the user:\n\n## one.png: '+file+'\nImage attachment: true\n\n## My request:\n帮我看图'}]},{media,threadId:thread});
  assert.equal(user.text,'帮我看图');assert.equal(user.images.length,1);
  for(const message of [assistant,user]){const ref=message.images[0];assert.deepEqual((await media.read(thread,ref.id,ref.contentKey)).bytes,png);}
});
test('missing originals keep a usable opaque error target; unsupported image types never become executable markup',async t=>{
  const {root,media}=await fixture(t);const missing=path.join(root,'missing.png');
  const ref=visibleItem(local(missing),{media,threadId:thread}).images[0];assert.ok(ref);
  await assert.rejects(()=>media.read(thread,ref.id,ref.contentKey),e=>e.message.includes('找不到原图')&&!e.message.includes(root));
  for(const source of ['https://127.0.0.1/private.png','file:///etc/passwd','//server/share/photo.png','../auth.png','data:image/svg+xml;base64,PHN2Zz4=']){
    const message=visibleItem({type:'userMessage',content:[{type:'image',url:source}]},{media,threadId:thread});assert.deepEqual(message.images,[]);
  }
  const disguised=path.join(root,'not-image.png');await fs.writeFile(disguised,'<svg onload="alert(1)"></svg>');
  const denied=visibleItem(local(disguised),{media,threadId:thread}).images[0];await assert.rejects(()=>media.read(thread,denied.id,denied.contentKey),/不是支持的图片/);
});
test('image reads are isolated by exact thread, image id and content revision',async t=>{
  const {file,media}=await fixture(t);const ref=visibleItem(local(file),{media,threadId:thread}).images[0];
  await assert.rejects(()=>media.read(other,ref.id,ref.contentKey),/未出现在/);
  await assert.rejects(()=>media.read(thread,'a'.repeat(64),ref.contentKey),/未出现在/);
  await assert.rejects(()=>media.read(thread,ref.id,'b'.repeat(64)),/未出现在/);
  await assert.rejects(()=>media.read(thread,'../private',ref.contentKey),/引用无效/);
  media.close();await assert.rejects(()=>media.read(thread,ref.id,ref.contentKey),/已关闭/);
});
test('changed source content and symlink targets cannot reuse an earlier image URL',async t=>{
  const {root,file,media}=await fixture(t);const ref=visibleItem(local(file),{media,threadId:thread}).images[0];
  await fs.writeFile(file,Buffer.concat([png,Buffer.from('changed')]));
  await assert.rejects(()=>media.read(thread,ref.id,ref.contentKey),/原图已变化/);
  const current=visibleItem(local(file),{media,threadId:thread}).images[0];assert.notEqual(ref.contentKey,current.contentKey);
  if(process.platform==='win32')return;
  const second=path.join(root,'second.png'),link=path.join(root,'link.png');await fs.writeFile(second,png);await fs.symlink(file,link);
  const linked=visibleItem(local(link),{media,threadId:thread}).images[0];await fs.unlink(link);await fs.symlink(second,link);
  await assert.rejects(()=>media.read(thread,linked.id,linked.contentKey),/原图已变化/);
});
test('file size is checked before image bytes are read and GIF originals preserve animation',async t=>{
  const {root,media}=await fixture(t);const big=path.join(root,'big.png');let fd=await fs.open(big,'w');
  await fd.write(png);await fd.truncate(25*1024*1024+1);await fd.close();
  const oversized=visibleItem(local(big),{media,threadId:thread}).images[0];await assert.rejects(()=>media.read(thread,oversized.id,oversized.contentKey),/超过读取上限/);
  const animation=path.join(root,'animation.gif');await fs.writeFile(animation,gif);
  const ref=visibleItem(local(animation),{media,threadId:thread}).images[0];assert.deepEqual((await media.read(thread,ref.id,ref.contentKey)).bytes,gif);assert.equal((await media.read(thread,ref.id,ref.contentKey)).type,'image/gif');
});
test('same local image in different messages keeps every issued content revision usable',async t=>{
  const {file,media}=await fixture(t);const state={turns:[{items:[local(file),{...local(file),id:'second'}]}]};
  const messages=visibleTurns(state,100,{media,threadId:thread});assert.equal(messages.length,2);
  for(const item of messages){const ref=item.images[0];assert.deepEqual((await media.read(thread,ref.id,ref.contentKey)).bytes,png);}
});
test('historical response media enriches an event once, including image-only and response-only images',async t=>{
  const {media}=await fixture(t);const source='data:image/png;base64,'+png.toString('base64');
  const response=text=>({type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text},{type:'input_image',image_url:source}]}});
  const lines=[response('photo'),{type:'event_msg',payload:{type:'user_message',message:'photo'}},response(''),{type:'event_msg',payload:{type:'agent_message',message:'reply'}}];
  const messages=parseVisibleHistory(lines.map(JSON.stringify).join('\n'),80,{media,threadId:thread});
  assert.deepEqual(messages.map(m=>m.text),['photo','','reply']);assert.equal(messages[0].images.length,1);assert.equal(messages[1].images.length,1);
  assert.equal(JSON.stringify(messages).includes(source),false);
});

test('assistant structured output images use the same opaque media projection',async t=>{
  const {media}=await fixture(t);const source='data:image/png;base64,'+png.toString('base64');
  const message=visibleItem({type:'agentMessage',id:'structured-output',content:[{type:'output_image',image_url:source}]},{media,threadId:thread});
  assert.equal(message.images.length,1);const ref=message.images[0];assert.deepEqual((await media.read(thread,ref.id,ref.contentKey)).bytes,png);
});
test('history merges event and response images without repeating equal references',async t=>{
  const {media}=await fixture(t);const a='data:image/png;base64,'+png.toString('base64'),b='data:image/gif;base64,'+gif.toString('base64');
  const lines=[{type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:'both'},{type:'input_image',image_url:a}]}},{type:'event_msg',payload:{type:'user_message',message:'both',images:[a,b]}}];
  const messages=parseVisibleHistory(lines.map(JSON.stringify).join('\n'),80,{media,threadId:thread});
  assert.equal(messages.length,1);assert.equal(messages[0].images.length,2);
});
test('legacy repeated prompts pair in sequence across intervening non-message rows',async t=>{
  const {media}=await fixture(t);const a='data:image/png;base64,'+png.toString('base64'),b='data:image/gif;base64,'+gif.toString('base64');
  const response=image=>({type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:'same'},{type:'input_image',image_url:image}]}});
  const event={type:'event_msg',payload:{type:'user_message',message:'same'}};
  const lines=[response(a),...Array.from({length:10},()=>({type:'tool',payload:{}})),event,response(b),event];
  const messages=parseVisibleHistory(lines.map(JSON.stringify).join('\n'),80,{media,threadId:thread});
  assert.equal(messages.length,2);const first=messages[0].images[0],second=messages[1].images[0];
  assert.equal((await media.read(thread,first.id,first.contentKey)).type,'image/png');assert.equal((await media.read(thread,second.id,second.contentKey)).type,'image/gif');
});
test('unsupported structured media is explicitly marked instead of becoming a blank message',async t=>{
  const {media}=await fixture(t);const message=visibleItem({type:'userMessage',content:[{type:'image',url:'https://example.com/private.png'}]},{media,threadId:thread});
  assert.equal(message.imageUnavailable,true);assert.deepEqual(message.images,[]);assert.equal(JSON.stringify(message).includes('example.com'),false);
});

test('an image read deadline ends waiting without starting duplicate underlying opens',async t=>{
  const {file}=await fixture(t);let opens=0,release;
  const media=new MobileMedia({readTimeoutMs:20,openFile:async (...args)=>{opens++;await new Promise(resolve=>{release=resolve});return fs.open(...args);}});
  const ref=visibleItem(local(file),{media,threadId:thread}).images[0];
  const first=Promise.resolve(media.read(thread,ref.id,ref.contentKey));
  const second=Promise.resolve(media.read(thread,ref.id,ref.contentKey));
  await assert.rejects(first,error=>error.code==='MEDIA_TIMEOUT');
  await assert.rejects(second,error=>error.code==='MEDIA_TIMEOUT');
  assert.equal(opens,1);release?.();media.close();
});

test('timed-out underlying reads retain both slots and late handles close before any byte read',async t=>{
  const {file}=await fixture(t);const releases=[];let opens=0,closes=0,stats=0;
  const media=new MobileMedia({readTimeoutMs:25,maxReads:2,openFile:async (...args)=>{
    opens++;await new Promise(resolve=>releases.push(resolve));const handle=await fs.open(...args);
    return {stat:async (...values)=>{stats++;return handle.stat(...values);},close:async()=>{closes++;await handle.close();}};
  }});
  const refs=['one','two','three'].map(id=>visibleItem({...local(file),id},{media,threadId:thread}).images[0]);
  const first=media.read(thread,refs[0].id,refs[0].contentKey),second=media.read(thread,refs[1].id,refs[1].contentKey);
  const results=await Promise.allSettled([first,second]);assert.deepEqual(results.map(result=>result.reason?.code),['MEDIA_TIMEOUT','MEDIA_TIMEOUT']);
  assert.equal(opens,2);assert.equal(media.activeReads,2);
  await assert.rejects(()=>media.read(thread,refs[2].id,refs[2].contentKey),error=>error.code==='MEDIA_BUSY');
  await assert.rejects(()=>media.read(thread,refs[0].id,refs[0].contentKey),error=>error.code==='MEDIA_TIMEOUT');assert.equal(opens,2);
  for(const release of releases)release();
  for(let i=0;i<100&&media.activeReads;i++)await new Promise(resolve=>setTimeout(resolve,5));
  assert.equal(media.activeReads,0);assert.equal(closes,2);assert.equal(stats,0);media.close();
});
test('closing during a delayed open rejects immediately and closes the eventual handle',async t=>{
  const {file}=await fixture(t);let release,entered,closed=0;
  const started=new Promise(resolve=>{entered=resolve});
  const media=new MobileMedia({readTimeoutMs:1000,openFile:async (...args)=>{
    entered();await new Promise(resolve=>{release=resolve});const handle=await fs.open(...args);
    return {close:async()=>{closed++;await handle.close();}};
  }});
  const ref=visibleItem(local(file),{media,threadId:thread}).images[0];const pending=media.read(thread,ref.id,ref.contentKey);
  await started;media.close();await assert.rejects(pending,error=>error.code==='MEDIA_CLOSED');release();
  for(let i=0;i<100&&media.activeReads;i++)await new Promise(resolve=>setTimeout(resolve,5));
  assert.equal(media.activeReads,0);assert.equal(closed,1);
});

test('native MCP ImageContent data and mimeType projects from public assistant content',async t=>{
  const {media}=await fixture(t),data=png.toString('base64');
  const message=visibleItem({type:'agentMessage',id:'mcp-content',content:[{type:'image',data,mimeType:'image/png',_meta:{private:'hidden'}}]},{media,threadId:thread});
  assert.equal(message?.images?.length,1);const ref=message.images[0];assert.deepEqual((await media.read(thread,ref.id,ref.contentKey)).bytes,png);
  assert.equal(JSON.stringify(message).includes(data),false);assert.equal(JSON.stringify(message).includes('hidden'),false);
});
test('completed MCP tool images are public image-only messages without raw tool content',async t=>{
  const {media}=await fixture(t),data=png.toString('base64');
  const item={type:'mcpToolCall',id:'native-tool-picture',status:'completed',tool:'js',arguments:{secret:'private args'},text:'private body',result:{content:[{type:'text',text:'private tool text'},{type:'image',data,mimeType:'image/png',_meta:{secret:'private meta'}}],structuredContent:{secret:'private structure'}}};
  const message=visibleItem(item,{media,threadId:thread});assert.equal(message?.role,'assistant');assert.equal(message.text,'');assert.equal(message.images.length,1);
  const ref=message.images[0];assert.deepEqual((await media.read(thread,ref.id,ref.contentKey)).bytes,png);
  for(const secret of [data,'private args','private body','private tool text','private meta','private structure'])assert.equal(JSON.stringify(message).includes(secret),false);
  for(const changed of [{...item,status:'inProgress'},{...item,phase:'analysis'},{...item,result:{content:[{type:'text',text:data}],structuredContent:{type:'image',data,mimeType:'image/png'}}}])assert.equal(visibleItem(changed,{media,threadId:thread}),null);
});
test('official image file citations and ordinary image file links become visible images',async t=>{
  const {file,media}=await fixture(t);
  const messages=[
    visibleItem({type:'agentMessage',id:'citation-picture',text:':codex-file-citation{path="'+file+'"}'},{media,threadId:thread}),
    visibleItem({type:'agentMessage',id:'linked-picture',text:'[查看截图](<'+file+'>)'},{media,threadId:thread}),
  ];
  for(const message of messages){assert.equal(message.images?.length,1);const ref=message.images[0];assert.deepEqual((await media.read(thread,ref.id,ref.contentKey)).bytes,png);assert.equal(message.text.includes(file),false);}
});
test('ImageContent validates MIME and base64 shape without accepting SVG or arbitrary nested tool data',async t=>{
  const {media}=await fixture(t);
  for(const content of [{type:'image',data:'PHN2Zz4=',mimeType:'image/svg+xml'},{type:'image',data:'not base64',mimeType:'image/png'}]){
    const message=visibleItem({type:'agentMessage',content:[content]},{media,threadId:thread});assert.equal(message?.imageUnavailable,true);assert.deepEqual(message.images,[]);
  }
});

test('completed native imageView projects only its exact local image path through the guarded reader',async t=>{
  const {file,media}=await fixture(t);const item={type:'imageView',id:'view-picture',path:file,startedAtMs:1000,completedAtMs:2000};
  const message=visibleItem(item,{media,threadId:thread});assert.equal(message?.role,'assistant');assert.equal(message.text,'');assert.equal(message.images.length,1);
  const ref=message.images[0];assert.deepEqual((await media.read(thread,ref.id,ref.contentKey)).bytes,png);assert.equal(JSON.stringify(message).includes(file),false);
  for(const change of [{...item,completedAtMs:null},{...item,phase:'analysis'},{...item,channel:'analysis'}])assert.equal(visibleItem(change,{media,threadId:thread}),null);
});

test('confirmed rollout tool image formats merge only duplicate images from the same call',async t=>{
  const {media}=await fixture(t),data=png.toString('base64'),source='data:image/png;base64,'+data;
  const lines=[
    {type:'response_item',payload:{type:'function_call_output',call_id:'same-call',output:[{type:'input_image',image_url:source,detail:'original'},{type:'text',text:'private tool body'}]}},
    {type:'event_msg',payload:{type:'item_completed',item:{type:'McpToolCall',id:'same-call',status:'completed',arguments:{secret:'private arguments'},result:{content:[{type:'image',data,mimeType:'image/png',_meta:{secret:'private metadata'}}]}}}},
    {type:'response_item',payload:{type:'custom_tool_call_output',call_id:'different-call',output:[{type:'input_image',image_url:source}]}},
  ];
  const messages=parseVisibleHistory(lines.map(JSON.stringify).join('\n'),80,{media,threadId:thread});
  assert.equal(messages.length,2);assert.deepEqual(messages.map(message=>message.id),['same-call','different-call']);
  for(const message of messages){assert.equal(message.role,'assistant');assert.equal(message.text,'');assert.equal(message.images.length,1);const ref=message.images[0];assert.deepEqual((await media.read(thread,ref.id,ref.contentKey)).bytes,png);}
  for(const secret of [data,'private tool body','private arguments','private metadata'])assert.equal(JSON.stringify(messages).includes(secret),false);
});
test('rollout tool images do not expose text outputs or parse stringified or arbitrary nested payloads',async t=>{
  const {media}=await fixture(t),data=png.toString('base64'),source='data:image/png;base64,'+data;
  const lines=[
    {type:'response_item',payload:{type:'function_call_output',call_id:'text',output:[{type:'text',text:'private '+source}]}},
    {type:'response_item',payload:{type:'function_call_output',call_id:'string',output:JSON.stringify([{type:'input_image',image_url:source}])}},
    {type:'response_item',payload:{type:'custom_tool_call_output',call_id:'nested',output:{content:[{type:'input_image',image_url:source}]}}},
    {type:'event_msg',payload:{type:'item_completed',item:{type:'McpToolCall',id:'unfinished',status:'inProgress',result:{content:[{type:'image',data,mimeType:'image/png'}]}}}},
  ];
  assert.deepEqual(parseVisibleHistory(lines.map(JSON.stringify).join('\n'),80,{media,threadId:thread}),[]);
});
