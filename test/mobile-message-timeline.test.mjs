import test from 'node:test';import assert from 'node:assert/strict';
import {messageTimeline} from '../mobile/public/message-timeline.mjs';
const m=(id,text=id)=>({id,role:'assistant',text}),ids=result=>result.rows.map(r=>r.message.id);
test('saved suffix cannot move the older live prefix below the latest messages',()=>{
 const live=Array.from({length:100},(_,i)=>m('m'+(i+1))),saved=live.slice(-40);
 assert.deepEqual(ids(messageTimeline(saved,live)),live.map(m=>m.id));
});
test('shared identities preserve both orders and live bodies win',()=>{
 const saved=[m('old'),m('a','saved a'),m('between'),m('b','saved b')],live=[m('a','live a'),m('native'),m('b','live b'),m('new')];
 const result=messageTimeline(saved,live);assert.deepEqual(ids(result),['old','a','between','native','b','new']);assert.equal(result.rows.find(r=>r.message.id==='a').message.text,'live a');assert.equal(result.rows.at(-1).message.id,'new');
});
test('distinct identities with the same text are never silently removed',()=>{
 const result=messageTimeline([m('anchor'),m('saved-copy','same'),m('end')],[m('anchor'),m('live-copy','same'),m('end')]);assert.deepEqual(ids(result),['anchor','saved-copy','live-copy','end']);
});
test('loaded old records survive a sliding live window and a later update',()=>{
 const saved=Array.from({length:80},(_,i)=>m('m'+i)),live=Array.from({length:100},(_,i)=>m('m'+(i+60)));
 assert.deepEqual(ids(messageTimeline(saved,live)),Array.from({length:160},(_,i)=>'m'+i));
 const next=[...live.slice(1),m('m160')];assert.deepEqual(ids(messageTimeline(saved,next)),Array.from({length:161},(_,i)=>'m'+i));
});
test('disjoint or contradictory records have an explicit source boundary',()=>{
 assert.deepEqual(messageTimeline([m('old')],[m('new')]),{rows:[{key:'["assistant","old"]',message:m('old'),source:'saved'},{key:'["assistant","new"]',message:m('new'),source:'live'}],separated:true,boundary:1,reason:'unanchored'});
 const result=messageTimeline([m('a'),m('saved-only'),m('b')],[m('b'),m('a')]);assert.deepEqual(ids(result),['saved-only','b','a']);assert.equal(result.reason,'conflict');assert.equal(result.separated,true);
});
test('source arrays remain immutable and missing IDs cannot collide across sources',()=>{
 const saved=[{role:'user',text:'same'}],live=[{role:'user',text:'same'}],copy=structuredClone({saved,live});const result=messageTimeline(saved,live);assert.equal(result.rows.length,2);assert.notEqual(result.rows[0].key,result.rows[1].key);assert.deepEqual({saved,live},copy);
});

test('a unique text-only saved copy between two anchors stays in its original slot as an expandable record',()=>{
 const h=[m('a'),{id:'saved-user',role:'user',text:'same'},m('b')],l=[m('a'),{id:'live-user',role:'user',text:'same'},m('b')];
 const result=messageTimeline(h,l);assert.deepEqual(ids(result),['a','saved-user','live-user','b']);assert.equal(result.rows[1].sameTextSaved,true);assert.equal(result.rows[2].sameTextSaved,undefined);
});
test('boundary gaps, repeated prompts, assistant text and images are never folded by text',()=>{
 const user=id=>({id,role:'user',text:'same'});
 for(const [h,l] of [
  [[user('h'),m('a')],[user('l'),m('a')]],
  [[m('a'),user('h')],[m('a'),user('l')]],
  [[m('a'),user('h1'),user('h2'),m('b')],[m('a'),user('l'),m('b')]],
  [[m('a'),m('h','same'),m('b')],[m('a'),m('l','same'),m('b')]],
  [[m('a'),{...user('h'),images:[{id:'image'}]},m('b')],[m('a'),user('l'),m('b')]]
 ])assert.equal(messageTimeline(h,l).rows.some(r=>r.sameTextSaved),false);
});
