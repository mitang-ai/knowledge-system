import {useState} from 'react';
import {Body,Overlay,SafeLink} from '../ui';
import {useWorkspace} from '../workspace';
interface SavedSource {source_id?:string;item_id?:string;title?:string;locator?:string;url?:string;snapshot?:string;}
export function AIOrigin({value}:{value:unknown}) {
 const {ws,open}=useWorkspace();const [source,setSource]=useState<SavedSource|null>(null);
 if(!value||typeof value!=='object')return null;
 const data=value as {requested_model?:unknown;response_model?:unknown;sources?:SavedSource[];partial?:boolean};
 const model=typeof data.response_model==='string'?data.response_model:typeof data.requested_model==='string'?data.requested_model:'未确认';
 const sources=Array.isArray(data.sources)?data.sources:[];
 return <><details className="ai-origin"><summary>AI 辅助 · 经用户收录 · {model}{data.partial?' · 来源结果未完整':''}</summary><p>模型归因与引用来自收录时的记录；原文之后可能发生变化。</p>{sources.map((s,i)=><div key={i}><span>[S{i+1}] {s.title} · {s.locator}</span> <button className="text-button" onClick={()=>setSource(s)}>引用片段</button>{s.item_id&&ws.items.some(x=>x.id===s.item_id&&!x.deleted_at)&&<button className="text-button" onClick={()=>open(s.item_id!)}>当前原文</button>}{typeof s.url==='string'&&<SafeLink href={s.url}>来源链接</SafeLink>}</div>)}</details>{source&&<div className="ai-dialog"><Overlay title="收录时的引用片段" onClose={()=>setSource(null)}><div className="ai-dialog-body"><small>{source.title} · {source.locator}</small><div className="ai-source-preview"><Body text={typeof source.snapshot==='string'?source.snapshot:'没有保留文字快照，请查看来源原文。'}/></div></div></Overlay></div>}</>;
}
