import type { AISource } from "./types";
import { AIError } from "./client";
export function readableHTML(html:string) {
  const doc=new DOMParser().parseFromString(html,'text/html');
  doc.querySelectorAll('script,style,noscript,nav,header,footer,iframe,form,button,svg').forEach(el=>el.remove());
  const root=doc.querySelector('article')||doc.querySelector('main')||doc.body;
  root.querySelectorAll('p,h1,h2,h3,h4,li,section,div,br').forEach(el=>el.append(doc.createTextNode('\n')));
  return {title:doc.title||doc.querySelector('h1')?.textContent||'网页材料',text:(root.textContent||'').replace(/[ \t]+/g,' ').replace(/\n\s*\n\s*\n/g,'\n\n').trim()};
}
export async function readLink(raw:string,signal:AbortSignal):Promise<AISource[]> {
  let url:URL;try{url=new URL(raw);}catch{throw new AIError('输入完整的网页链接。');}
  if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw new AIError('仅支持不含账号密码的 http 或 https 来源链接。');
  // This request never uses an AI connection or its authorization headers.
  let response:Response;
  try{response=await fetch(url.href,{signal,credentials:'omit',redirect:'follow',referrerPolicy:'no-referrer'});}catch{if(signal.aborted)throw new DOMException('已取消','AbortError');throw new AIError('尚未读到网页正文。网页可能限制跨域读取或需要登录；可以粘贴正文或上传网页/PDF。');}
  if(!response.ok)throw new AIError('尚未取得可读正文（HTTP '+response.status+'）。请粘贴正文或上传文件。');
  const type=response.headers.get('content-type')||'';
  if(!type.includes('text/html')&&!type.includes('text/plain'))throw new AIError('此链接没有返回网页文本，可以下载文件后在本地读取。');
  const reader=response.body?.getReader();if(!reader)throw new AIError('网页没有返回正文。');
  const chunks:Uint8Array[]=[];let size=0;
  try{while(true){const {value,done}=await reader.read();if(done)break;size+=value.length;if(size>4*1024*1024)throw new AIError('网页过大，请粘贴需要阅读的正文。');chunks.push(value);}}finally{await reader.cancel().catch(()=>{});}
  const buffer=new Uint8Array(size);let offset=0;for(const chunk of chunks){buffer.set(chunk,offset);offset+=chunk.length;}
  const content=new TextDecoder().decode(buffer);const value=type.includes('text/html') ? readableHTML(content) : {title:url.hostname,text:content.trim()};
  if(value.text.length<80)throw new AIError('只取得少量文字，尚不足以判断已读到文章正文。请检查并补充正文。');
  return [{id:'web-'+crypto.randomUUID(),title:value.title,text:value.text,kind:'网页正文',locator:'已提取正文，请先预览',url:url.href}];
}
export async function readFile(file:File,signal:AbortSignal,onProgress?:(text:string)=>void):Promise<AISource[]> {
  if(file.size>20*1024*1024)throw new AIError('本地读取目前支持 20 MB 以内的文件。');
  if(signal.aborted)throw new DOMException('已取消','AbortError');
  const id='file-'+crypto.randomUUID();const extension=file.name.split('.').pop()?.toLowerCase();
  const source=(text:string,locator:string):AISource=>({id:id+'-'+locator,title:file.name,text,kind:'本地文件',locator});
  if(extension==='pdf') {
    const pdfjs=await import('pdfjs-dist');
    const worker=await import('pdfjs-dist/build/pdf.worker.min.mjs?url');
    pdfjs.GlobalWorkerOptions.workerSrc=worker.default;
    const task=pdfjs.getDocument({data:new Uint8Array(await file.arrayBuffer()),cMapUrl:'/pdfjs/cmaps/',cMapPacked:true,standardFontDataUrl:'/pdfjs/standard_fonts/'});
    const abort=()=>{void task.destroy();};signal.addEventListener('abort',abort,{once:true});
    try {
      const pdf=await task.promise;const pages:AISource[]=[];let scanned=0;
      if(pdf.numPages>300)throw new AIError('文件超过 300 页，请先拆分或只导入需要的章节。');
      for(let n=1;n<=pdf.numPages;n++) {
        if(signal.aborted)throw new DOMException('已取消','AbortError');onProgress?.('正在提取 '+n+' / '+pdf.numPages+' 页');
        const page=await pdf.getPage(n);const content=await page.getTextContent();
        const text=content.items.map(item=>'str' in item ? item.str+('hasEOL' in item&&item.hasEOL ? '\n':' ') : '').join('').trim();
        if(text)pages.push(source(text,'第 '+n+' 页'));else scanned++;
        page.cleanup();
      }
      if(!pages.length)throw new AIError('没有提取到文字，可能是扫描件。请先 OCR 或粘贴可读文本。');
      if(scanned)onProgress?.('已提取 '+pages.length+' / '+pdf.numPages+' 页；'+scanned+' 页没有文字，未完整读取');else onProgress?.('已提取 '+pdf.numPages+' / '+pdf.numPages+' 页文字');
      return pages;
    } finally {signal.removeEventListener('abort',abort);await task.destroy();}
  }
  if(extension==='docx') {
    const mammoth=await import('mammoth/mammoth.browser');
    const value=await mammoth.extractRawText({arrayBuffer:await file.arrayBuffer()});
    if(!value.value.trim())throw new AIError('DOCX 未取得可读文字。');
    if(signal.aborted)throw new DOMException('已取消','AbortError');
    onProgress?.(value.messages.length?'正文已提取；文档解析存在提示，请核对预览':'DOCX 正文已提取');
    return [source(value.value,'文档正文；不包含可靠页码')];
  }
  if(!['txt','md','markdown','csv','json','html','htm'].includes(extension||''))throw new AIError('支持 TXT、Markdown、CSV、JSON、HTML、文字 PDF 和 DOCX。图片或扫描件请先提供文字。');
  const value=await file.text();const text=['html','htm'].includes(extension||'') ? readableHTML(value).text : value;
  if(!text.trim())throw new AIError('文件没有可读文本。');
  if(signal.aborted)throw new DOMException('已取消','AbortError');onProgress?.('文字已在浏览器内提取');return [source(text,'文件正文')];
}
