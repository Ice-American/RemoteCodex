// Shared, opt-in wire updates for the phone. Every stream starts with a full
// snapshot; an invalid/missing base must cause a fresh read, never partial state.
const fields=new Set(['host','id','title','connected','connectionState','canLoad','ownerConfirmed','revision','connectionId','ownerId','activeTurnId','status','runtimeError','questions','approvals','capabilities','source','error']);
const own=(object,key)=>Object.prototype.hasOwnProperty.call(object,key);
const record=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const identity=(a,b)=>a?.host===b?.host&&a?.id===b?.id&&a?.connectionId===b?.connectionId&&a?.ownerId===b?.ownerId;
function messageMap(messages) {
 if(!Array.isArray(messages)||messages.length>1000)return null;
 const map=new Map();for(const message of messages){if(!record(message)||typeof message.id!=='string'||!message.id||message.id.length>512||map.has(message.id))return null;map.set(message.id,message);}return map;
}
const validSequence=value=>Number.isSafeInteger(value)&&value>0;
export function createStateFrame(previous,next,sequence) {
 if(!validSequence(sequence)||!record(next)||!Array.isArray(next.messages))throw Error('Invalid state snapshot');
 const snapshot={event:'snapshot',data:{sequence,state:next}};
 if(!previous||!identity(previous,next))return snapshot;
 const before=messageMap(previous.messages),after=messageMap(next.messages);if(!before||!after)return snapshot;
 const changes={},unset=[];
 for(const key of fields){if(own(next,key)){if(!same(previous[key],next[key]))changes[key]=next[key];}else if(own(previous,key))unset.push(key);}
 const upsert=[...after].filter(([id,message])=>!same(before.get(id),message)).map(([,message])=>message);
 const remove=[...before.keys()].filter(id=>!after.has(id));
 const delta={event:'delta',data:{sequence,base:sequence-1,host:next.host,id:next.id,connectionId:next.connectionId,ownerId:next.ownerId,changes,unset,messages:{upsert,remove,order:[...after.keys()]}}};
 // A large replacement is cheaper and safer as a new complete baseline.
 return JSON.stringify(delta).length<JSON.stringify(snapshot).length?delta:snapshot;
}
export function applyStateDelta(base,envelope,sequence) {
 if(!record(base)||!record(envelope)||!validSequence(sequence)||envelope.base!==sequence||envelope.sequence!==sequence+1||!identity(base,envelope))throw Error('增量消息基底已失效');
 if(!record(envelope.changes)||!Array.isArray(envelope.unset)||!record(envelope.messages))throw Error('增量消息格式无效');
 if(Object.keys(envelope.changes).some(key=>!fields.has(key))||envelope.unset.some(key=>!fields.has(key)||['host','id','connectionId','ownerId'].includes(key)))throw Error('增量消息字段无效');
 const {upsert,remove,order}=envelope.messages;
 const current=messageMap(base.messages),updates=messageMap(upsert);
 if(!current||!updates||!Array.isArray(remove)||!Array.isArray(order)||remove.length>1000||order.length>1000||new Set(order).size!==order.length||new Set(remove).size!==remove.length||remove.some(id=>typeof id!=='string'||!current.has(id)||updates.has(id)))throw Error('增量消息列表无效');
 for(const id of remove)current.delete(id);for(const [id,message] of updates)current.set(id,message);
 if(order.length!==current.size||order.some(id=>!current.has(id)))throw Error('增量消息顺序无效');
 const next={...base,...envelope.changes,messages:order.map(id=>current.get(id))};for(const key of envelope.unset)delete next[key];
 if(!identity(base,next))throw Error('增量消息连接已变更');
 return next;
}
