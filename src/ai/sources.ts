import { active, titleOf } from "../lib";
import type { Item, Reply } from "../types";
import type { AISource } from "./types";
export function itemSources(items:Item[],replies:Reply[],itemId?:string):AISource[] {
  const sources:AISource[]=[];
  for(const item of items.filter(active)) {
    if(item.type==='topic'&&!itemId)continue;
    sources.push({id:item.id,title:titleOf(item),text:item.body,kind:item.type==='experience'?'经验':'知识记录',locator:'记录正文 · 更新于 '+item.updated_at,itemId:item.id,url:item.source||undefined});
    if(itemId===item.id)for(const reply of replies.filter(r=>r.item_id===item.id&&active(r)))sources.push({id:reply.id,title:titleOf(item)+' · 补充',text:reply.body,kind:'补充',locator:'补充 · '+reply.created_at,itemId:item.id});
  }
  return sources;
}
export function retrieve(sources:AISource[],question:string,limit=8):AISource[] {
  const words=question.toLowerCase().match(/[a-z0-9]{2,}|[\u4e00-\u9fff]+/g)||[];
  const terms=[...new Set(words.flatMap(w=>/[\u4e00-\u9fff]/.test(w)&&w.length>2 ? Array.from({length:w.length-1},(_,i)=>w.slice(i,i+2)) : [w]))];
  return sources.map(source=>{const hay=(source.title+' '+source.text).toLowerCase();return {source,score:terms.reduce((n,t)=>n+(hay.includes(t)?1:0)+(source.title.toLowerCase().includes(t)?2:0),0)};}).filter(x=>x.score>0).sort((a,b)=>b.score-a.score).slice(0,limit).map(x=>x.source);
}
export function formatSources(sources:AISource[],reference:AISource[]=sources) {return sources.map((s)=>'[S'+(reference.findIndex(x=>x.id===s.id)+1)+'] '+s.title+' · '+s.locator+'\n<source_data>\n'+s.text+'\n</source_data>').join('\n\n');}
export function batches(sources:AISource[],max=18000):AISource[][] {
  const groups:AISource[][]=[];let current:AISource[]=[],length=0;
  for(const source of sources)for(let offset=0;offset<source.text.length;offset+=max){const text=source.text.slice(offset,offset+max);if(length+text.length>max&&current.length){groups.push(current);current=[];length=0;}current.push({...source,text,locator:source.locator+(source.text.length>max?' · 字符 '+(offset+1)+'–'+(offset+text.length):'')});length+=text.length;}
  if(current.length)groups.push(current);return groups;
}
