// Combines saved and live records by shared identities, never by text. Native
// order is authoritative; unmatched records remain available in source order.
export const timelineKey=message=>message?.id==null?null:JSON.stringify([message.role,message.id]);
function unique(messages,source) {
 const rows=[],positions=new Map();
 for(const message of messages??[]) {
  if(!message||typeof message.text!=='string'&&!Array.isArray(message.images)&&!Array.isArray(message.visualizations))continue;
  const key=timelineKey(message),row={key:key??JSON.stringify([source,'position',rows.length]),message:typeof message.text==='string'?message:{...message,text:''},source};
  if(key!==null&&positions.has(key))rows[positions.get(key)]=row;
  else {if(key!==null)positions.set(key,rows.length);rows.push(row);}
 }
 return rows;
}
export function messageTimeline(savedMessages=[],liveMessages=[]) {
 const saved=unique(savedMessages,'saved'),live=unique(liveMessages,'live');
 if(!saved.length||!live.length)return{rows:saved.length?saved:live,separated:false,boundary:null,reason:null};
 const liveByKey=new Map(live.map((row,index)=>[row.key,{row,index}]));
 const anchors=saved.map((row,index)=>({saved:index,live:liveByKey.get(row.key)?.index})).filter(a=>a.live!==undefined);
 const compatible=anchors.every((a,i)=>i===0||a.live>anchors[i-1].live);
 if(!anchors.length||!compatible) {
  // No invented chronology across disjoint sources or contradictory anchors.
  // Keep live order and label the saved-only segment separately.
  const older=saved.filter(row=>!liveByKey.has(row.key));
  return{rows:[...older,...live],separated:older.length>0,boundary:older.length,reason:anchors.length?'conflict':'unanchored'};
 }
 const rows=[];let savedAt=0,liveAt=0;
 for(const [anchorIndex,anchor] of anchors.entries()) {
  const savedGap=saved.slice(savedAt,anchor.saved),liveGap=live.slice(liveAt,anchor.live);
  if(anchorIndex>0) {
   // Distinct IDs are never merged. Between two exact anchors, a unique
   // text-only user copy may be shown as an expandable saved record in its
   // original slot. Repeated prompts and images are deliberately left alone.
   const signature=row=>row.message.role==='user'&&row.message.text?.trim()&&!row.message.images?.length&&!row.message.visualizations?.length&&!row.message.imageUnavailable?row.message.text:null;
   const savedCounts=new Map(),liveCounts=new Map();
   for(const [gap,counts] of [[savedGap,savedCounts],[liveGap,liveCounts]])for(const row of gap){const text=signature(row);if(text!==null)counts.set(text,(counts.get(text)??0)+1);}
   for(let i=0;i<savedGap.length;i++){const text=signature(savedGap[i]);if(text!==null&&savedCounts.get(text)===1&&liveCounts.get(text)===1)savedGap[i]={...savedGap[i],sameTextSaved:true};}
  }
  rows.push(...savedGap,...liveGap,live[anchor.live]);
  savedAt=anchor.saved+1;liveAt=anchor.live+1;
 }
 rows.push(...saved.slice(savedAt),...live.slice(liveAt));
 return{rows,separated:false,boundary:null,reason:null};
}
