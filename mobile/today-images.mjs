// Reads a complete saved Shanghai day as a separate image gallery. Source
// caches stay in memory; snapshots contain only registered opaque media refs.
import fs from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {setImmediate as yieldNow} from 'node:timers/promises';
import {itemImageSource,nativeImageContent} from './media.mjs';

const digest=value=>createHash('sha256').update(value).digest('hex').slice(0,20);
const signature=stat=>[stat.dev,stat.ino,stat.size,stat.mtimeNs,stat.ctimeNs].join(':');
const aborted=signal=>signal?.reason ?? Object.assign(Error('图片目录读取已取消'),{code:'ABORT_ERR'});
export function shanghaiDate(now=Date.now()) {
  return new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(now);
}
function dayBounds(date) {
  if(typeof date!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(date)||new Date(date+'T00:00:00Z').toISOString().slice(0,10)!==date)throw Error('图片日期无效');
  const start=Date.parse(date+'T00:00:00+08:00');return{start,end:start+86400000};
}
async function wait(promise,signal) {
  if(!signal)return promise;
  let listener;
  try{return await Promise.race([promise,new Promise((_,reject)=>{listener=()=>reject(aborted(signal));if(signal.aborted)listener();else signal.addEventListener('abort',listener,{once:true});})]);}
  finally{signal.removeEventListener('abort',listener);}
}
// Sanitize before caching. Tool arguments, tool text, structured payloads and
// hidden analysis are not retained merely to build a picture directory.
function publicRecord(row,lineId) {
  const p=row?.payload;if(!p||p.phase==='analysis'||p.channel==='analysis')return null;
  const content=values=>(Array.isArray(values)?values:[]).filter(c=>['text','inputText','input_text','output_text'].includes(c?.type)||nativeImageContent(c)||!!itemImageSource(c)).map(c=>{
    if(['text','inputText','input_text','output_text'].includes(c.type))return{type:c.type,text:c.text??''};
    const source=itemImageSource(c);return source?{type:source.startsWith('data:')||/^https?:/i.test(source)?'image':'localImage',...(source.startsWith('data:')||/^https?:/i.test(source)?{url:source}:{path:source})}:null;
  }).filter(Boolean);
  let payload;
  if(row.type==='event_msg'&&['user_message','agent_message'].includes(p.type)&&typeof p.message==='string')
    payload={type:p.type,message:p.message,phase:p.phase,channel:p.channel,
      images:content((Array.isArray(p.images)?p.images:[]).map(v=>typeof v==='string'?{type:'image',url:v}:v)),
      local_images:content((Array.isArray(p.local_images)?p.local_images:[]).map(v=>typeof v==='string'?{type:'localImage',path:v}:v))};
  else if(row.type==='response_item'&&p.type==='message'&&['user','assistant'].includes(p.role))
    payload={type:p.type,id:p.id,role:p.role,phase:p.phase,channel:p.channel,content:content(p.content)};
  else if(row.type==='response_item'&&['function_call_output','custom_tool_call_output'].includes(p.type)&&Array.isArray(p.output))
    payload={type:p.type,call_id:p.call_id,output:p.output.filter(c=>c?.type==='input_image'&&typeof c.image_url==='string').map(c=>({type:'input_image',image_url:c.image_url}))};
  else if(row.type==='event_msg'&&p.type==='item_completed'&&p.item?.type==='McpToolCall') {
    const item=p.item;if(item.status!=='completed'||item.phase==='analysis'||item.channel==='analysis'||item.error!=null||item.result?.isError===true)return null;
    payload={type:p.type,item:{type:'McpToolCall',id:item.id,status:'completed',result:{content:(item.result?.content??[]).filter(nativeImageContent).map(c=>({type:'image',data:c.data,mimeType:c.mimeType}))}}};
  } else return null;
  return{row:{type:row.type,payload},lineId};
}

