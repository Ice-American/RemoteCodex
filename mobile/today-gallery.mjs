// Builds the read-only phone gallery response after the gateway authenticates
// the request. It never connects an owner, starts a turn or reads image bytes.
import {validThreadId} from './history.mjs';
import {setImmediate as yieldNow} from 'node:timers/promises';

export async function readTodayGallery({catalog,media,hostId,threadId,signal,maxImages=4096,responseTimeoutMs=1000}) {
  if(!['mac','windows'].includes(hostId)||!validThreadId(threadId))throw Error('图片聊天标识无效');
  if(typeof catalog?.readTodayImages!=='function')throw Error('当前电脑尚不支持今日图片');
  const result=await catalog.readTodayImages(threadId,{media,signal});
  if(!/^\d{4}-\d{2}-\d{2}$/.test(result?.date??'')||!Array.isArray(result.images))throw Error('图片目录暂不可用');
  const images=[],issues=new Set(Array.isArray(result.issues)?result.issues.filter(value=>typeof value==='string'&&/^[a-z_]{1,64}$/.test(value)):[]);
  const deadline=performance.now()+responseTimeoutMs;
  // Keep even the metadata-only response cancellable and bounded. The normal
  // reader is bounded too; this boundary does not trust a future implementation.
  for(const image of result.images) {
    if(images.length%64===0)await yieldNow();
    if(signal?.aborted)throw signal.reason??Error('图片目录读取已取消');
    if(images.length>=maxImages){issues.add('response_budget');break;}
    if(performance.now()>=deadline){issues.add('response_timeout');break;}
    if(!/^[a-f0-9]{64}$/.test(image.id??'')||!/^[a-f0-9]{64}$/.test(image.contentKey??'')||
       typeof image.messageId!=='string'||image.messageId.length>512||!Number.isFinite(image.at))throw Error('图片目录暂不可用');
    images.push({id:image.id,contentKey:image.contentKey,name:String(image.name||'图片').replace(/[\0-\x1f\x7f]/g,'').slice(0,512),messageId:image.messageId,at:image.at});
  }
  if(signal?.aborted)throw signal.reason??Error('图片目录读取已取消');
  return{host:hostId,id:threadId,date:result.date,images,complete:result.complete===true&&issues.size===0,issues:[...issues]};
}
