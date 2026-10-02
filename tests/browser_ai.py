"""Real browser/client integration against a local protocol fixture, not cloud AI."""
from pathlib import Path
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
import os,tempfile,subprocess,socket,time,json,threading,urllib.request,sqlite3,io,zipfile
from playwright.sync_api import sync_playwright,expect
ROOT=Path(__file__).resolve().parents[1]
OUT=ROOT/'test-results/ai';OUT.mkdir(parents=True,exist_ok=True)
SECRET='only-browser-sentinel-key'
provider_calls=[]
class Provider(BaseHTTPRequestHandler):
 def log_message(self,*args):pass
 def headers_for(self,status=200,mime='application/json'):
  self.send_response(status);self.send_header('Content-Type',mime);self.send_header('Access-Control-Allow-Origin','*');self.send_header('Access-Control-Allow-Headers','Content-Type,Authorization,x-api-key,anthropic-version,anthropic-dangerous-direct-browser-access');self.send_header('Access-Control-Allow-Methods','GET,POST,OPTIONS');self.end_headers()
 def do_OPTIONS(self):self.headers_for(204)
 def do_GET(self):
  provider_calls.append({'method':'GET','path':self.path,'authorization':self.headers.get('Authorization'),'key':self.headers.get('x-api-key')})
  self.headers_for();self.wfile.write(json.dumps({'data':[{'id':'fixed-alpha-20261001'},{'id':'fixed-beta-20261002'}],'has_more':False}).encode())
 def do_POST(self):
  body=json.loads(self.rfile.read(int(self.headers['Content-Length'])))
  provider_calls.append({'method':'POST','path':self.path,'body':body,'authorization':self.headers.get('Authorization'),'key':self.headers.get('x-api-key')})
  model=body['model'];text='## 核心发现\n这是测试服务根据选定材料返回的回答 [S1]。\n'+SECRET
  if model=='missing-model':self.headers_for(404);self.wfile.write(b'{"error":"unknown model"}');return
  if not body.get('stream'):
   self.headers_for()
   if self.path.endswith('/messages'):value={'model':model,'content':[{'type':'text','text':'OK'}],'stop_reason':'end_turn'}
   elif self.path.endswith('/responses'):value={'model':model,'status':'completed','output':[{'content':[{'type':'output_text','text':'OK'}]}]}
   else:value={'model':model,'choices':[{'message':{'content':'OK'},'finish_reason':'stop'}]}
   self.wfile.write(json.dumps(value).encode());return
  self.headers_for(mime='text/event-stream')
  if self.path.endswith('/messages'):events=[{'type':'message_start','message':{'model':model}},{'type':'content_block_delta','delta':{'type':'text_delta','text':text}},{'type':'message_delta','delta':{'stop_reason':'end_turn'}}]
  elif self.path.endswith('/responses'):events=[{'type':'response.output_text.delta','delta':text},{'type':'response.completed','response':{'model':model}}]
  else:events=[{'model':model,'choices':[{'delta':{'content':text},'finish_reason':None}]},{'choices':[{'delta':{},'finish_reason':'stop'}]}]
  try:
   for event in events:self.wfile.write(('data: '+json.dumps(event,ensure_ascii=False)+'\n\n').encode());self.wfile.flush()
  except BrokenPipeError:pass

def port():
 with socket.socket() as s:s.bind(('127.0.0.1',0));return s.getsockname()[1]
