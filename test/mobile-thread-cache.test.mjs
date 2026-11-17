import test from 'node:test';import assert from 'node:assert/strict';
import {ThreadPreviewCache} from '../mobile/public/thread-cache.mjs';
const page=text=>({messages:[{id:'one',role:'assistant',text}],nextCursor:'next',hasMore:true,complete:true,issues:[]});
test('preview cache drops all live authority and private extras',()=>{
 const cache=new ThreadPreviewCache();cache.set('mac','one',{...page('saved'),ownerId:'owner',capabilities:{send:true},questions:[{id:'private'}],messages:[{id:'one',role:'assistant',text:'saved',arguments:'hidden',images:[{id:'a'.repeat(64),contentKey:'b'.repeat(64),name:'safe.png',path:'/private'}]}]});
 const result=cache.get('mac','one');assert.equal(result.messages[0].text,'saved');for(const secret of ['owner','send','private','hidden','capabilities','arguments','path'])assert.equal(JSON.stringify(result).includes(secret),false);
 assert.equal(cache.get('windows','one'),null);
});
test('preview cache expires, evicts by total bytes and caps scopes',()=>{
 let now=0;const cache=new ThreadPreviewCache({now:()=>now,maxScopes:2,maxBytes:650});
 cache.set('mac','a',page('a'));cache.set('mac','b',page('b'));cache.get('mac','a');cache.set('mac','c',page('c'));assert.equal(cache.get('mac','b'),null);assert.ok(cache.bytes<=650);assert.ok(cache.entries.size<=2);
 now=120000;assert.equal(cache.get('mac','a'),null);assert.equal(cache.get('mac','c'),null);assert.equal(cache.bytes,0);
 assert.equal(cache.set('mac','large',page('x'.repeat(1000))),false);assert.equal(cache.entries.size,0);
});
