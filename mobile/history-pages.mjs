// Pages one bounded public history projection. Cached records stay private and
// never establish a desktop owner; only a returned page registers image refs.
import fs from 'node:fs/promises';
import {createHash,randomBytes} from 'node:crypto';
import {setImmediate as yieldNow} from 'node:timers/promises';
import {itemImageSource,itemVisibleText,nativeImageContent} from './media.mjs';

const hash=value=>createHash('sha256').update(value).digest('hex');
const stamp=s=>[s.dev,s.ino,s.size,s.mtimeNs,s.ctimeNs].join(':');
const validId=id=>typeof id==='string'&&/^[a-f0-9]{8}-[a-f0-9-]{27}$/i.test(id);
const failure=(code,message)=>Object.assign(Error(message),{code});
const cancelled=signal=>signal?.reason??failure('ABORT_ERR','历史读取已取消');
const expired=()=>failure('HISTORY_CURSOR_EXPIRED','历史记录已变化，请重新读取最新内容。');
const invalid=()=>failure('HISTORY_CURSOR_INVALID','历史分页标识无效，请重新读取。');
const textTypes=new Set(['text','inputText','input_text','output_text']);
const compactImage=source=>source.startsWith('data:image/')?source.slice(0,source.indexOf(',')+1)+Buffer.from(hash(source)).toString('base64'):source;
const compactText=text=>text.replace(/data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+/g,compactImage);
function content(values,compact) {
  return(Array.isArray(values)?values:[]).flatMap(value=>{
    if(textTypes.has(value?.type))return[{type:'text',text:typeof value.text==='string'?(compact?compactText(value.text):value.text):''}];
    let source=itemImageSource(value);if(!source)return[];if(compact)source=compactImage(source);
    return[source.startsWith('data:')||/^https?:/i.test(source)?{type:'image',url:source}:{type:'localImage',path:source}];
  });
}
function publicRecord(row,lineId,order,compact=false) {
  const p=row?.payload;if(!p||p.phase==='analysis'||p.channel==='analysis')return null;
  let payload;
  if(row.type==='event_msg'&&['user_message','agent_message'].includes(p.type)&&typeof p.message==='string')
    payload={type:p.type,message:compact?compactText(p.message):p.message,phase:p.phase,channel:p.channel,
      images:content((Array.isArray(p.images)?p.images:[]).map(v=>typeof v==='string'?{type:'image',url:v}:v),compact),
      local_images:content((Array.isArray(p.local_images)?p.local_images:[]).map(v=>typeof v==='string'?{type:'localImage',path:v}:v),compact)};
  else if(row.type==='response_item'&&p.type==='message'&&['user','assistant'].includes(p.role))
    payload={type:p.type,id:p.id,role:p.role,phase:p.phase,channel:p.channel,content:content(p.content,compact)};
  else if(row.type==='response_item'&&['function_call_output','custom_tool_call_output'].includes(p.type)&&Array.isArray(p.output))
    payload={type:p.type,call_id:p.call_id,output:p.output.filter(c=>c?.type==='input_image'&&typeof c.image_url==='string').map(c=>({type:'input_image',image_url:compact?compactImage(c.image_url):c.image_url}))};
  else if(row.type==='event_msg'&&p.type==='item_completed'&&p.item?.type==='McpToolCall') {
    const item=p.item;if(item.status!=='completed'||item.error!=null||item.phase==='analysis'||item.channel==='analysis'||item.result?.isError===true)return null;
    payload={type:p.type,item:{type:'McpToolCall',id:item.id,status:'completed',result:{content:(Array.isArray(item.result?.content)?item.result.content:[]).filter(nativeImageContent).map(c=>({type:'image',data:compact?Buffer.from(hash('data:'+c.mimeType+';base64,'+c.data)).toString('base64'):c.data,mimeType:c.mimeType}))}}};
  }else return null;
  return{row:{type:row.type,payload},lineId,order};
}
function groupKey(record) {
  const p=record.row.payload;
  if(p.type==='item_completed')return'tool:'+p.item.id;
  if(['function_call_output','custom_tool_call_output'].includes(p.type))return'tool:'+p.call_id;
  const role=p.type==='user_message'||p.role==='user'?'user':'assistant';
  return role+':'+hash(p.message??(p.content??[]).filter(c=>textTypes.has(c.type)).map(c=>c.text??'').join('\n'));
}
function candidateItems(record,maximum) {
  const p=record.row.payload;let count=(p.output??p.item?.result?.content??p.content??[]).filter(c=>!textTypes.has(c?.type)).length+(p.images??[]).length+(p.local_images??[]).length;
  const text=p.message??(p.content??[]).map(c=>c.text??'').join('\n');
  for(const ignored of text.matchAll(/!\[|<file\b|\]\(|:codex-file-citation\{|^##[ \t]/gm))if(++count>maximum)break;
  return count;
}
async function wait(promise,signal) {
  if(!signal)return promise;let listener;
  try{return await Promise.race([promise,new Promise((_,reject)=>{listener=()=>reject(cancelled(signal));if(signal.aborted)listener();else signal.addEventListener('abort',listener,{once:true});})]);}
  finally{signal.removeEventListener('abort',listener);}
}

export class HistoryPagesReader {
  constructor({project,timeoutMs=10000,maxScanBytes=128*1024*1024,maxLineBytes=8*1024*1024,
    maxDataBytes=32*1024*1024,maxRecords=12000,maxCacheBytes=64*1024*1024,maxEntries=8,
    maxGroupBytes=24*1024*1024,maxGroupRecords=1024,maxGroupItems=64,maxPageBytes=32*1024*1024,maxScans=2,
    openFile=(...args)=>fs.open(...args),statFile=(...args)=>fs.stat(...args)}={}) {
    Object.assign(this,{project,timeoutMs,maxScanBytes,maxLineBytes,maxDataBytes,maxRecords,maxCacheBytes,maxEntries,maxGroupBytes,maxGroupRecords,maxGroupItems,maxPageBytes,openFile,statFile});
    this.maxScans=Math.min(2,Math.max(1,maxScans));this.active=0;this.projecting=0;this.readingPages=0;
    this.cache=new Map();this.latest=new Map();this.cacheBytes=0;this.inflight=new Map();
  }
  drop(epoch) {
    const entry=this.cache.get(epoch);if(!entry)return;
    this.cache.delete(epoch);this.cacheBytes-=entry.bytes;
    if(this.latest.get(entry.key)===epoch)this.latest.delete(entry.key);
  }
  store(entry) {
    if(entry.bytes>this.maxCacheBytes){entry.complete=false;entry.issues.push('cache_budget');return;}
    this.cache.set(entry.epoch,entry);this.latest.set(entry.key,entry.epoch);this.cacheBytes+=entry.bytes;
    while(this.cache.size>this.maxEntries||this.cacheBytes>this.maxCacheBytes)this.drop(this.cache.keys().next().value);
  }
  touch(entry){if(this.cache.has(entry.epoch)){this.cache.delete(entry.epoch);this.cache.set(entry.epoch,entry);}}
  check(record){
    if(record.controller.signal.aborted)throw cancelled(record.controller.signal);
    if(performance.now()>=record.deadline){record.timedOut=true;throw failure('HISTORY_READ_TIMEOUT','历史读取超时');}
  }
  decodeCursor(cursor,threadId) {
    try {
      if(typeof cursor!=='string'||cursor.length>2048||!/^[A-Za-z0-9_-]+$/.test(cursor))throw invalid();
      const value=JSON.parse(Buffer.from(cursor,'base64url').toString('utf8'));
      if(value.v!==1||value.t!==threadId||typeof value.e!=='string'||!/^[a-f0-9]{32}$/.test(value.e)||!Number.isSafeInteger(value.b)||value.b<1||typeof value.a!=='string'||value.a.length>512)throw invalid();
      return value;
    }catch{throw invalid();}
  }
  async read(file,threadId,{cursor,limit=40,media,signal}={}) {
    if(!validId(threadId))throw invalid();
    if(!Number.isInteger(limit)||limit<1||limit>100)throw failure('HISTORY_PAGE_INVALID','每页消息数量无效');
    const position=cursor?this.decodeCursor(cursor,threadId):null;
    if(signal?.aborted)throw cancelled(signal);
    const deadline=performance.now()+this.timeoutMs;
    const empty=issue=>({messages:[],nextCursor:null,hasMore:false,complete:false,issues:[issue],source:'local-history'});
    if(!file){if(position)throw expired();return empty('history_unavailable');}
    const key=threadId+':'+file;
    const old=position?this.cache.get(position.e):null;
    if(position&&(!old||old.key!==key))throw expired();
    const requestKey=position?key+':'+position.e:key;
    let record=this.inflight.get(requestKey);
    if(!record) {
      if(this.active+this.readingPages>=this.maxScans){if(position)throw failure('HISTORY_READ_BUSY','历史读取正在进行，请重试当前页。');return empty('history_busy');}
      record={controller:new AbortController(),consumers:0,settled:false,deadline};this.active++;
      let timer;
      const work=Promise.resolve().then(async()=>{
        if(!position)return this.load(file,threadId,key,record);
        try{if(!await this.validate(old,file,record.controller.signal,record.deadline))throw expired();}
        catch(error){if(error.code==='HISTORY_READ_TIMEOUT')return{failure:'history_timeout'};throw error;}
        return old;
      }).finally(()=>{record.settled=true;this.active--;clearTimeout(timer);if(this.inflight.get(requestKey)===record)this.inflight.delete(requestKey);});
      const timed=new Promise(resolve=>{timer=setTimeout(()=>{record.controller.abort();resolve({failure:'history_timeout'});},this.timeoutMs);});
      record.promise=Promise.race([work,timed]);this.inflight.set(requestKey,record);
    }
    record.consumers++;
    try {
      // Cursor pages retain their immutable source epoch. They do not rescan a
      // newer appended file or let it shift the older-page anchor.
      const entry=await wait(record.promise,signal);
      if(entry.failure){if(position)throw failure('HISTORY_READ_TIMEOUT','历史页暂时无法读取，请重试当前页。');return empty(entry.failure);}
      if(position&&(position.b>entry.index.length||entry.index[position.b]?.id!==position.a))throw invalid();
      this.touch(entry);
      return await this.page(entry,threadId,{position,limit,media,signal,deadline});
    }finally{record.consumers--;if(!record.consumers&&!record.settled)record.controller.abort();}
  }
  async load(file,threadId,key,record) {
    try {
      const stat=await this.statFile(file,{bigint:true});this.check(record);
      if(!stat.isFile())return{failure:'history_unavailable'};
      const previous=this.cache.get(this.latest.get(key));
      if(previous?.stamp===stamp(stat))return previous;
      const scanned=await this.scan(file,record,stat);this.check(record);
      if(scanned.failure)return scanned;
      const entry=await this.index(scanned,threadId,record);this.check(record);
      Object.assign(entry,{key,file,threadId,epoch:randomBytes(16).toString('hex')});this.store(entry);return entry;
    }catch{return{failure:record.timedOut?'history_timeout':record.controller.signal.aborted?'history_cancelled':'history_read_failed'};}
  }
  async scan(file,record,expected) {
    let handle,position=0,parts=[],length=0,lineSize=0,lineOffset=0,skipping=false,order=0,bytes=0;
    const records=[],issues=new Set(),sourceHash=createHash('sha256');
    let failureCode;
    const accept=(part,finished)=>{
      lineSize+=part.length;
      if(!skipping&&length+part.length>this.maxLineBytes){skipping=true;parts=[];issues.add('record_too_large');}
      if(!skipping){parts.push(part);length+=part.length;}
      if(!finished)return;
      if(!skipping&&length) {
        const line=Buffer.concat(parts,length).toString('utf8');let row;
        try{row=JSON.parse(line);}catch{issues.add('invalid_record');}
        const safe=row&&publicRecord(row,hash(line).slice(0,20),order++,true);
        if(safe){safe.offset=lineOffset;safe.length=lineSize;}
        if(safe){safe.bytes=Buffer.byteLength(JSON.stringify(safe),'utf8')*4+512;
          if(records.length>=this.maxRecords)failureCode='record_budget';
          else if(bytes+safe.bytes>this.maxDataBytes)failureCode='data_budget';
          else{bytes+=safe.bytes;records.push(safe);}}
      }
      lineOffset+=lineSize+1;parts=[];length=0;lineSize=0;skipping=false;
    };
    try {
      this.check(record);handle=await this.openFile(file,'r');this.check(record);
      const before=await handle.stat({bigint:true});this.check(record);
      if(!before.isFile()||stamp(before)!==stamp(expected))return{failure:'source_changed'};
      if(before.size>BigInt(this.maxScanBytes))return{failure:'scan_budget'};
      const size=Number(before.size),buffer=Buffer.alloc(64*1024);
      while(position<size&&!failureCode) {
        this.check(record);const {bytesRead}=await handle.read(buffer,0,Math.min(buffer.length,size-position),position);this.check(record);
        if(!bytesRead)break;sourceHash.update(buffer.subarray(0,bytesRead));position+=bytesRead;
        // Copy before the next read; line fragments may span chunks.
        const chunk=Buffer.from(buffer.subarray(0,bytesRead));let start=0,next;
        while(!failureCode&&(next=chunk.indexOf(10,start))!==-1){accept(chunk.subarray(start,next),true);start=next+1;}
        if(!failureCode&&start<chunk.length)accept(chunk.subarray(start),false);
        await yieldNow();
      }
      if(failureCode)return{failure:failureCode};
      if(length||skipping)accept(Buffer.alloc(0),true);
      if(failureCode)return{failure:failureCode};
      const after=await handle.stat({bigint:true});this.check(record);
      if(position!==size||before.dev!==after.dev||before.ino!==after.ino||after.size<before.size||after.size===before.size&&stamp(before)!==stamp(after))return{failure:'source_changed'};
      const prefixHash=sourceHash.digest('hex');
      if(after.size>before.size) {
        if(size*2>this.maxScanBytes)return{failure:'scan_budget'};
        if(!await this.hashPrefix(handle,size,record.controller.signal,prefixHash))return{failure:'source_changed'};
      }
      return{records,issues,bytes,size,dev:String(before.dev),ino:String(before.ino),stamp:stamp(before),prefixHash};
    }finally{if(handle)await handle.close().catch(()=>{});}
  }
  async index(data,threadId,record) {
    const groups=new Map(),index=[],issues=data.issues;
    const anyEvents=data.records.some(r=>['user_message','agent_message'].includes(r.row.payload.type));
    for(const row of data.records) {
      this.check(record);const key=groupKey(row);let group=groups.get(key);
      if(!group){group={records:[],bytes:0,sourceBytes:0,items:0,overflow:false};groups.set(key,group);}
      const items=candidateItems(row,this.maxGroupItems);
      if(group.bytes+row.bytes>this.maxGroupBytes||group.records.length>=this.maxGroupRecords||group.items+items>this.maxGroupItems){group.overflow=true;issues.add('projection_budget');}
      else{group.records.push(row);group.bytes+=row.bytes;group.sourceBytes+=row.length;group.items+=items;}
      await yieldNow();
    }
    for(const group of groups.values()) {
      await yieldNow();this.check(record);if(group.overflow)continue;
      const orders=new Map();
      for(const row of group.records) {
        for(const message of this.project([row],Infinity,{threadId}))if(!orders.has(message.id))orders.set(message.id,row.order);
      }
      const hasEvents=group.records.some(r=>['user_message','agent_message'].includes(r.row.payload.type));
      const messages=this.project(group.records,Infinity,{threadId});
      messages.forEach((message,localIndex)=>{
        // The full parser suppresses response-only text if any event rows exist
        // elsewhere. Its image-bearing orphans must still remain visible.
        if(anyEvents&&!hasEvents&&!('images'in message))return;
        index.push({id:message.id,group,localIndex,order:orders.get(message.id)??group.records[0].order});
      });
    }
    index.sort((a,b)=>a.order-b.order);
    return{...data,index,complete:issues.size===0,issues:[...issues]};
  }
  async hashPrefix(handle,size,signal,expected,deadline=Infinity) {
    const buffer=Buffer.alloc(64*1024),digest=createHash('sha256');let offset=0;
    while(offset<size) {
      if(signal?.aborted)throw cancelled(signal);if(performance.now()>=deadline)throw failure('HISTORY_READ_TIMEOUT','历史读取超时');
      const {bytesRead}=await handle.read(buffer,0,Math.min(buffer.length,size-offset),offset);
      if(!bytesRead)return false;digest.update(buffer.subarray(0,bytesRead));offset+=bytesRead;await yieldNow();
    }
    return digest.digest('hex')===expected;
  }
  async validate(entry,file,signal,deadline) {
    let handle;
    try {
      handle=await this.openFile(file,'r');if(signal?.aborted)throw cancelled(signal);
      const before=await handle.stat({bigint:true});
      if(String(before.dev)!==entry.dev||String(before.ino)!==entry.ino||before.size<BigInt(entry.size))return false;
      if(stamp(before)===entry.stamp)return true;
      if(before.size===BigInt(entry.size)||entry.size>this.maxScanBytes)return false;
      if(!await this.hashPrefix(handle,entry.size,signal,entry.prefixHash,deadline))return false;
      const after=await handle.stat({bigint:true});
      return String(after.dev)===entry.dev&&String(after.ino)===entry.ino&&after.size>=BigInt(entry.size);
    }catch(error){if(signal?.aborted)throw cancelled(signal);if(error.code==='HISTORY_READ_TIMEOUT')throw error;return false;}
    finally{if(handle)await handle.close().catch(()=>{});}
  }
  async hydrate(entry,group,{signal,deadline}) {
    if(this.active+this.readingPages>=this.maxScans)throw failure('HISTORY_READ_BUSY','历史读取正在进行，请重试当前页。');
    const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),Math.max(1,deadline-performance.now()));
    const combined=signal?AbortSignal.any([signal,controller.signal]):controller.signal;
    this.readingPages++;
    const work=(async()=>{
      let handle;
      const check=()=>{if(combined.aborted)throw cancelled(combined);if(performance.now()>=deadline)throw failure('HISTORY_READ_TIMEOUT','历史页读取超时，请重试当前页。');};
      try {
        handle=await this.openFile(entry.file,'r');check();const before=await handle.stat({bigint:true});check();
        if(String(before.dev)!==entry.dev||String(before.ino)!==entry.ino||before.size<BigInt(entry.size))throw expired();
        const records=[];
        for(const row of group.records) {
          check();const buffer=Buffer.alloc(row.length);let offset=0;
          while(offset<buffer.length){const {bytesRead}=await handle.read(buffer,offset,buffer.length-offset,row.offset+offset);check();if(!bytesRead)throw expired();offset+=bytesRead;}
          const line=buffer.toString('utf8');if(hash(line).slice(0,20)!==row.lineId)throw expired();
          const source=publicRecord(JSON.parse(line),row.lineId,row.order);if(!source)throw expired();records.push(source);await yieldNow();
        }
        const after=await handle.stat({bigint:true});check();
        if(before.dev!==after.dev||before.ino!==after.ino||after.size<before.size||after.size===before.size&&stamp(after)!==stamp(before))throw expired();
        return records;
      }finally{if(handle)await handle.close().catch(()=>{});this.readingPages--;clearTimeout(timeout);}
    })();
    try{return await wait(work,combined);}
    catch(error){if(signal?.aborted)throw cancelled(signal);if(controller.signal.aborted)throw failure('HISTORY_READ_TIMEOUT','历史页读取超时，请重试当前页。');throw error;}
  }
  async page(entry,threadId,{position,limit,media,signal,deadline}) {
    if(this.projecting>=this.maxScans)throw failure('HISTORY_READ_BUSY','历史读取正在进行，请重试当前页。');
    this.projecting++;
    try {
      const end=position?.b??entry.index.length;let start=Math.max(0,end-limit);
      // Reduce only the oldest edge when a page contains many inline pictures.
      // The cursor still describes one contiguous suffix, so no record is lost.
      const sourceBytes=()=>[...new Set(entry.index.slice(start,end).map(row=>row.group))].reduce((n,g)=>n+g.sourceBytes,0);
      while(start<end&&sourceBytes()>this.maxPageBytes)start++;
      if(start===end&&end)throw failure('HISTORY_PAGE_BUDGET','该历史记录图片较大，暂时无法读取此页。');
      const chosen=entry.index.slice(start,end),projected=new Map(),messages=[],issues=new Set(entry.issues);
      const allowed=new Set(chosen.map(row=>row.id));
      const pageMedia=media?{decorateItem:(id,item)=>allowed.has(item.id)?media.decorateItem(id,item):{text:itemVisibleText(item),images:[]}}:undefined;
      for(const row of chosen) {
        if(signal?.aborted)throw cancelled(signal);
        if(performance.now()>=deadline)throw failure('HISTORY_READ_TIMEOUT','历史页读取超时，请重试当前页。');
        if(!projected.has(row.group)){
          await yieldNow();if(signal?.aborted)throw cancelled(signal);
          if(performance.now()>=deadline)throw failure('HISTORY_READ_TIMEOUT','历史页读取超时，请重试当前页。');
          const records=await this.hydrate(entry,row.group,{signal,deadline});
          projected.set(row.group,this.project(records,Infinity,{media:pageMedia,threadId}));
        }
        const message=projected.get(row.group)[row.localIndex];
        if(message?.id===row.id)messages.push(message);else issues.add('projection_changed');
      }
      if(signal?.aborted)throw cancelled(signal);
      if(performance.now()>=deadline)throw failure('HISTORY_READ_TIMEOUT','历史页读取超时，请重试当前页。');
      if(start&&!this.cache.has(entry.epoch))throw expired();
      const nextCursor=start?Buffer.from(JSON.stringify({v:1,t:threadId,e:entry.epoch,b:start,a:entry.index[start].id})).toString('base64url'):null;
      return{messages,nextCursor,hasMore:start>0,complete:entry.complete&&issues.size===0,issues:[...issues],source:'local-history'};
    }finally{this.projecting--;}
  }
}
