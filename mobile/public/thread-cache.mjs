// Keeps a small in-memory preview of public history. It deliberately cannot
// retain owners, capabilities, questions or approvals from a live snapshot.
export class ThreadPreviewCache {
  constructor({now=()=>Date.now(),ttlMs=120000,maxScopes=10,maxBytes=2*1024*1024}={}) {
    Object.assign(this,{now,ttlMs,maxScopes,maxBytes});this.entries=new Map();this.bytes=0;
  }
  key(host,id){return JSON.stringify([host,id]);}
  delete(key){const row=this.entries.get(key);if(row){this.bytes-=row.bytes;this.entries.delete(key);}}
  get(host,id){
    const key=this.key(host,id),entry=this.entries.get(key);if(!entry)return null;
    if(this.now()-entry.at>=this.ttlMs){this.delete(key);return null;}
    this.entries.delete(key);this.entries.set(key,entry);return entry.value;
  }
  set(host,id,page){
    if(!['mac','windows'].includes(host)||typeof id!=='string'||!id||!Array.isArray(page?.messages))return false;
    const messages=page.messages.slice(-40).filter(m=>m&&['user','assistant'].includes(m.role)&&m.phase!=='analysis'&&m.channel!=='analysis'&&typeof m.id==='string').map(m=>({
      id:m.id,role:m.role,text:typeof m.text==='string'?m.text:'',
      ...(m.phase=== 'final'||m.phase==='commentary'?{phase:m.phase}:{}),
      ...(Array.isArray(m.images)?{images:m.images.filter(i=>/^[a-f0-9]{64}$/.test(i?.id??'')&&/^[a-f0-9]{64}$/.test(i?.contentKey??'')).map(i=>({id:i.id,contentKey:i.contentKey,name:String(i.name??'图片').slice(0,512)}))}:{}),
      ...(m.imageUnavailable===true?{imageUnavailable:true}:{}),
    }));
    const value={messages,nextCursor:typeof page.nextCursor==='string'?page.nextCursor:null,hasMore:page.hasMore===true,complete:page.complete===true,
      issues:Array.isArray(page.issues)?page.issues.filter(i=>typeof i==='string'&&/^[a-z_]{1,64}$/.test(i)).slice(0,20):[],source:'local-history'};
    const bytes=JSON.stringify(value).length*2,key=this.key(host,id);this.delete(key);if(bytes>this.maxBytes)return false;
    this.entries.set(key,{value,bytes,at:this.now()});this.bytes+=bytes;
    while(this.entries.size>this.maxScopes||this.bytes>this.maxBytes)this.delete(this.entries.keys().next().value);
    return true;
  }
}