// Pairing is local to one exact role/text signature or tool call. Keeping those
// groups intact preserves the history parser's duplicate rules across yields.
function projectionKey(record) {
  const p=record.row.payload;
  if(p.type==='item_completed')return 'tool:'+p.item.id;
  if(['function_call_output','custom_tool_call_output'].includes(p.type))return 'tool:'+p.call_id;
  const role=p.type==='user_message'||p.role==='user'?'user':'assistant';
  const text=p.message??(p.content??[]).filter(c=>['text','inputText','input_text','output_text'].includes(c.type)).map(c=>c.text??'').join('\n');
  return role+':'+createHash('sha256').update(text).digest('hex');
}
function projectionItems(record,maximum) {
  const p=record.row.payload;
  let count=(p.output??p.item?.result?.content??p.content??[]).length+(p.images??[]).length+(p.local_images??[]).length;
  const text=p.message??(p.content??[]).map(c=>c.text??'').join('\n');
  // Markdown/local file links can cause synchronous metadata probes too.
  for(const ignored of text.matchAll(/!\[|<file\b|\]\(|:codex-file-citation\{|^##[ \t]/gm)){if(++count>maximum)break;}
  return count;
}

export class TodayImagesReader {
  constructor({project,scanTimeoutMs=10000,maxLineBytes=8*1024*1024,maxScanBytes=256*1024*1024,
    maxDataBytes=64*1024*1024,maxRecords=4096,maxCacheBytes=96*1024*1024,
    maxProjectionBytes=32*1024*1024,maxProjectionRecords=64,maxProjectionItems=64,maxImages=2048,maxScans=2,
    openFile=(...args)=>fs.open(...args),statFile=(...args)=>fs.stat(...args)}={}) {
    Object.assign(this,{project,scanTimeoutMs,maxLineBytes,maxScanBytes,maxDataBytes,maxRecords,maxCacheBytes,maxProjectionBytes,maxProjectionRecords,maxProjectionItems,maxImages,openFile,statFile});
    this.maxScans=Math.min(2,Math.max(1,Math.trunc(maxScans)||2));
    this.cache=new Map();this.cacheBytes=0;this.inflight=new Map();this.active=0;this.projecting=0;
  }
  dropCache(key) {
    const entry=this.cache.get(key);if(entry){this.cacheBytes-=entry.data.bytes;this.cache.delete(key);}
  }
  storeCache(key,stamp,data) {
    this.dropCache(key);if(data.bytes>this.maxCacheBytes)return;
    this.cache.set(key,{stamp,data});this.cacheBytes+=data.bytes;
    while(this.cache.size>16||this.cacheBytes>this.maxCacheBytes)this.dropCache(this.cache.keys().next().value);
  }
  async result(data,threadId,media,date,{signal,deadline}) {
    const issues=new Set(data.issues),images=[];
    const check=()=>{if(signal?.aborted)throw aborted(signal);if(performance.now()>=deadline){issues.add('projection_timeout');return false;}return true;};
    if(this.projecting>=this.maxScans)return{date,images,complete:false,issues:[...issues,'projection_busy']};
    this.projecting++;
    try {
      const groups=new Map();check();
      for(const record of data.records) {
        if(!check())break;
        const key=projectionKey(record);let group=groups.get(key);
        if(!group){group={records:[],bytes:0,items:0,overflow:false};groups.set(key,group);}
        const items=projectionItems(record,this.maxProjectionItems);
        if(group.bytes+record.bytes>this.maxProjectionBytes||group.records.length>=this.maxProjectionRecords||group.items+items>this.maxProjectionItems){group.overflow=true;issues.add('projection_budget');}
        else{group.records.push(record);group.bytes+=record.bytes;group.items+=items;}
        await yieldNow();
      }
      for(const group of groups.values()) {
        await yieldNow();if(!check())break;
        // Never split a duplicate/pairing group and silently change its meaning.
        if(group.overflow)continue;
        for(const message of this.project(group.records,Infinity,{media,threadId})) {
          if(message.imageUnavailable)issues.add('unsupported_image');
          for(const ref of message.images??[]) {
            if(images.length>=this.maxImages){issues.add('image_budget');break;}
            const at=data.times.get(message.id);if(!Number.isFinite(at)){issues.add('image_timestamp_missing');continue;}
            images.push({messageId:message.id,at,id:ref.id,contentKey:ref.contentKey,name:ref.name});
          }
        }
        if(issues.has('image_budget'))break;
        if(!check())break;
      }
      check();
    }finally{this.projecting--;}
    // Duplicate persisted representations may finish later than the original
    // event. Sort by the returned timestamp; stable sort preserves equal times.
    images.sort((a,b)=>a.at-b.at);
    return{date,images,complete:data.complete&&issues.size===0,issues:[...issues]};
  }
  async read(file,threadId,{media,date=shanghaiDate(),signal}={}) {
    const deadline=performance.now()+this.scanTimeoutMs;
    const bounds=dayBounds(date);if(signal?.aborted)throw aborted(signal);
    const empty=issue=>({date,images:[],complete:false,issues:[issue]});
    if(!file)return empty('history_unavailable');
    const key=threadId+':'+date+':'+file;
    let record=this.inflight.get(key);
    if(!record) {
      if(this.active>=this.maxScans)return empty('scan_busy');
      record={controller:new AbortController(),records:[],times:new Map(),issues:new Set(),bytes:0,consumers:0,settled:false};
      this.active++;
      let timer;
      const timed=new Promise(resolve=>{timer=setTimeout(()=>{
        record.issues.add('scan_timeout');record.controller.abort();
        resolve({records:[...record.records],times:new Map(record.times),bytes:record.bytes,issues:[...record.issues],complete:false});
      },this.scanTimeoutMs);});
      const work=Promise.resolve().then(async()=>{
        try {
          const stat=await this.statFile(file,{bigint:true});
          if(record.controller.signal.aborted)throw aborted(record.controller.signal);
          if(!stat.isFile())throw Error('not a regular history file');
          const stamp=signature(stat),cached=this.cache.get(key);
          if(cached?.stamp===stamp){this.cache.delete(key);this.cache.set(key,cached);return cached.data;}
          const data=await this.scan(file,record,bounds,stamp);
          if(data.complete)this.storeCache(key,stamp,data);
          return data;
        } catch {
          record.issues.add(record.controller.signal.aborted?'scan_cancelled':'history_read_failed');
          return{records:[...record.records],times:new Map(record.times),bytes:record.bytes,issues:[...record.issues],complete:false};
        }
      }).finally(()=>{record.settled=true;this.active--;clearTimeout(timer);if(this.inflight.get(key)===record)this.inflight.delete(key);});
      record.promise=Promise.race([work,timed]);this.inflight.set(key,record);
    }
    record.consumers++;
    try {
      const result=await this.result(await wait(record.promise,signal),threadId,media,date,{signal,deadline});
      if(!result.complete)this.dropCache(key);
      return result;
    }
    finally{record.consumers--;if(!record.consumers&&!record.settled){record.controller.abort();record.issues.add('scan_cancelled');}}
  }
  async scan(file,record,{start,end},expectedStamp) {
    let handle,position=0,ioBytes=0,lineParts=[],lineBytes=0,skipping=false,budgetReached=false;
    const scannedHash=createHash('sha256');
    const check=()=>{if(record.controller.signal.aborted)throw aborted(record.controller.signal);};
    const processLine=line=>{
      if(!line.trim())return;
      let row;try{row=JSON.parse(line);}catch{record.issues.add('invalid_record');return;}
      const at=typeof row.timestamp==='string'?Date.parse(row.timestamp):NaN;
      if(!Number.isFinite(at))return;
      if(at<start||at>=end)return;
      const lineId=digest(line),sanitized=publicRecord(row,lineId);if(!sanitized)return;
      // Count all retained public text/base64 plus conservative object/map
      // overhead. A large number of tiny rows cannot bypass the byte limit.
      sanitized.bytes=Buffer.byteLength(JSON.stringify(sanitized),'utf8')*4+512;
      if(record.records.length>=this.maxRecords){record.issues.add('record_budget');budgetReached=true;return;}
      if(record.bytes+sanitized.bytes>this.maxDataBytes){record.issues.add('data_budget');budgetReached=true;return;}
      record.records.push(sanitized);record.bytes+=sanitized.bytes;
      const p=row.payload,id=p?.item?.id??p?.call_id??p?.id??lineId;record.times.set(id,at);record.times.set(lineId,at);
    };
    const accept=(part,finished)=>{
      if(!skipping&&lineBytes+part.length>this.maxLineBytes){skipping=true;lineParts=[];record.issues.add('record_too_large');}
      if(!skipping){lineParts.push(part);lineBytes+=part.length;}
      if(finished){if(!skipping)processLine(Buffer.concat(lineParts,lineBytes).toString('utf8'));lineParts=[];lineBytes=0;skipping=false;}
    };
    try {
      check();handle=await this.openFile(file,'r');check();const before=await handle.stat({bigint:true});check();
      if(!before.isFile())throw Error('not a regular history file');
      const size=Number(before.size),buffer=Buffer.alloc(64*1024);
      while(position<size&&!budgetReached) {
        if(ioBytes>=this.maxScanBytes){record.issues.add('scan_budget');budgetReached=true;break;}
        check();const {bytesRead}=await handle.read(buffer,0,Math.min(buffer.length,size-position,this.maxScanBytes-ioBytes),position);check();if(!bytesRead)break;ioBytes+=bytesRead;
        const chunk=Buffer.from(buffer.subarray(0,bytesRead));scannedHash.update(chunk);position+=bytesRead;let cursor=0,next;
        while(!budgetReached&&(next=chunk.indexOf(10,cursor))!==-1){accept(chunk.subarray(cursor,next),true);cursor=next+1;}
        if(cursor<chunk.length)accept(chunk.subarray(cursor),false);
        await yieldNow();
      }
      if(!budgetReached&&(lineBytes||skipping))accept(Buffer.alloc(0),true);
      check();const after=await handle.stat({bigint:true});check();
      const sameFile=before.dev===after.dev&&before.ino===after.ino;
      if(budgetReached){/* A bounded partial scan is not evidence of a rewrite. */}
      else if(position!==size||!sameFile||signature(before)!==expectedStamp||after.size<before.size||after.size===before.size&&signature(before)!==signature(after))record.issues.add('source_changed');
      else if(after.size>before.size) {
        // Active chats append while a gallery is reading. A second hash of
        // the captured prefix accepts that snapshot, while rejecting a rewrite
        // hidden by an append. The next request reads the newly saved rows.
        const verified=createHash('sha256');let offset=0;
        while(offset<size) {
          if(ioBytes>=this.maxScanBytes){record.issues.add('scan_budget');budgetReached=true;break;}
          check();const {bytesRead}=await handle.read(buffer,0,Math.min(buffer.length,size-offset,this.maxScanBytes-ioBytes),offset);check();if(!bytesRead)break;ioBytes+=bytesRead;
          verified.update(buffer.subarray(0,bytesRead));offset+=bytesRead;await yieldNow();
        }
        const final=await handle.stat({bigint:true});check();
        if(!budgetReached&&(offset!==size||final.dev!==before.dev||final.ino!==before.ino||final.size<before.size||verified.digest('hex')!==scannedHash.digest('hex')))record.issues.add('source_changed');
      }
    }catch(error){record.issues.add(record.controller.signal.aborted?'scan_cancelled':'history_read_failed');}
    finally{if(handle)await handle.close().catch(()=>{});}
    return{records:[...record.records],times:new Map(record.times),bytes:record.bytes,issues:[...record.issues],complete:record.issues.size===0};
  }
}