with tempfile.TemporaryDirectory() as storage:
 app_port=port();url=f'http://127.0.0.1:{app_port}'
 provider=ThreadingHTTPServer(('127.0.0.1',0),Provider);ai_url=f'http://127.0.0.1:{provider.server_port}/custom/v1'
 threading.Thread(target=provider.serve_forever,daemon=True).start()
 server=subprocess.Popen(['python',str(ROOT/'server/app.py')],env={**os.environ,'SEDIMENT_STORAGE':storage,'SEDIMENT_PORT':str(app_port),'SEDIMENT_QUIET':'1'},stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
 try:
  for _ in range(50):
   try:urllib.request.urlopen(url+'/api/state');break
   except Exception:time.sleep(.05)
  with sync_playwright() as p:
   browser=p.chromium.launch(executable_path=os.environ.get('SEDIMENT_CHROMIUM','/usr/bin/chromium'),headless=True,args=['--no-sandbox'])
   context=browser.new_context(viewport={'width':1440,'height':1000})
   page=context.new_page();page.set_default_timeout(10000);errors=[];system_requests=[]
   page.on('pageerror',lambda e:errors.append(str(e)))
   page.on('request',lambda r:system_requests.append({'url':r.url,'headers':r.headers,'body':r.post_data or ''}) if r.url.startswith(url+'/api/') else None)
   page.goto(url,wait_until='networkidle')
   assert page.request.get(url+'/api/state').json()['items']==[]
   page.locator('#quick-note').fill('记录验证：阅读材料时，需要保留自己的疑问。')
   page.get_by_role('button',name='记下来',exact=True).click()
   expect(page.locator('.note-open')).to_contain_text('记录验证')
   page.get_by_role('button',name='偏好设置',exact=True).click()
   page.get_by_role('button',name='AI 与模型',exact=True).click()
   expect(page.locator('.ai-local-notice')).to_contain_text('不会上传到本系统服务器或数据库')
   page.get_by_label('API 根地址',exact=True).fill(ai_url)
   page.get_by_label('AI API Key').fill(SECRET)
   page.get_by_role('button',name='探测模型',exact=True).click()
   expect(page.locator('.ai-model-row')).to_have_count(2)
   for model in ['fixed-alpha-20261001','fixed-beta-20261002']:page.get_by_label('启用模型 '+model).check()
   page.locator('.ai-model-row').first.get_by_role('button',name='测试调用').click()
   expect(page.locator('.ai-model-status').first).to_have_text('测试通过')
   page.get_by_role('button',name='保存到此浏览器',exact=True).click()
   state=page.request.get(url+'/api/state').json();owner=state['me']['owner_id'];assert 'apiKey' not in state['preferences']
   assert SECRET in page.evaluate('localStorage.getItem('+json.dumps('sediment-ai:v1:'+owner)+')')
   page.reload(wait_until='networkidle')
   page.get_by_role('button',name='偏好设置',exact=True).click();page.get_by_role('button',name='AI 与模型',exact=True).click()
   expect(page.get_by_label('AI API Key')).to_have_value(SECRET)
   page.screenshot(path=str(OUT/'设置-浅色.png'),full_page=True)
   page.get_by_role('button',name='我的书桌',exact=True).click();page.locator('.note-open').first.click()
   page.get_by_role('button',name='AI 分析',exact=True).click()
   expect(page.locator('.ai-panel')).to_be_visible()
   expect(page.locator('.ai-scope')).to_contain_text('1 个来源')
   page.get_by_label('向 AI 提问').fill('OLD_QUESTION_ONLY：帮我梳理原来的判断。')
   page.get_by_role('button',name='发送',exact=True).click()
   expect(page.locator('.ai-answer')).to_contain_text('核心发现')
   expect(page.locator('.ai-answer')).to_contain_text('[已隐藏凭据]')
   assert SECRET not in page.locator('.ai-answer').inner_text()
   page.get_by_role('button',name='查看来源 1',exact=True).click()
   expect(page.get_by_role('dialog',name='回到来源')).to_contain_text('自己的疑问')
   page.get_by_role('dialog',name='回到来源').get_by_role('button',name='关闭',exact=True).click()
   page.get_by_label('本次 AI 模型').select_option(label='我的 OpenAI · fixed-beta-20261002')
   expect(page.locator('.ai-message-meta')).to_contain_text('fixed-alpha-20261001')
   page.get_by_role('button',name='编辑并收录',exact=True).click()
   page.get_by_label('待收录的 AI 内容').fill('经过我确认：记录时要留下当时的疑问与出处。')
   page.get_by_role('button',name='确认收录',exact=True).click()
   expect(page.locator('.reply')).to_contain_text('经过我确认')
   state=page.request.get(url+'/api/state').json();saved=state['replies'][0]
   assert saved['ai']['requested_model']=='fixed-alpha-20261001'
   assert SECRET not in json.dumps(saved)
   expect(page.locator('.ai-origin')).to_contain_text('经用户收录')
   page.get_by_role('button',name='切换到深色',exact=True).click()
   page.screenshot(path=str(OUT/'阅读与AI-深色.png'),full_page=False)
   page.locator('.ai-mode-tabs').get_by_role('button',name='对话',exact=True).click()
   page.locator('.ai-scope>button').click()
   page.locator('.ai-source-options input[type=checkbox]').first.uncheck()
   page.locator('.ai-source-options input[type=checkbox]').last.check()
   page.get_by_label('向 AI 提问').fill('NEW_QUESTION_ONLY：现在只看这条补充。')
   page.get_by_role('button',name='发送',exact=True).click()
   expect(page.locator('.ai-answer')).to_have_count(2)
   expect(page.locator('.ai-answer').last).to_contain_text('核心发现')
   last=[c for c in provider_calls if c['method']=='POST'][-1]
   assert 'OLD_QUESTION_ONLY' not in json.dumps(last['body'])
   page.get_by_role('button',name='关闭 AI 助手',exact=True).click();page.keyboard.press('Escape')
   page.get_by_role('button',name='文件与链接',exact=True).click()
   page.get_by_role('button',name='上传文件',exact=True).click()
   previous_files=sum(r['url'].endswith('/api/files') for r in system_requests)
   page.get_by_label('选择阅读文件').set_input_files({'name':'阅读验证.txt','mimeType':'text/plain','buffer':'本地文件验证：摘要帮助定位材料，自己的理解需要另写。'.encode()})
   expect(page.locator('.ai-extracted')).to_contain_text('本地文件验证')
   assert sum(r['url'].endswith('/api/files') for r in system_requests)==previous_files
   page.get_by_role('button',name='发送',exact=True).click();expect(page.locator('.ai-answer')).to_contain_text('核心发现')
   page.get_by_role('button',name='关闭 AI 助手',exact=True).click()
   page.get_by_role('button',name='保存来源',exact=True).click();expect(page.locator('.record-body')).to_contain_text('本地文件验证')
   page.keyboard.press('Escape')
   # Actual browser PDF worker, DOCX ZIP and inert HTML extraction.
   page.get_by_role('button',name='文件与链接',exact=True).click()
   page.get_by_role('button',name='上传文件',exact=True).click()
   stream=b'BT /F1 12 Tf 50 750 Td (PDF local fixture with page citation.) Tj ET'
   objects=[b'<< /Type /Catalog /Pages 2 0 R >>',b'<< /Type /Pages /Kids [3 0 R] /Count 1 >>',b'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',b'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',b'<< /Length '+str(len(stream)).encode()+b' >>\nstream\n'+stream+b'\nendstream']
   pdf=b'%PDF-1.4\n';offsets=[]
   for i,obj in enumerate(objects,1):offsets.append(len(pdf));pdf+=str(i).encode()+b' 0 obj\n'+obj+b'\nendobj\n'
   start=len(pdf);pdf+=b'xref\n0 6\n0000000000 65535 f \n'+b''.join(f'{n:010d} 00000 n \n'.encode() for n in offsets)+b'trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n'+str(start).encode()+b'\n%%EOF'
   page.get_by_label('选择阅读文件').set_input_files({'name':'example.pdf','mimeType':'application/pdf','buffer':pdf})
   expect(page.locator('.ai-extracted')).to_contain_text('PDF local fixture')
   expect(page.locator('.ai-extracted')).to_contain_text('第 1 页')
   page.get_by_role('button',name='关闭 AI 助手',exact=True).click()
   buffer=io.BytesIO()
   with zipfile.ZipFile(buffer,'w') as z:
    z.writestr('[Content_Types].xml','<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>')
    z.writestr('_rels/.rels','<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>')
    z.writestr('word/document.xml','<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>DOCX 提取验证：保留自己的理解。</w:t></w:r></w:p></w:body></w:document>')
   page.get_by_label('选择阅读文件').set_input_files({'name':'example.docx','mimeType':'application/vnd.openxmlformats-officedocument.wordprocessingml.document','buffer':buffer.getvalue()})
   expect(page.locator('.ai-extracted')).to_contain_text('DOCX 提取验证')
   page.get_by_role('button',name='关闭 AI 助手',exact=True).click()
   page.get_by_label('选择阅读文件').set_input_files({'name':'example.html','mimeType':'text/html','buffer':b'<script>window.HTML_SCRIPT_RAN=true</script><article><h1>HTML fixture</h1><p>Content stays inert.</p></article>'})
   expect(page.locator('.ai-extracted')).to_contain_text('Content stays inert')
   assert page.evaluate('window.HTML_SCRIPT_RAN') is None
   page.get_by_role('button',name='关闭 AI 助手',exact=True).click()
   page.get_by_label('选择阅读文件').set_input_files({'name':'long.txt','mimeType':'text/plain','buffer':('长文测试来源。'*4000).encode()})
   expect(page.locator('.ai-extracted')).to_contain_text('long.txt')
   expect(page.get_by_role('button',name='发送',exact=True)).to_be_disabled()
   page.get_by_label('允许分段阅读',exact=False).check()
   count=len([c for c in provider_calls if c['method']=='POST'])
   page.get_by_role('button',name='发送',exact=True).click();expect(page.locator('.ai-answer')).to_contain_text('核心发现')
   assert len([c for c in provider_calls if c['method']=='POST'])==count+3
   page.get_by_role('button',name='关闭 AI 助手',exact=True).click()
   page.get_by_role('button',name='偏好设置',exact=True).click();page.get_by_role('button',name='AI 与模型',exact=True).click()
   page.get_by_role('button',name='添加 Anthropic 连接',exact=True).click()
   page.get_by_label('API 根地址',exact=True).fill(ai_url.replace('custom','anthropic'))
   page.get_by_label('AI API Key').fill(SECRET)
   page.get_by_role('button',name='探测模型',exact=True).click();expect(page.locator('.ai-model-row')).to_have_count(2)
   page.get_by_label('启用模型 fixed-beta-20261002').check()
   page.locator('.ai-advanced summary').click();page.get_by_label('密钥保存方式').select_option('session')
   page.get_by_role('button',name='保存到此浏览器',exact=True).click()
   local=json.loads(page.evaluate('localStorage.getItem('+json.dumps('sediment-ai:v1:'+owner)+')'))
   assert next(c for c in local['connections'] if c['protocol']=='anthropic')['key']==''
   page.get_by_role('button',name='我的书桌',exact=True).click();page.locator('#quick-note').fill('草稿验证：只讨论这次的思考。')
   page.get_by_role('button',name='接着想',exact=True).click()
   page.get_by_label('本次 AI 模型').select_option(label='我的 Anthropic · fixed-beta-20261002')
   page.get_by_role('button',name='发送',exact=True).click();expect(page.locator('.ai-answer')).to_contain_text('核心发现')
   anthropic=[c for c in provider_calls if c['method']=='POST' and c['path'].endswith('/messages')][-1]
   assert anthropic['key']==SECRET and not anthropic['authorization']
   assert '草稿验证' in json.dumps(anthropic['body'],ensure_ascii=False)
   assert '记录验证' not in json.dumps(anthropic['body'],ensure_ascii=False)
   for width in [390,320]:
    page.set_viewport_size({'width':width,'height':844});expect(page.get_by_role('group',name='深浅色切换')).to_be_visible()
    assert page.evaluate('document.documentElement.scrollWidth<=innerWidth'),('AI panel overflow',width)
    page.get_by_role('button',name='切换到浅色',exact=True).click();page.screenshot(path=str(OUT/f'手机AI-{width}.png'),full_page=False)
   page.get_by_role('button',name='关闭 AI 助手',exact=True).click()
   page.get_by_role('button',name='打开导航',exact=True).click();page.get_by_role('button',name='偏好设置',exact=True).click();page.get_by_role('button',name='AI 与模型',exact=True).click()
   assert page.evaluate('document.documentElement.scrollWidth<=innerWidth'),'AI settings overflow'
   page.screenshot(path=str(OUT/'手机设置.png'),full_page=True)
   assert not errors,errors
   assert all(SECRET not in json.dumps(r) for r in system_requests),'key reached system request'
   export=page.request.get(url+'/api/export').text();assert SECRET not in export
   db=sqlite3.connect(Path(storage)/'workspace.sqlite3');dump='\n'.join(db.iterdump());db.close();assert SECRET not in dump,'key reached database'
   # A distinct account has no inherited connection, and remains independent.
   page.request.post(url+'/api/register',data={'email':'owner@example.test','password':'owner-password','display_name':'演示所有者'})
   page.reload(wait_until='networkidle');page.get_by_role('button',name='打开导航',exact=True).click();page.get_by_role('button',name='偏好设置',exact=True).click();page.get_by_role('button',name='AI 与模型',exact=True).click()
   page.get_by_role('button',name='账号与空间',exact=True).click()
   page.get_by_role('button',name='退出登录',exact=True).click()
   page.get_by_role('button',name='没有账号，创建一个个人空间',exact=True).click()
   page.get_by_label('邮箱').fill('another@example.test');page.get_by_label('密码').fill('another-password');page.get_by_label('显示名').fill('另一个演示用户')
   page.get_by_role('button',name='创建账号',exact=True).click()
   page.get_by_role('button',name='打开导航',exact=True).click();page.get_by_role('button',name='偏好设置',exact=True).click();page.get_by_role('button',name='AI 与模型',exact=True).click()
   expect(page.get_by_label('AI API Key')).to_have_value('')
   browser.close()
   (OUT/'结果.json').write_text(json.dumps({'browser_errors':errors,'system_key_leak':False,'database_key_leak':False,'cloud_provider_verified':False,'provider_fixture_requests':len(provider_calls),'coverage':['OpenAI Responses','Anthropic Messages','models discovery and test','local/session storage','model switching and attribution','citations and edited adoption','TXT/PDF/DOCX/inert HTML parse before upload','long document explicit multi-request flow','mobile 320/390','account isolation']},ensure_ascii=False,indent=2))
   print('AI browser, protocol fixture, storage/network/database privacy checks passed')
 finally:
  server.terminate();server.wait(timeout=5);provider.shutdown()
