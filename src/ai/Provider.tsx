import {useEffect,useState,type ReactNode} from 'react';
import {MessageSquare} from 'lucide-react';
import {useWorkspace} from '../workspace';
import {AIContext,useAI} from './context';
import {clearConfig,loadConfig,persistConfig} from './storage';
import {emptyConfig,type AIMode,type AISource,type AITarget} from './types';
import {AIPanel} from './Panel';
export function AIProvider({children,page,topicId,detailId,openSettings,returnToWork}:{children:ReactNode;page:string;topicId:string;detailId:string;openSettings:()=>void;returnToWork?:()=>void}) {
 const {ws,notify}=useWorkspace();
 const [config,setConfig]=useState(()=>loadConfig(ws.me.owner_id));
 const [isOpen,setOpen]=useState(false),[focus,setFocus]=useState<AITarget|null>(null),[initialMode,setMode]=useState<AIMode>('chat');
 const [draft,setDraft]=useState(''),[extraSources,setExtraSources]=useState<AISource[]>([]);
 useEffect(()=>{setFocus(null);},[page,topicId,detailId]);
 const target=focus||{title:detailId?'当前知识':page==='reading'?'文件与链接':page==='home'&&draft.trim()?'当前草稿':'当前页面',itemId:detailId||undefined,kind:page==='reading'?'reading':page==='home'&&draft.trim()?'draft':'page'};
 const value={config,updateConfig:(next:typeof config)=>{try{persistConfig(ws.me.owner_id,next);setConfig(next);notify('AI 配置已保存到此浏览器，不会同步到本系统。');}catch{setConfig(next);notify('浏览器阻止保存配置，本次可用；关闭后需重新填写。');}},clear:()=>{try{clearConfig(ws.me.owner_id);}catch{/* Active credentials are still cleared. */}setConfig(emptyConfig());notify('已清除当前账号在本浏览器的 AI 配置。');},isOpen,open:(target?:AITarget,mode:AIMode='chat')=>{setFocus(target||null);setMode(mode);setOpen(true);},close:()=>setOpen(false),openSettings,returnToWork,page,topicId,target,initialMode,draft,setDraft,extraSources,setExtraSources};
 return <AIContext.Provider value={value}><div className={isOpen?'ai-layout-open':'ai-layout'}>{children}</div><AIPanel/></AIContext.Provider>;
}
export function AITrigger({label='AI',target,mode}:{label?:string;target?:AITarget;mode?:AIMode}) {const ai=useAI();return <button className="quiet-button ai-trigger" onClick={()=>ai.open(target,mode)} aria-label={label==='AI'?'打开 AI 助手':label}><MessageSquare size={16}/>{label}</button>;}
