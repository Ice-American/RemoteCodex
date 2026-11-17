import test from 'node:test';import assert from 'node:assert/strict';
import {createStateFrame,applyStateDelta} from '../mobile/public/thread-updates.mjs';
const state=()=>({host:'mac',id:'chat',connectionId:'1:owner',ownerId:'owner',connected:true,ownerConfirmed:true,revision:1,status:'idle',questions:[],approvals:[],capabilities:{send:true},messages:Array.from({length:100},(_,i)=>({id:'m'+i,role:'assistant',text:'x'.repeat(1000)}))});
test('a stream starts with an explicit snapshot and a new owner gets a new baseline',()=>{
 const initial=state();assert.deepEqual(createStateFrame(null,initial,1),{event:'snapshot',data:{sequence:1,state:initial}});
 const next={...initial,connectionId:'2:other',ownerId:'other'};assert.equal(createStateFrame(initial,next,2).event,'snapshot');
});
test('a token-sized visible change transmits only changed messages and reconstructs the exact state',()=>{
 const before=state(),next=structuredClone(before);next.revision++;next.messages[99].text+='new token';next.status='running';next.capabilities={send:false,steer:true};
 const frame=createStateFrame(before,next,2);assert.equal(frame.event,'delta');assert.equal(frame.data.messages.upsert.length,1);
 assert.deepEqual(applyStateDelta(before,frame.data,1),next);assert.equal(before.messages[99].text.length,1000);
 assert.ok(JSON.stringify(frame).length<JSON.stringify(next).length/10);
});
test('window removal, reordering and request/capability changes stay atomic',()=>{
 const before=state(),next=structuredClone(before);next.messages.shift();next.messages.reverse();next.messages.push({id:'new',role:'user',text:'new'});next.questions=[{id:'question'}];next.capabilities={send:false,answer:true};
 const frame=createStateFrame(before,next,2);assert.deepEqual(applyStateDelta(before,frame.data,1),next);
});
test('missed sequence, wrong chat and wrong owner cannot become current state',()=>{
 const before=state(),next=structuredClone(before);next.status='running';const frame=createStateFrame(before,next,2);
 for(const changed of [{base:0},{sequence:3},{id:'other'},{ownerId:'other'},{connectionId:'2:owner'}])assert.throws(()=>applyStateDelta(before,{...frame.data,...changed},1));
});
test('unsafe keys, invalid order and duplicate ids are rejected without mutating the base',()=>{
 const before=state(),next=structuredClone(before);next.status='running';const frame=createStateFrame(before,next,2);
 const unsafe=JSON.parse('{"__proto__":{"polluted":true}}');
 for(const changed of [{changes:unsafe},{unset:['id']},{messages:{...frame.data.messages,order:['missing']}},{messages:{...frame.data.messages,upsert:[{id:'m1'},{id:'m1'}]}}])assert.throws(()=>applyStateDelta(before,{...frame.data,...changed},1));
 assert.equal(before.status,'idle');assert.equal({}.polluted,undefined);
});
test('a bulk replacement or duplicate message identity uses a complete snapshot',()=>{
 const before=state(),next=structuredClone(before);next.messages=next.messages.map(m=>({...m,text:'z'.repeat(1000)}));assert.equal(createStateFrame(before,next,2).event,'snapshot');
 next.messages=[{id:'repeat'},{id:'repeat'}];assert.equal(createStateFrame(before,next,2).event,'snapshot');
});

import {createMobileAPI} from '../mobile/public/render.mjs';
test('the EventSource adapter applies snapshot and delta and retires a broken base without exposing a partial state',()=>{
 let events;class Events{constructor(url){this.url=url;this.handlers=new Map();events=this;}addEventListener(name,handler){this.handlers.set(name,handler);}close(){this.closed=true;}emit(name,data){this.handlers.get(name)?.({data:JSON.stringify(data)});}}
 const api=createMobileAPI({EventSourceImpl:Events}),states=[],statuses=[];const close=api.subscribe('mac','chat',{onState:s=>states.push(s),onStatus:s=>statuses.push(s)});
 assert.match(events.url,/delta=1/);const before=state(),next=structuredClone(before);next.status='running';
 events.emit('snapshot',{sequence:1,state:before});events.emit('delta',createStateFrame(before,next,2).data);assert.deepEqual(states,[before,next]);
 const bad={...createStateFrame(next,{...next,status:'idle'},3).data,base:0};events.emit('delta',bad);assert.equal(states.length,2);assert.deepEqual(statuses,['disconnected']);
 close();events.emit('snapshot',{sequence:1,state:before});assert.equal(states.length,2);assert.equal(events.closed,true);
});
test('the EventSource adapter can read an older server that only emits complete state events',()=>{
 let events;class Events{constructor(){events=this;this.handlers=new Map();}addEventListener(name,handler){this.handlers.set(name,handler);}close(){}}
 const api=createMobileAPI({EventSourceImpl:Events}),states=[];api.subscribe('mac','chat',{onState:s=>states.push(s),onStatus:()=>{}});events.handlers.get('state')({data:JSON.stringify(state())});assert.equal(states.length,1);
});
