import test from 'node:test';
import assert from 'node:assert/strict';
import {readTodayGallery} from '../mobile/today-gallery.mjs';
const threadId='11111111-1111-4111-8111-111111111111';
test('today gallery returns only phone metadata without requiring a loaded owner',async()=>{
 const media={},controller=new AbortController(),calls=[];
 const result=await readTodayGallery({hostId:'mac',threadId,media,signal:controller.signal,catalog:{async readTodayImages(id,options){calls.push({id,options});return{date:'2026-11-17',complete:true,images:[{id:'a'.repeat(64),contentKey:'b'.repeat(64),name:'截图.png',messageId:'call-one',at:1794870000000,path:'/private/file.png',data:'private image body'}],issues:[],private:'not public'};}}});
 assert.equal(calls.length,1);assert.equal(calls[0].id,threadId);assert.equal(calls[0].options.media,media);assert.equal(calls[0].options.signal,controller.signal);
 assert.deepEqual(Object.keys(result).sort(),['complete','date','host','id','images','issues']);assert.equal(result.images.length,1);
 assert.equal(JSON.stringify(result).includes('/private/'),false);assert.equal(JSON.stringify(result).includes('private image body'),false);
});
test('today gallery rejects invalid chats before source access and does not disguise invalid references',async()=>{
 let reads=0;const catalog={async readTodayImages(){reads++;return{date:'2026-11-17',images:[{id:'../file',contentKey:'b'.repeat(64),messageId:'call',at:1}]};}};
 await assert.rejects(()=>readTodayGallery({hostId:'mac',threadId:'../file',catalog}),/聊天标识/);assert.equal(reads,0);
 await assert.rejects(()=>readTodayGallery({hostId:'mac',threadId,catalog}),/目录暂不可用/);assert.equal(reads,1);
});
test('response metadata is bounded and incomplete instead of silently truncating',async()=>{
 const image={id:'a'.repeat(64),contentKey:'b'.repeat(64),messageId:'call',at:1};
 const catalog={async readTodayImages(){return{date:'2026-11-17',complete:true,images:[image,image,image],issues:[]};}};
 const result=await readTodayGallery({hostId:'mac',threadId,catalog,maxImages:2});assert.equal(result.complete,false);assert.equal(result.images.length,2);assert.deepEqual(result.issues,['response_budget']);
});
test('metadata assembly observes cancellation without returning a partial success',async()=>{
 const controller=new AbortController(),image={id:'a'.repeat(64),contentKey:'b'.repeat(64),messageId:'call',at:1};
 const catalog={async readTodayImages(){setImmediate(()=>controller.abort(Error('cancel response')));return{date:'2026-11-17',complete:true,images:[image],issues:[]};}};
 await assert.rejects(()=>readTodayGallery({hostId:'mac',threadId,catalog,signal:controller.signal}),/cancel response/);
});
