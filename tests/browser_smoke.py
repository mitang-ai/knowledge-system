"""Optional browser verification; uses a temporary database, never the working copy."""
from pathlib import Path
import os, tempfile, subprocess, socket, time, urllib.request, json, re
from playwright.sync_api import sync_playwright, expect

root = Path(__file__).resolve().parents[1]
out = root / 'test-results'
out.mkdir(exist_ok=True)

with tempfile.TemporaryDirectory() as temp:
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0)); port = sock.getsockname()[1]
    url = f'http://127.0.0.1:{port}'
    server = subprocess.Popen(['python', str(root / 'server/app.py')], env={**os.environ, 'SEDIMENT_STORAGE': temp, 'SEDIMENT_PORT': str(port), 'SEDIMENT_QUIET': '1'}, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        for _ in range(50):
            try: urllib.request.urlopen(url + '/api/state'); break
            except Exception: time.sleep(.05)
        with sync_playwright() as p:
            browser = p.chromium.launch(executable_path=os.environ.get('SEDIMENT_CHROMIUM', '/usr/bin/chromium'), headless=True, args=['--no-sandbox'])
            page = browser.new_page(viewport={'width':1440,'height':1000}, timezone_id='America/Los_Angeles')
            errors = []; failed = []
            page.on('pageerror', lambda e: errors.append(str(e)))
            page.on('response', lambda r: failed.append((r.status,r.url)) if r.status>=400 and '/api/' in r.url else None)
            # Synthetic fixtures are generated in this temporary database only.
            client=browser.new_context().request
            for ident,title,kind,topics in [('smoke-topic','演示主题','topic',[]),('smoke-note','演示回顾记录','note',['smoke-topic'])]:
                result=client.post(url+'/api/items',data={'id':ident,'title':title,'body':'仅用于自动检查的合成内容。','type':kind,'topic_ids':topics,'atts':[]})
                assert result.status==200
            page.goto(url, wait_until='networkidle')
            expect(page.get_by_role('heading',name='我的知识空间',exact=True)).to_be_visible()
            # Complete draft survives a reload.
            page.locator('#quick-note').fill('测试草稿：先留下一个念头。')
            page.reload(wait_until='networkidle')
            expect(page.locator('#quick-note')).to_have_value('测试草稿：先留下一个念头。')
            page.locator('#quick-note').fill('浏览器验证记录：可恢复的知识。\nhttps://example.com/source')
            page.locator('.composer input[type=file]').set_input_files({'name':'evidence.txt','mimeType':'text/plain','buffer':b'knowledge attachment'})
            expect(page.locator('.attachment-chips')).to_contain_text('evidence.txt')
            page.get_by_role('button',name='关联主题',exact=True).click()
            page.locator('.topic-popover label').first.click()
            page.locator('.topic-popover').get_by_role('button',name='完成').click()
            with page.expect_response(lambda r: '/api/items' in r.url and r.request.method=='POST') as result:
                page.get_by_role('button',name='记下来',exact=True).click()
            assert result.value.status == 200
            record = result.value.json()
            page.locator('.note-open').filter(has_text='浏览器验证记录').click()
            page.locator('#reply-input').fill('现在的理解：知识需要上下文和可恢复的历史。')
            with page.expect_response(lambda r: '/api/replies' in r.url and r.request.method=='POST') as result:
                page.get_by_role('button',name='保存补充',exact=True).click()
            assert result.value.status == 200
            page.get_by_role('button',name='设为当前理解',exact=True).click()
            expect(page.locator('.current-understanding')).to_contain_text('知识需要上下文')
            page.get_by_role('button',name='编辑记录',exact=True).click()
            page.locator('.edit-record textarea').fill(record['body']+'\n补充一次正文编辑。')
            page.get_by_role('button',name='保存修改',exact=True).click()
            expect(page.locator('.record-body')).to_contain_text('补充一次正文编辑')
            page.get_by_role('button',name='版本历史',exact=True).click()
            expect(page.locator('.version-list')).to_contain_text('编辑历史')
            response=page.request.get(url+'/api/files/'+record['atts'][0]['id'])
            assert response.status == 200 and response.body()==b'knowledge attachment'
            page.locator('.detail-export summary').click()
            with page.expect_download() as downloaded:
                page.get_by_role('button',name='Markdown · 完整内容').click()
            exported=Path(downloaded.value.path()).read_text()
            assert '当前理解' in exported and '知识需要上下文' in exported and 'evidence.txt' in exported
            page.keyboard.press('Escape')
            page.keyboard.press('Control+k')
            page.get_by_role('textbox',name='全局搜索关键词').fill('知识需要上下文')
            expect(page.locator('.search-results')).to_contain_text('命中补充')
            page.keyboard.press('Escape')
            page.locator('.note-open').filter(has_text='浏览器验证记录').click()
            page.get_by_role('button',name='移入回收站',exact=True).click()
            page.get_by_role('button',name='确认操作',exact=True).click()
            expect(page.locator('.note-open').filter(has_text='浏览器验证记录')).to_have_count(0)
            page.get_by_role('button',name='管理工作台',exact=True).click()
            page.get_by_role('button',name=re.compile('^回收站')).click()
            trash=page.locator('.trash-list>div').filter(has_text='浏览器验证记录')
            trash.get_by_role('button',name='恢复',exact=True).click()
            expect(trash).to_have_count(0)
            page.get_by_role('button',name='偏好设置',exact=True).click()
            expect(page.locator('.font-option')).to_have_count(10)
            page.get_by_role('button',name='思源宋体').click()
            page.get_by_role('spinbutton',name='正文字号数值').fill('20')
            page.wait_for_timeout(200)
            page.reload(wait_until='networkidle')
            prefs=page.request.get(url+'/api/state').json()['preferences']
            assert prefs['font']=='noto-serif-sc' and prefs['size']==20
            page.get_by_role('button',name='偏好设置',exact=True).click()
            page.get_by_role('button',name='外观',exact=True).click()
            page.get_by_role('button',name='深色',exact=True).click()
            expect(page.locator('html')).to_have_attribute('data-theme','dark')
            # Permanent theme control works over the reading dialog and preserves typography.
            page.get_by_role('button',name='切换到浅色',exact=True).click()
            page.get_by_role('button',name='全部知识',exact=True).click()
            page.locator('.note-open').first.click()
            expect(page.get_by_role('group',name='深浅色切换')).to_be_visible()
            with page.expect_response(lambda r: '/api/preferences' in r.url and r.request.method=='POST'):
                page.get_by_role('button',name='切换到深色',exact=True).click()
            expect(page.locator('html')).to_have_attribute('data-theme','dark')
            expect(page.get_by_role('button',name='切换到深色')).to_have_attribute('aria-pressed','true')
            colors=page.evaluate("[getComputedStyle(document.documentElement).backgroundColor, getComputedStyle(document.querySelector('.theme-toggle button[aria-pressed=true]')).color]")
            assert colors == ['rgb(25, 25, 25)', 'rgb(23, 23, 23)'], colors
            page.keyboard.press('Escape')
            page.reload(wait_until='networkidle')
            expect(page.locator('html')).to_have_attribute('data-theme','dark')
            prefs=page.request.get(url+'/api/state').json()['preferences']
            assert prefs['font']=='noto-serif-sc' and prefs['size']==20 and prefs['theme']=='dark'
            page.get_by_role('button',name='偏好设置',exact=True).click()
            page.get_by_role('button',name='外观',exact=True).click()
            # The segmented control also reflects a change in the operating system.
            with page.expect_response(lambda r: '/api/preferences' in r.url and r.request.method=='POST'):
                page.get_by_role('button',name='跟随系统',exact=True).click()
            page.emulate_media(color_scheme='dark')
            expect(page.get_by_role('button',name='切换到深色')).to_have_attribute('aria-pressed','true')
            assert page.evaluate('getComputedStyle(document.documentElement).backgroundColor') == 'rgb(25, 25, 25)'
            page.emulate_media(color_scheme='light')
            expect(page.get_by_role('button',name='切换到浅色')).to_have_attribute('aria-pressed','true')
            assert page.evaluate('getComputedStyle(document.documentElement).backgroundColor') == 'rgb(255, 255, 255)'
            page.get_by_role('button',name='恢复默认',exact=True).click()
            page.get_by_role('button',name='回顾',exact=True).click()
            with page.expect_response(lambda r: '/api/review' in r.url and r.request.method=='POST') as reviewed:
                page.get_by_role('button',name='已经掌握 · 30 天').click()
            assert reviewed.value.status == 200
            expect(page.locator('.review-session-count')).to_contain_text('1')
            page.set_viewport_size({'width':390,'height':844})
            for view in ['我的书桌','全部知识','主题空间','回顾','经验手册','偏好设置','管理工作台']:
                page.get_by_role('button',name='打开导航').click()
                page.get_by_role('button',name=view,exact=True).click()
                page.wait_for_timeout(250)
                assert not page.evaluate('document.documentElement.scrollWidth>innerWidth'), view+' overflow'
                expect(page.get_by_role('group',name='深浅色切换')).to_be_visible()
                page.get_by_role('button',name='切换到深色',exact=True).click()
                page.evaluate('window.scrollTo(0,document.body.scrollHeight)')
                rect=page.get_by_role('group',name='深浅色切换').bounding_box()
                assert rect and rect['y'] < 15 and rect['x']+rect['width'] <= 390, (view,rect)
                assert not page.evaluate('document.documentElement.scrollWidth>innerWidth'), view+' dark overflow'
                page.get_by_role('button',name='切换到浅色',exact=True).click()

            # Large user-selected typography must still fit a narrow phone.
            page.get_by_role('button',name='打开导航').click()
            page.get_by_role('button',name='偏好设置',exact=True).click()
            for label,value in [('正文字号数值','28'),('界面字号数值','18'),('页面标题数值','42')]:
                page.get_by_role('spinbutton',name=label,exact=True).fill(value)
                page.wait_for_timeout(100)
            page.set_viewport_size({'width':320,'height':740})
            for view in ['我的书桌','偏好设置']:
                page.get_by_role('button',name='打开导航').click()
                page.get_by_role('button',name=view,exact=True).click()
                assert not page.evaluate('document.documentElement.scrollWidth>innerWidth'), view+' large type overflow'
                expect(page.get_by_role('group',name='深浅色切换')).to_be_visible()
            assert not errors, errors
            assert not failed, failed
            # The logged-out page has the same permanent control, with no unauthorized preference write.
            response=page.request.post(url+'/api/register',data={'email':'visual@example.test','password':'test-password','display_name':'视觉验证'})
            assert response.status == 200, response.text()
            assert page.request.post(url+'/api/logout',data={}).status == 200
            login=browser.new_page(viewport={'width':390,'height':844})
            login_errors=[]
            login.on('pageerror',lambda e:login_errors.append(str(e)))
            login.goto(url,wait_until='networkidle')
            expect(login.get_by_role('heading',name='回到你的知识空间')).to_be_visible()
            writes=[]
            login.on('request',lambda r:writes.append(r.url) if '/api/preferences' in r.url else None)
            login.get_by_role('button',name='切换到深色').click()
            expect(login.locator('html')).to_have_attribute('data-theme','dark')
            login.reload(wait_until='networkidle')
            expect(login.locator('html')).to_have_attribute('data-theme','dark')
            assert not writes and not login_errors, (writes,login_errors)
            browser.close()
            print('PASS: draft, save, attachment, topic, reply, understanding, edit/history, export, reply search, trash/restore, saved typography, persistent global light/dark switch, system theme, personal review, seven mobile views in both themes; no browser errors or failed API calls.')
    finally:
        server.terminate();server.wait(timeout=5)
