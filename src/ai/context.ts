import {createContext,useContext} from 'react';
import type {AIConfig,AIMode,AISource,AITarget} from './types';
export interface AIContextValue {
 config:AIConfig; updateConfig:(value:AIConfig)=>void; clear:()=>void;
 isOpen:boolean; open:(target?:AITarget,mode?:AIMode)=>void; close:()=>void; openSettings:()=>void;
 returnToWork?:()=>void; page:string; topicId:string; target:AITarget; initialMode:AIMode;
 draft:string; setDraft:(value:string)=>void; extraSources:AISource[]; setExtraSources:(sources:AISource[])=>void;
}
export const AIContext=createContext<AIContextValue>(null!);
export const useAI=()=>useContext(AIContext);
