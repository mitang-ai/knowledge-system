import {useEffect,useMemo,useRef,useState} from 'react';
import {ArrowRight,Check,Copy,FileText,Layers,MessageSquare,Search,X} from 'lucide-react';
import {active,newId,newItem,stamp,titleOf} from '../lib';
import {Body,Overlay} from '../ui';
import {useWorkspace} from '../workspace';
import {useAI} from './context';
import {AIError,generate,safeAIError} from './client';
import {scrubSecrets} from './storage';
import {batches,formatSources,itemSources,retrieve} from './sources';
import {enabledModels,type AIMode,type AISource} from './types';
interface Message {id:string;role:'user'|'assistant';text:string;model:string;requestedModel:string;sources:AISource[];mode:AIMode;at:string;complete:boolean;truncated:boolean;error?:string;}
function Answer({message,onCitation}:{message:Message;onCitation:(s:AISource)=>void}) {
 return <div className="ai-answer">{message.text.split('\n').map((line,i)=>{if(!line.trim())return <div className="ai-paragraph-gap" key={i}/>;const parts=line.replace(/^#{1,4}\s/,'').split(/(\[S\d+\])/g).map((part,j)=>{const match=part.match(/^\[S(\d+)\]$/);if(!match)return <span key={j}>{part.replace(/\*\*/g,'')}</span>;const source=message.sources[Number(match[1])-1];return source?<button key={j} className="ai-citation" onClick={()=>onCitation(source)} aria-label={'查看来源 '+match[1]}>{match[1]}</button>:<span key={j} className="ai-unmatched" title="未匹配到本次来源">{part}</span>;});return line.startsWith('#')?<h3 key={i}>{parts}</h3>:<p key={i}>{parts}</p>;})}</div>;
}
export function AIPanel() {
 const ai=useAI();const {ws,scoped,space,save,saveReply,canWrite,notify}=useWorkspace();
 const [mode,setMode]=useState<AIMode>(ai.initialMode),[model,setModel]=useState(ai.config.defaultModel),[scope,setScope]=useState<Set<string>>(new Set()),[scopeOpen,setScopeOpen]=useState(false),[query,setQuery]=useState(''),[question,setQuestion]=useState(''),[history,setHistory]=useState<Message[]>([]),[busy,setBusy]=useState(false),[status,setStatus]=useState(''),[allowLong,setAllowLong]=useState(false),[citation,setCitation]=useState<AISource|null>(null),[adopt,setAdopt]=useState<Message|null>(null),[adoptText,setAdoptText]=useState(''),[adoptKind,setAdoptKind]=useState('reply'),[saving,setSaving]=useState(false);
 const controller=useRef<AbortController|null>(null);const runId=useRef(0);
 const options=enabledModels(ai.config);const chosen=options.find(x=>x.id===model);
 const contextKey=ai.page+':'+ai.topicId+':'+ai.target.kind+':'+(ai.target.itemId||'');
 const pool=useMemo(()=>{
  if(ai.page==='settings')return [];
  if(ai.target.kind==='reading')return ai.extraSources;
  if(ai.target.kind==='draft')return ai.draft.trim()?[{id:'draft',title:'当前草稿',text:ai.draft,kind:'即时想法',locator:'尚未保存的原话'}]:[];
  const item=ai.target.itemId?ws.items.find(x=>x.id===ai.target.itemId&&active(x)):null;
  if(item)return itemSources([item],ws.replies,item.id);
  let notes=scoped.filter(x=>active(x)&&!x.archived&&x.type!=='topic');
  if(ai.topicId)notes=notes.filter(x=>x.topic_ids.includes(ai.topicId));
  if(ai.page==='experiences')notes=notes.filter(x=>x.type==='experience');
  if(ai.page==='starred')notes=notes.filter(x=>x.starred);
  if(ai.page==='inbox')notes=notes.filter(x=>!x.topic_ids.length);
  if(ai.page==='review')notes=notes.filter(x=>!x.no_review);
  return itemSources(notes,ws.replies);
 },[ai.page,ai.target.kind,ai.target.itemId,ai.topicId,ai.draft,ai.extraSources,scoped,ws.items,ws.replies]);
 const readingIds=ai.target.kind==='reading'?pool.map(x=>x.id).join(','):'';
 useEffect(()=>{controller.current?.abort();runId.current++;setBusy(false);setHistory([]);setStatus('');setAllowLong(false);setCitation(null);setAdopt(null);setQuery('');setScope(new Set(ai.target.kind==='reading'?pool.map(x=>x.id):ai.target.itemId||ai.target.kind==='draft'?[pool[0]?.id].filter(Boolean):ai.topicId?pool.slice(0,5).map(x=>x.id):[]));},[contextKey,readingIds]);
 useEffect(()=>{setMode(ai.initialMode);},[ai.initialMode]);
 useEffect(()=>{if(!model&&ai.config.defaultModel)setModel(ai.config.defaultModel);},[ai.config.defaultModel,model]);
 useEffect(()=>{if(!ai.isOpen)controller.current?.abort();},[ai.isOpen]);
 useEffect(()=>()=>{controller.current?.abort();runId.current++;},[]);
 useEffect(()=>{if(!ai.isOpen)return;const handle=(e:KeyboardEvent)=>{if(e.key==='Escape'&&!citation&&!adopt){e.preventDefault();e.stopImmediatePropagation();ai.close();}};document.addEventListener('keydown',handle,true);return()=>document.removeEventListener('keydown',handle,true);},[ai.isOpen,citation,adopt]);
 const selected=pool.filter(s=>scope.has(s.id));const chars=selected.reduce((n,s)=>n+s.text.length,0);const chunks=batches(selected);const targetItem=ws.items.find(x=>x.id===ai.target.itemId);const targetWritable=canWrite&&(!targetItem?.space_id||ws.spaces.find(s=>s.id===targetItem.space_id)?.role!=='viewer');
 const candidates=query.trim()?retrieve(pool,query,30):pool;
 const updateMessage=(id:string,value:Partial<Message>,token:number)=>{if(token!==runId.current)return;setHistory(old=>old.map(m=>m.id===id?{...m,...value}:m));};
 const run=async(prompt:string,taskMode:AIMode=mode)=>{
  if(!chosen||!selected.length||busy)return;
  if(chars>200000){setStatus('本次超过 20 万字符，请减少来源或拆分材料。');return;}
  if(chunks.length>1&&!allowLong){setStatus('长文需要分段读取，请先确认预计请求次数。');return;}
  const sourceSnapshot=selected.map(s=>({...s}));const used=chosen;const c=new AbortController();controller.current=c;const token=++runId.current;const id=newId();const requested=prompt.trim()||(taskMode==='summary'?'总结所选来源，保留核心观点和出处。':taskMode==='analysis'?'分析所选材料的论点、证据、适用边界与待验证问题。':'帮我继续思考这些记录。');
  const answer:Message={id,role:'assistant',text:'',model:'',requestedModel:used.model.id,sources:sourceSnapshot,mode:taskMode,at:stamp(),complete:false,truncated:false};
  const signature=JSON.stringify(sourceSnapshot.map(s=>[s.id,s.text]));
  const previous=history.slice(-4).filter(m=>m.text&&JSON.stringify(m.sources.map(s=>[s.id,s.text]))===signature).map(m=>({role:m.role,content:scrubSecrets(m.text,ai.config)}));
  setHistory(old=>[...old,{...answer,id:newId(),role:'user',text:requested},answer]);setQuestion('');setBusy(true);setStatus('');
  const timeout=setTimeout(()=>c.abort(),300000);
  try {
   let material=formatSources(sourceSnapshot);
   if(chunks.length>1) {
    const summaries:string[]=[];
    for(let i=0;i<chunks.length;i++) {
      if(c.signal.aborted)throw new DOMException('已取消','AbortError');if(token===runId.current)setStatus('正在整理第 '+(i+1)+' / '+chunks.length+' 段；尚未完成全文综合。');
      const part=await generate(used.connection,used.model.id,[{role:'user',content:'围绕这个问题整理以下部分材料，保留原来的 [S编号]，不要宣称已阅读全文；不超过 700 字。问题：'+scrubSecrets(requested,ai.config)+'\n\n'+scrubSecrets(formatSources(chunks[i],sourceSnapshot),ai.config)}],{signal:c.signal,maxTokens:Math.min(ai.config.maxTokens,1500)});
      if(!part.complete||part.truncated)throw new AIError('第 '+(i+1)+' 段输出没有完整结束。请提高输出长度或缩小范围后重试。');summaries.push(part.text);
    }
    material='以下是分段阅读产生的 AI 草稿，只能综合这些草稿，不增加无来源的事实。\n'+summaries.join('\n\n')+'\n\n原始来源编号：\n'+sourceSnapshot.map((s,i)=>'[S'+(i+1)+'] '+s.title+' · '+s.locator).join('\n');
    if(material.length>60000)throw new AIError('分段摘要仍然过长，请减少本次来源后重试。');if(token===runId.current)setStatus('所有分段已阅读，正在综合；引用可返回原始来源。');
   }
   const result=await generate(used.connection,used.model.id,[...(taskMode==='chat'?previous:[]),{role:'user',content:'本次材料范围如下，只有这些文字可以作为资料依据。\n\n'+scrubSecrets(material,ai.config)+'\n\n用户请求：'+scrubSecrets(requested,ai.config)}],{signal:c.signal,maxTokens:ai.config.maxTokens,onDelta:text=>updateMessage(id,{text:scrubSecrets(text,ai.config)},token)});
   updateMessage(id,{...result,text:scrubSecrets(result.text,ai.config)},token);
   if(token===runId.current)setStatus(result.truncated?'输出达到上限，结果不完整。可提高输出长度后重新运行。':!result.complete?'连接在完成前结束，已保留部分结果。':'');
  }catch(e){const message=safeAIError(e);updateMessage(id,{error:message,complete:false},token);if(token===runId.current)setStatus(message);}finally{clearTimeout(timeout);if(token===runId.current)setBusy(false);}
 };
 const commit=async()=>{
  if(!adopt||!adoptText.trim()||!targetWritable||saving)return;setSaving(true);
  try {
   const text=scrubSecrets(adoptText.trim(),ai.config);const metadata={requested_model:adopt.requestedModel,response_model:adopt.model||null,mode:adopt.mode,generated_at:adopt.at,sources:adopt.sources.map(s=>({source_id:s.id,item_id:s.itemId||null,title:s.title,locator:s.locator,url:s.url||null,snapshot:s.itemId?s.text.slice(0,600):s.text})),partial:!adopt.complete||adopt.truncated};
   if(adoptKind==='reply'&&targetItem){await saveReply({id:newId(),item_id:targetItem.id,owner_id:ws.me.owner_id,owner_name:ws.me.display_name,body:text,created_at:stamp(),is_progress:false,atts:[],ai:JSON.parse(scrubSecrets(JSON.stringify(metadata),ai.config))});}
   else {const item=newItem(adoptKind==='experience'?'experience':'note',ws.me.owner_id,ws.me.display_name);await save({...item,body:text,title:'',space_id:space||null,topic_ids:ai.topicId?[ai.topicId]:(targetItem?.topic_ids||[]).filter(id=>ws.items.some(t=>t.id===id&&active(t)&&t.type==='topic'&&(t.space_id||'')===space)),exp_st:adoptKind==='experience'?'需要再确认':undefined,ai:JSON.parse(scrubSecrets(JSON.stringify(metadata),ai.config))});}
   setAdopt(null);notify('已收录 AI 辅助内容与引用；原始记录保持完整。');
  }catch(e){notify((e as Error).message);}finally{setSaving(false);}
 };
 if(!ai.isOpen)return null;
 return <><aside className="ai-panel" aria-label="AI 助手"><div className="ai-panel-header"><strong><MessageSquare size={16}/>{ai.target.kind==='reading'?'阅读助手':ai.topicId?'主题助手':ai.page==='review'?'回顾助手':'思考助手'}</strong><button className="icon-button" onClick={ai.close} aria-label="关闭 AI 助手"><X size={17}/></button></div>
 {ai.page==='settings'?<div className="ai-panel-content"><h3>连接自己的模型，在需要时接着想</h3><p>配置只保存在当前浏览器。探测读取模型目录；测试调用验证单个模型能否回答。</p><p>设置页不会读取密钥字段作为聊天上下文，也不会发送接口配置给模型。</p><p>网页尚未读到正文时，可以粘贴正文或在“文件与链接”中读取本地文件。</p></div>:<>
 <div className="ai-model-picker"><label>本次使用的模型<select aria-label="本次 AI 模型" value={chosen?model:''} disabled={busy} onChange={e=>setModel(e.target.value)}><option value="">选择模型</option>{options.map(x=><option value={x.id} key={x.id}>{x.connection.name} · {x.model.name}</option>)}</select></label>{chosen&&<small>{chosen.model.id} · {chosen.model.testedAt?'最近测试通过':'尚未测试'} · 从下一次提问生效</small>}<button className="text-button" onClick={ai.openSettings}>管理 API 与模型<ArrowRight size={12}/></button></div>
 <div className="ai-scope"><button onClick={()=>setScopeOpen(!scopeOpen)} aria-expanded={scopeOpen}><span><Layers size={15}/>本次发送：{selected.length} 个来源</span><span>查看范围</span></button>{scopeOpen&&<div className="ai-scope-detail"><p>仅选中的正文与片段发送给当前服务。对话会包含同一范围下最近两轮问答；更改范围后不再发送旧对话。</p><div className="ai-local-search"><Search size={13}/><input value={query} onChange={e=>setQuery(e.target.value)} placeholder="在此空间按关键词找来源" aria-label="查找 AI 来源"/></div><div className="ai-source-options">{candidates.map(s=><div key={s.id}><label><input type="checkbox" checked={scope.has(s.id)} disabled={busy} onChange={e=>setScope(old=>{const next=new Set(old);e.target.checked?next.add(s.id):next.delete(s.id);return next;})}/><span>{s.title}<small>{s.kind} · {s.locator}</small></span></label><button className="text-button" onClick={()=>setCitation(s)}>预览</button></div>)}</div>{!candidates.length&&<small>没有可读材料。可以先记录想法，或到文件与链接补齐正文。</small>}</div>}</div>
 <div className="ai-mode-tabs">{[['chat','对话'],['summary','总结'],['analysis','分析']].map(([id,label])=><button key={id} className={mode===id?'selected':''} disabled={busy} onClick={()=>setMode(id as AIMode)}>{label}</button>)}</div>
 <div className="ai-panel-content" aria-live="polite">{!options.length&&<div className="ai-no-config"><h3>使用你自己的 AI 模型</h3><p>先填写本地 API 连接，再选择常用模型。记录和保存可以照常使用。</p><button className="primary" onClick={ai.openSettings}>配置 AI 连接<ArrowRight size={14}/></button></div>}{!history.length&&options.length>0&&<><h3>{ai.target.kind==='draft'?'这个想法里，你还想弄清楚什么？':'带着自己的问题，继续思考'}</h3><p>{selected.length?'AI 结果首先是草稿，可以修改后再收录。':'先选择资料范围。没有读到正文时，不生成冒充全文阅读的总结。'}</p>{['总结核心观点与出处','分析论点、证据与边界',ai.page==='review'?'问我一个能检验理解的问题':'帮我追问一个关键问题'].map(p=><button className="ai-prompt" key={p} disabled={!chosen||!selected.length||busy||(chunks.length>1&&!allowLong)} onClick={()=>{setMode(p.startsWith('总结')?'summary':p.startsWith('分析')?'analysis':'chat');void run(p,p.startsWith('总结')?'summary':p.startsWith('分析')?'analysis':'chat');}}>{p}<ArrowRight size={13}/></button>)}</>}
 {history.map(message=><div key={message.id} className={'ai-message ai-'+message.role}>{message.role==='user'?<p>{message.text}</p>:<><div className="ai-message-meta"><span>AI 辅助结果</span><span title={message.model||'服务未确认底层版本'}>{message.requestedModel}</span></div><Answer message={message} onCitation={setCitation}/>{!message.text&&!message.error&&<p>正在阅读与思考…</p>}{message.error&&<p className="ai-status">{message.error}</p>}{message.text&&<><small className="ai-result-meta">{message.sources.length} 个来源 · {message.model?'响应版本 '+message.model:'底层版本未确认'}{message.truncated?' · 输出截断':!message.complete?' · 未完成':''}{(message.sources.length!==selected.length||message.sources.some(s=>!scope.has(s.id)||pool.find(x=>x.id===s.id)?.text!==s.text))?' · 范围或来源已改变，此结果依据旧内容':''}</small><div className="ai-result-actions"><button className="text-button" onClick={()=>void navigator.clipboard.writeText(message.text).then(()=>notify('已复制分析。')).catch(()=>notify('可以选中结果后复制。'))}><Copy size={13}/>复制</button><button className="quiet-button" disabled={busy||!targetWritable} onClick={()=>{setAdopt(message);setAdoptText(message.text);setAdoptKind(targetItem?'reply':'note');}}>编辑并收录<ArrowRight size={13}/></button></div></>}</>}</div>)}
 </div><div className="ai-panel-input">{chunks.length>1&&<label className="ai-long-consent"><input type="checkbox" checked={allowLong} disabled={busy} onChange={e=>setAllowLong(e.target.checked)}/>允许分段阅读，预计 {chunks.length+1} 次请求，费用由服务计收</label>}{status&&<p className="ai-status" role="status">{status}</p>}<textarea value={question} disabled={busy} aria-label="向 AI 提问" onChange={e=>setQuestion(e.target.value)} placeholder="带着自己的问题，继续思考…" onKeyDown={e=>{if((e.ctrlKey||e.metaKey)&&e.key==='Enter'){e.preventDefault();void run(question);}}}/><div>{busy?<><small>请求在此浏览器运行</small><button className="quiet-button" onClick={()=>controller.current?.abort()}>停止</button></>:<><small>{chars.toLocaleString()} 字符 · 浏览器直连</small><button className="primary" disabled={!chosen||!selected.length||(chunks.length>1&&!allowLong)} onClick={()=>void run(question)}>发送<ArrowRight size={14}/></button></>}</div>{question.trim()&&<button className="text-button" disabled={busy} onClick={()=>{setQuery(question);setScopeOpen(true);setStatus('已在本浏览器查找候选来源，请勾选后再发送。');}}>先从知识库查找相关记录</button>}</div>
 </>}</aside>
 {citation&&<div className="ai-dialog"><Overlay title="回到来源" onClose={()=>setCitation(null)}><div className="ai-dialog-body"><small>{citation.title} · {citation.locator}</small><div className="ai-source-preview"><Body text={citation.text}/></div><p>这里是本次提供的来源正文；编号引用不代表模型的推断已经验证。</p></div></Overlay></div>}
 {adopt&&<div className="ai-dialog"><Overlay title="把有用的结论，留在知识里" onClose={()=>setAdopt(null)}><div className="ai-dialog-body"><p>编辑后确认收录。原始记录保持完整，AI 来源、引用片段与模型归因一并保存；未存档材料会保存本次选中的正文以便回看。</p>{(!adopt.complete||adopt.truncated)&&<p className="ai-status">这是未完成或截断的结果，请核对后再收录。</p>}<label>收录方式<select value={adoptKind} onChange={e=>setAdoptKind(e.target.value)}>{targetItem&&<option value="reply">作为当前记录的 AI 辅助补充</option>}<option value="note">新建知识记录</option><option value="experience">提炼为经验 · 待验证</option></select></label><textarea value={adoptText} onChange={e=>setAdoptText(e.target.value)} aria-label="待收录的 AI 内容" rows={10}/><div className="ai-dialog-actions"><small>{targetItem&&adoptKind==='reply'?'当前记录':space?'当前团队空间':'个人知识空间'} · 收录前可修改</small><button className="primary" disabled={!adoptText.trim()||saving} onClick={()=>void commit()}>确认收录<Check size={14}/></button></div></div></Overlay></div>}
 </>;
}
