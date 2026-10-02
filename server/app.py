"""Local, durable knowledge workspace. No access to the original cloud service."""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse, unquote
from datetime import datetime, timezone, timedelta
import sqlite3, json, os, uuid, threading, time, io, zipfile, hashlib, secrets, hmac
from http.cookies import SimpleCookie

ROOT = Path(__file__).resolve().parent
STORE = Path(os.environ.get('SEDIMENT_STORAGE', ROOT / 'storage'))
OWNER = os.environ.get('SEDIMENT_OWNER', '')
LOCK = threading.RLock()

def now():
    return datetime.now(timezone.utc).isoformat()

def connect():
    db = sqlite3.connect(STORE / 'workspace.sqlite3')
    db.row_factory = sqlite3.Row
    db.execute('PRAGMA foreign_keys=ON')
    return db

def initialize():
    global OWNER
    STORE.mkdir(parents=True, exist_ok=True)
    (STORE / 'files').mkdir(exist_ok=True)
    with connect() as db:
        db.executescript('''
        PRAGMA journal_mode=WAL;
        CREATE TABLE IF NOT EXISTS documents (id TEXT PRIMARY KEY, owner TEXT NOT NULL, kind TEXT NOT NULL, data TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS doc_owner ON documents(owner,kind);
        CREATE TABLE IF NOT EXISTS profiles (id TEXT PRIMARY KEY, data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS versions (id TEXT PRIMARY KEY, item_id TEXT NOT NULL, at TEXT NOT NULL, data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS backups (id TEXT PRIMARY KEY, at TEXT NOT NULL, data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS files (id TEXT PRIMARY KEY, name TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS accounts (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, password TEXT NOT NULL, salt TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, account TEXT NOT NULL, expires TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS spaces (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL, owner TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS members (space TEXT NOT NULL, account TEXT NOT NULL, role TEXT NOT NULL, PRIMARY KEY(space,account));
        CREATE TABLE IF NOT EXISTS invites (token TEXT PRIMARY KEY, space TEXT NOT NULL, role TEXT NOT NULL, expires TEXT NOT NULL, used INTEGER DEFAULT 0);
        CREATE TABLE IF NOT EXISTS reviews (account TEXT NOT NULL, item_id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(account,item_id));
        ''')
        if 'owner' not in [x['name'] for x in db.execute('PRAGMA table_info(backups)')]:
            db.execute('ALTER TABLE backups ADD COLUMN owner TEXT NOT NULL DEFAULT "' + OWNER + '"')
        if 'disabled' not in [x['name'] for x in db.execute('PRAGMA table_info(accounts)')]:
            db.execute('ALTER TABLE accounts ADD COLUMN disabled INTEGER NOT NULL DEFAULT 0')
        if not db.execute("SELECT 1 FROM metadata WHERE key='initialized'").fetchone():
            seed_dir = os.environ.get('SEDIMENT_SEED_DIR')
            if seed_dir:
                seed = Path(seed_dir)
                for filename, kind in [('ks_items.json', 'item'), ('ks_replies.json', 'reply')]:
                    for row in json.loads((seed / filename).read_text()):
                        db.execute('INSERT INTO documents VALUES (?,?,?,?)', (row['id'], row['owner_id'], kind, json.dumps(row, ensure_ascii=False)))
                for row in json.loads((seed / 'ks_profiles.json').read_text()):
                    db.execute('INSERT INTO profiles VALUES (?,?)', (row['owner_id'], json.dumps(row, ensure_ascii=False)))
            db.execute("INSERT INTO metadata VALUES ('initialized',?)", (now(),))
        local_owner = db.execute("SELECT data FROM metadata WHERE key='local_owner'").fetchone()
        if not OWNER:
            account_owner = db.execute('SELECT id FROM accounts ORDER BY rowid LIMIT 1').fetchone()
            primary = db.execute("SELECT owner, COUNT(*) AS n FROM documents WHERE kind='item' GROUP BY owner ORDER BY n DESC LIMIT 1").fetchone()
            OWNER = local_owner['data'] if local_owner else account_owner['id'] if account_owner else primary['owner'] if primary else 'local-' + uuid.uuid4().hex
        db.execute("INSERT OR REPLACE INTO metadata VALUES ('local_owner',?)", (OWNER,))

def rows(db, kind):
    return [json.loads(r['data']) for r in db.execute('SELECT data FROM documents WHERE kind=?', (kind,))]

def snapshot(db, owner=OWNER):
    items = [x for x in rows(db, 'item') if x['owner_id'] == owner]
    ids = {x['id'] for x in items}
    return {'format': 'sediment', 'version': 4, 'exported_at': now(), 'owner_id': owner,
            'items': items, 'replies': [x for x in rows(db, 'reply') if x['item_id'] in ids or x['owner_id'] == owner],
            'profiles': [json.loads(x['data']) for x in db.execute('SELECT data FROM profiles')],
            'versions': [dict(x) for x in db.execute('SELECT * FROM versions') if x['item_id'] in ids],
            'reviews': [dict(x) for x in db.execute('SELECT item_id,data FROM reviews WHERE account=?', (owner,))],
            'preferences': json.loads((db.execute('SELECT data FROM metadata WHERE key=?', ('preferences:' + owner,)).fetchone() or {'data': '{}'})['data'])}

def make_backup(db, owner=OWNER):
    ident, stamp = uuid.uuid4().hex, now()
    db.execute('INSERT INTO backups (id,at,data,owner) VALUES (?,?,?,?)', (ident, stamp, json.dumps(snapshot(db, owner), ensure_ascii=False), owner))
    db.execute('DELETE FROM backups WHERE owner=? AND id NOT IN (SELECT id FROM backups WHERE owner=? ORDER BY at DESC LIMIT 12)', (owner, owner))
    return {'id': ident, 'at': stamp}

def periodic_backup():
    while True:
        with LOCK, connect() as db:
            owners = [x['id'] for x in db.execute('SELECT id FROM accounts')] or [OWNER]
            for owner in owners:
                last = db.execute('SELECT at FROM backups WHERE owner=? ORDER BY at DESC LIMIT 1', (owner,)).fetchone()
                if not last or datetime.fromisoformat(last['at']) < datetime.now(timezone.utc) - timedelta(hours=1): make_backup(db, owner)
        time.sleep(60)

def validate_doc(doc, kind):
    if not isinstance(doc, dict) or not isinstance(doc.get('id'), str) or not doc['id'] or len(doc['id']) > 160:
        raise ValueError('内容 ID 无效')
    if not isinstance(doc.get('body', ''), str) or len(doc.get('body', '')) > 500000:
        raise ValueError('正文格式无效或超过 50 万字')
    if kind == 'item':
        if doc.get('type') not in ('note', 'topic', 'experience', 'resource'): raise ValueError('内容类型无效')
        if not isinstance(doc.get('topic_ids', []), list) or not all(isinstance(x, str) for x in doc.get('topic_ids', [])): raise ValueError('主题关联格式无效')
    elif not isinstance(doc.get('item_id'), str): raise ValueError('补充缺少原文 ID')
    for field in ('title', 'source'):
        if doc.get(field) is not None and not isinstance(doc[field], str): raise ValueError('内容字段格式无效')
    if not isinstance(doc.get('created_at'), str):
        # New writes receive their timestamp on the server; imports are checked separately.
        doc['created_at'] = now()
    if not isinstance(doc.get('atts', []), list): raise ValueError('附件格式无效')
    for att in doc.get('atts', []):
        if not isinstance(att, dict) or not isinstance(att.get('id'), str) or '/' in att['id'] or '\\' in att['id'] or att['id'] in ('.', '..'): raise ValueError('附件 ID 无效')
        if not isinstance(att.get('name'), str) or not isinstance(att.get('size'), (int, float)): raise ValueError('附件元数据无效')
    if doc.get('space_id') is not None and not isinstance(doc['space_id'], str): raise ValueError('空间 ID 无效')

PREFERENCE_KEYS = {'font', 'size', 'uiSize', 'headingSize', 'lineHeight', 'width', 'theme', 'density', 'motion', 'accent'}
def preferences(value, strict=True):
    if not isinstance(value, dict): raise ValueError('偏好格式无效')
    if strict and set(value) - PREFERENCE_KEYS: raise ValueError('仅接受排版和外观偏好；AI 配置须留在浏览器')
    return {key: val for key, val in value.items() if key in PREFERENCE_KEYS}

def password_hash(password, salt):
    return hashlib.scrypt(password.encode(), salt=bytes.fromhex(salt), n=16384, r=8, p=1).hex()

def role_for(db, space, owner):
    row = db.execute('SELECT role FROM members WHERE space=? AND account=?', (space, owner)).fetchone()
    return row['role'] if row else None

def visible(db, doc, owner):
    space = doc.get('space_id')
    if space: return bool(role_for(db, space, owner)) and (not doc.get('deleted_at') or doc['owner_id'] == owner)
    return doc['owner_id'] == owner

class Handler(BaseHTTPRequestHandler):
    server_version = 'Sediment/4'

    def identity(self, db):
        cookies = SimpleCookie()
        try: cookies.load(self.headers.get('Cookie', ''))
        except Exception: pass
        token = cookies.get('sediment_session')
        if token:
            row = db.execute('SELECT account FROM sessions WHERE token=? AND expires>?', (hashlib.sha256(token.value.encode()).hexdigest(), now())).fetchone()
            if row:
                account = db.execute('SELECT disabled FROM accounts WHERE id=?', (row['account'],)).fetchone()
                if account and not account['disabled']: return row['account']
        if not db.execute('SELECT 1 FROM accounts LIMIT 1').fetchone(): return OWNER
        return None

    def session(self, db, owner):
        token = secrets.token_urlsafe(32)
        db.execute('DELETE FROM sessions WHERE expires<?', (now(),))
        db.execute('INSERT INTO sessions VALUES (?,?,?)', (hashlib.sha256(token.encode()).hexdigest(), owner, (datetime.now(timezone.utc) + timedelta(days=7)).isoformat()))
        self.response_cookie = 'sediment_session=' + token + '; HttpOnly; SameSite=Strict; Path=/; Max-Age=604800'

    def log_message(self, fmt, *args):
        if os.environ.get('SEDIMENT_QUIET') != '1': super().log_message(fmt, *args)

    def send(self, status, value, mime='application/json; charset=utf-8', filename=None):
        content = json.dumps(value, ensure_ascii=False).encode() if mime.startswith('application/json') else value
        self.send_response(status)
        self.send_header('Content-Type', mime)
        self.send_header('Content-Length', str(len(content)))
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Cache-Control', 'no-store')
        if hasattr(self, 'response_cookie'): self.send_header('Set-Cookie', self.response_cookie)
        if filename: self.send_header('Content-Disposition', f'attachment; filename="{filename}"')
        self.end_headers()
        self.wfile.write(content)

    def do_GET(self):
        try:
            path = urlparse(self.path).path
            with LOCK, connect() as db:
                owner = self.identity(db)
                if path.startswith('/api/') and not owner: return self.send(401, {'error': '请登录你的知识空间', 'login': True})
                if path == '/api/state':
                    profile = db.execute('SELECT data FROM profiles WHERE id=?', (owner,)).fetchone()
                    prefs = db.execute("SELECT data FROM metadata WHERE key=?", ("preferences:" + owner,)).fetchone()
                    accessible = [x for x in rows(db, 'item') if visible(db, x, owner)]
                    review_states = {x['item_id']: json.loads(x['data']) for x in db.execute('SELECT item_id,data FROM reviews WHERE account=?', (owner,))}
                    for doc in accessible:
                        if doc['owner_id'] != owner:
                            for field in ('reviewed_at', 'review_due', 'review_interval', 'review_count', 'snooze_until', 'no_review'): doc.pop(field, None)
                        doc.update(review_states.get(doc['id'], {}))
                    ids = {x['id'] for x in accessible}
                    spaces = [dict(x) for x in db.execute('SELECT s.*,m.role FROM spaces s JOIN members m ON s.id=m.space WHERE m.account=?', (owner,))]
                    members = [dict(x) for x in db.execute('SELECT * FROM members') if x['space'] in {s['id'] for s in spaces}]
                    return self.send(200, {'items': accessible, 'replies': [x for x in rows(db, 'reply') if x['item_id'] in ids],
                         'profiles': [json.loads(x['data']) for x in db.execute('SELECT data FROM profiles')],
                         'me': json.loads(profile['data']) if profile else {'owner_id': owner, 'display_name': '我的空间'},
                         'preferences': json.loads(prefs['data']) if prefs else {}, 'mode': 'local', 'spaces': spaces, 'members': members,
                         'account_enabled': bool(db.execute('SELECT 1 FROM accounts LIMIT 1').fetchone()),
                         'platform_admin': owner == OWNER,
                         'backups': [dict(x) for x in db.execute('SELECT id,at FROM backups WHERE owner=? ORDER BY at DESC', (owner,))]})
                if path == '/api/export': return self.send(200, snapshot(db, owner))
                if path == '/api/platform':
                    if owner != OWNER: return self.send(403, {'error': '没有平台管理权限'})
                    accounts = [dict(x) for x in db.execute('SELECT id,email,disabled FROM accounts')]
                    spaces = [dict(x) for x in db.execute('SELECT s.*,COUNT(m.account) AS member_count FROM spaces s LEFT JOIN members m ON s.id=m.space GROUP BY s.id')]
                    return self.send(200, {'accounts': accounts, 'spaces': spaces,
                        'items': db.execute("SELECT COUNT(*) AS n FROM documents WHERE kind='item'").fetchone()['n'],
                        'files': db.execute('SELECT COUNT(*) AS n FROM files').fetchone()['n'],
                        'backups': db.execute('SELECT COUNT(*) AS n FROM backups').fetchone()['n'], 'runtime': '本地 SQLite · 单实例'})
                if path == '/api/archive':
                    payload = snapshot(db, owner)
                    missing = []
                    buf = io.BytesIO()
                    with zipfile.ZipFile(buf, 'w', zipfile.ZIP_DEFLATED) as z:
                        z.writestr('workspace.json', json.dumps(payload, ensure_ascii=False, indent=2))
                        seen = set()
                        for doc in payload['items'] + payload['replies']:
                            for att in doc.get('atts') or []:
                                aid = att.get('id', '')
                                if aid in seen: continue
                                seen.add(aid)
                                f = STORE / 'files' / aid
                                if aid and f.is_file() and f.parent == STORE / 'files': z.write(f, 'files/' + aid)
                                else: missing.append(att)
                        z.writestr('missing-attachments.json', json.dumps(missing, ensure_ascii=False, indent=2))
                    return self.send(200, buf.getvalue(), 'application/zip', 'sediment-archive.zip')
                if path.startswith('/api/backups/'):
                    ident = path.split('/')[-1]
                    row = db.execute('SELECT data FROM backups WHERE id=? AND owner=?', (ident, owner)).fetchone()
                    return self.send(200, json.loads(row['data'])) if row else self.send(404, {'error': '备份不存在'})
                if path.startswith('/api/versions/'):
                    ident = path.split('/')[-1]
                    doc = db.execute("SELECT data FROM documents WHERE id=? AND kind='item'", (ident,)).fetchone()
                    if not doc or not visible(db, json.loads(doc['data']), owner): return self.send(403, {'error': '没有访问权限'})
                    return self.send(200, [{'id': x['id'], 'at': x['at'], 'item': json.loads(x['data'])} for x in db.execute('SELECT * FROM versions WHERE item_id=? ORDER BY at DESC', (ident,))])
                if path.startswith('/api/files/'):
                    ident = path.split('/')[-1]
                    row = db.execute('SELECT * FROM files WHERE id=?', (ident,)).fetchone()
                    f = STORE / 'files' / ident
                    attached = any(any(a.get('id') == ident for a in (x.get('atts') or [])) and visible(db, x, owner) for x in rows(db, 'item'))
                    if not attached:
                        parents = {x['id'] for x in rows(db, 'item') if visible(db, x, owner)}
                        attached = any(x['item_id'] in parents and any(a.get('id') == ident for a in (x.get('atts') or [])) for x in rows(db, 'reply'))
                    if not attached: return self.send(403, {'error': '附件尚未保存到可访问的记录'})
                    if row and f.is_file() and f.parent == STORE / 'files':
                        return self.send(200, f.read_bytes(), 'application/octet-stream', 'attachment-' + ident)
                    return self.send(404, {'error': '原附件文件未包含在交付包中，请重新上传'})
            if path.startswith('/api/'): return self.send(404, {'error': '接口不存在'})
            dist = ROOT.parent / 'dist'
            target = (dist / unquote(path).lstrip('/')).resolve()
            if not target.is_relative_to(dist.resolve()): return self.send(403, {'error': '路径无效'})
            if not target.is_file(): target = dist / 'index.html'
            if not target.is_file(): return self.send(404, {'error': '请先 npm run build，或启动 Vite 开发预览'})
            import mimetypes
            return self.send(200, target.read_bytes(), mimetypes.guess_type(target)[0] or 'application/octet-stream')
        except (ValueError, KeyError) as e: self.send(400, {'error': str(e)})
        except Exception: self.send(500, {'error': '读取失败，请检查本地服务日志'})

    def do_POST(self):
        try:
            origin = self.headers.get('Origin')
            dev_origins = {'http://127.0.0.1:5173', 'http://localhost:5173', 'http://127.0.0.1:4173', 'http://localhost:4173'}
            if origin and urlparse(origin).netloc != self.headers.get('Host') and origin not in dev_origins:
                return self.send(403, {'error': '只接受当前工作空间的请求'})
            path = urlparse(self.path).path
            size = int(self.headers.get('Content-Length', '0'))
            if size > 20 * 1024 * 1024: return self.send(413, {'error': '文件或导入内容不能超过 20 MB'})
            raw = self.rfile.read(size)
            with LOCK, connect() as db:
                owner = self.identity(db)
                if path in ('/api/login', '/api/register'):
                    data = json.loads(raw or '{}')
                    email = str(data.get('email', '')).strip().lower()
                    password = str(data.get('password', ''))
                    if '@' not in email or len(email) > 200: raise ValueError('请输入有效邮箱')
                    if path == '/api/register':
                        if len(password) < 8 or len(password) > 200: raise ValueError('密码需要 8 至 200 位')
                        if db.execute('SELECT 1 FROM accounts WHERE email=?', (email,)).fetchone(): raise ValueError('该邮箱已注册')
                        first = not db.execute('SELECT 1 FROM accounts LIMIT 1').fetchone()
                        account = OWNER if first else uuid.uuid4().hex
                        salt = secrets.token_hex(16)
                        name = str(data.get('display_name', '')).strip()[:40] or email.split('@')[0]
                        db.execute('INSERT INTO accounts (id,email,password,salt) VALUES (?,?,?,?)', (account, email, password_hash(password, salt), salt))
                        db.execute('INSERT OR REPLACE INTO profiles VALUES (?,?)', (account, json.dumps({'owner_id': account, 'display_name': name}, ensure_ascii=False)))
                        self.session(db, account)
                        return self.send(200, {'ok': True})
                    account = db.execute('SELECT * FROM accounts WHERE email=?', (email,)).fetchone()
                    if not account or not hmac.compare_digest(account['password'], password_hash(password, account['salt'])): return self.send(401, {'error': '邮箱或密码不正确'})
                    if account['disabled']: return self.send(403, {'error': '此账号已停用，请联系实例管理员'})
                    self.session(db, account['id'])
                    return self.send(200, {'ok': True})
                if not owner: return self.send(401, {'error': '请先登录'})
                if path == '/api/logout':
                    cookies = SimpleCookie(); cookies.load(self.headers.get('Cookie', ''))
                    token = cookies.get('sediment_session')
                    if token: db.execute('DELETE FROM sessions WHERE token=?', (hashlib.sha256(token.value.encode()).hexdigest(),))
                    self.response_cookie = 'sediment_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0'
                    return self.send(200, {'ok': True})
            if path == '/api/files':
                ident = uuid.uuid4().hex
                name = unquote(self.headers.get('X-File-Name', 'attachment'))[:240]
                mime = self.headers.get('Content-Type', 'application/octet-stream')
                with LOCK, connect() as db:
                    (STORE / 'files' / ident).write_bytes(raw)
                    db.execute('INSERT INTO files VALUES (?,?,?,?)', (ident, name, mime, size))
                return self.send(200, {'id': ident, 'name': name, 'mime': mime, 'size': size, 'path': '/api/files/' + ident, 'local': True})
            data = json.loads(raw or '{}')
            with LOCK, connect() as db:
                if path in ('/api/items', '/api/replies'):
                    kind = 'item' if path.endswith('items') else 'reply'
                    validate_doc(data, kind)
                    old = db.execute('SELECT * FROM documents WHERE id=?', (data['id'],)).fetchone()
                    if old and (old['owner'] != owner or old['kind'] != kind): return self.send(403, {'error': '只能编辑自己的内容'})
                    if kind == 'item':
                        space = data.get('space_id')
                        if old and json.loads(old['data']).get('space_id') != space: raise ValueError('内容归属空间不可直接更改，请复制到目标空间')
                        if space and role_for(db, space, owner) not in ('owner', 'admin', 'editor'): return self.send(403, {'error': '当前团队角色只允许阅读'})
                    if kind == 'reply':
                        parent = db.execute("SELECT data,owner FROM documents WHERE id=? AND kind='item'", (data['item_id'],)).fetchone()
                        if not parent or json.loads(parent['data']).get('deleted_at'): return self.send(400, {'error': '原文不存在或在回收站'})
                        parent_doc = json.loads(parent['data'])
                        if not visible(db, parent_doc, owner): return self.send(403, {'error': '没有原文的访问权限'})
                        if parent_doc.get('space_id') and role_for(db, parent_doc['space_id'], owner) == 'viewer': return self.send(403, {'error': '只读成员不能发表补充'})
                        if data.get('is_progress') and parent['owner'] != owner: return self.send(403, {'error': '只有作者可以标记进展'})
                    if old:
                        prior = json.loads(old['data'])
                        data['created_at'] = prior['created_at']
                        if kind == 'item' and any(prior.get(k) != data.get(k) for k in ['body', 'title', 'type', 'und', 'topic_ids', 'deleted_at']):
                            db.execute('INSERT INTO versions VALUES (?,?,?,?)', (uuid.uuid4().hex, data['id'], now(), old['data']))
                    else: data['created_at'] = now()
                    profile = db.execute('SELECT data FROM profiles WHERE id=?', (owner,)).fetchone()
                    data['owner_id'] = owner
                    data['owner_name'] = json.loads(profile['data'])['display_name'] if profile else '我'
                    data['updated_at'] = now()
                    if kind == 'item':
                        for tid in data.get('topic_ids', []):
                            topic = db.execute("SELECT data FROM documents WHERE id=? AND kind='item'", (tid,)).fetchone()
                            previous_ids = json.loads(old['data']).get('topic_ids', []) if old else []
                            if not topic or json.loads(topic['data']).get('type') != 'topic':
                                if tid in previous_ids: continue
                                raise ValueError('关联主题已删除或不存在')
                            topic_doc = json.loads(topic['data'])
                            if topic_doc.get('deleted_at') and tid in previous_ids: continue
                            if topic_doc.get('deleted_at'): raise ValueError('不能新关联回收站中的主题')
                            if not visible(db, topic_doc, owner) or topic_doc.get('space_id') != data.get('space_id'): raise ValueError('只能关联当前空间可访问的主题')
                        if data.get('und'):
                            reply = db.execute("SELECT data FROM documents WHERE id=? AND kind='reply'", (data['und'],)).fetchone()
                            if not reply or json.loads(reply['data'])['item_id'] != data['id']: raise ValueError('当前理解必须来自原文的补充')
                    db.execute('INSERT OR REPLACE INTO documents VALUES (?,?,?,?)', (data['id'], owner, kind, json.dumps(data, ensure_ascii=False)))
                    return self.send(200, data)
                if path == '/api/preferences':
                    db.execute("INSERT OR REPLACE INTO metadata VALUES (?,?)", ("preferences:" + owner, json.dumps(preferences(data))))
                    return self.send(200, data)
                if path == '/api/profile':
                    name = str(data.get('display_name', '')).strip()[:40]
                    if not name: raise ValueError('显示名不能为空')
                    result = {'owner_id': owner, 'display_name': name, 'updated_at': now()}
                    db.execute('INSERT OR REPLACE INTO profiles VALUES (?,?)', (owner, json.dumps(result, ensure_ascii=False)))
                    return self.send(200, result)
                if path == '/api/spaces':
                    name = str(data.get('name', '')).strip()[:80]
                    if not name: raise ValueError('团队空间名称不能为空')
                    ident = uuid.uuid4().hex
                    db.execute('INSERT INTO spaces VALUES (?,?,?,?)', (ident, name, str(data.get('description', ''))[:1000], owner))
                    db.execute('INSERT INTO members VALUES (?,?,?)', (ident, owner, 'owner'))
                    return self.send(200, {'id': ident})
                if path == '/api/invites':
                    space, role = data.get('space'), data.get('role', 'editor')
                    if role_for(db, space, owner) not in ('owner', 'admin'): return self.send(403, {'error': '只有空间管理员可以邀请成员'})
                    if role not in ('admin', 'editor', 'viewer'): raise ValueError('成员角色无效')
                    if role == 'admin' and role_for(db, space, owner) != 'owner': return self.send(403, {'error': '只有所有者可以邀请管理员'})
                    token = secrets.token_urlsafe(24)
                    db.execute('INSERT INTO invites VALUES (?,?,?,?,0)', (hashlib.sha256(token.encode()).hexdigest(), space, role, (datetime.now(timezone.utc) + timedelta(days=7)).isoformat()))
                    return self.send(200, {'code': token, 'expires': '7 天', 'role': role})
                if path == '/api/join':
                    token = hashlib.sha256(str(data.get('code', '')).strip().encode()).hexdigest()
                    invitation = db.execute('SELECT * FROM invites WHERE token=? AND expires>? AND used=0', (token, now())).fetchone()
                    if not invitation: raise ValueError('邀请码无效、已使用或已过期')
                    if role_for(db, invitation['space'], owner): raise ValueError('你已经是该空间的成员')
                    db.execute('INSERT INTO members VALUES (?,?,?)', (invitation['space'], owner, invitation['role']))
                    db.execute('UPDATE invites SET used=1 WHERE token=?', (token,))
                    return self.send(200, {'id': invitation['space']})
                if path == '/api/members':
                    space, account, role = data.get('space'), data.get('account'), data.get('role')
                    current = role_for(db, space, owner)
                    target = role_for(db, space, account)
                    if current != 'owner': return self.send(403, {'error': '只有所有者可以调整成员权限'})
                    if not target or target == 'owner': raise ValueError('不能调整空间所有者或不存在的成员')
                    if role == 'remove': db.execute('DELETE FROM members WHERE space=? AND account=?', (space, account))
                    elif role in ('admin', 'editor', 'viewer'): db.execute('UPDATE members SET role=? WHERE space=? AND account=?', (role, space, account))
                    else: raise ValueError('角色无效')
                    return self.send(200, {'ok': True})
                if path == '/api/platform/accounts':
                    if owner != OWNER: return self.send(403, {'error': '没有平台管理权限'})
                    if data.get('id') == OWNER: raise ValueError('不能停用平台所有者')
                    if not db.execute('SELECT 1 FROM accounts WHERE id=?', (data.get('id'),)).fetchone(): raise ValueError('账号不存在')
                    disabled = int(bool(data.get('disabled')))
                    db.execute('UPDATE accounts SET disabled=? WHERE id=?', (disabled, data['id']))
                    if disabled: db.execute('DELETE FROM sessions WHERE account=?', (data['id'],))
                    return self.send(200, {'ok': True})
                if path == '/api/review':
                    doc = db.execute("SELECT data FROM documents WHERE id=? AND kind='item'", (data.get('item_id'),)).fetchone()
                    if not doc or not visible(db, json.loads(doc['data']), owner) or json.loads(doc['data']).get('deleted_at'): return self.send(403, {'error': '没有这条知识的访问权限'})
                    previous = db.execute('SELECT data FROM reviews WHERE account=? AND item_id=?', (owner, data['item_id'])).fetchone()
                    state = json.loads(previous['data']) if previous else {}
                    if 'no_review' in data: state['no_review'] = bool(data['no_review'])
                    elif data.get('snooze'):
                        state['snooze_until'] = (datetime.now(timezone.utc) + timedelta(days=1)).isoformat()
                    else:
                        interval = data.get('interval')
                        if interval not in (1, 7, 30): raise ValueError('回顾间隔必须为 1、7 或 30 天')
                        state.update({'reviewed_at': now(), 'review_due': (datetime.now(timezone.utc) + timedelta(days=interval)).isoformat(), 'review_interval': interval, 'review_count': state.get('review_count', 0) + 1, 'snooze_until': None})
                    db.execute('INSERT OR REPLACE INTO reviews VALUES (?,?,?)', (owner, data['item_id'], json.dumps(state)))
                    return self.send(200, state)
                if path == '/api/merge-topics':
                    source = db.execute("SELECT * FROM documents WHERE id=? AND kind='item'", (data.get('source'),)).fetchone()
                    target = db.execute("SELECT * FROM documents WHERE id=? AND kind='item'", (data.get('target'),)).fetchone()
                    if not source or not target or source['id'] == target['id']: raise ValueError('请选择两个不同的主题')
                    src, dst = json.loads(source['data']), json.loads(target['data'])
                    if src.get('type') != 'topic' or dst.get('type') != 'topic' or src.get('deleted_at') or dst.get('deleted_at'): raise ValueError('主题不可用')
                    if src.get('space_id') != dst.get('space_id') or not visible(db, src, owner) or not visible(db, dst, owner): raise ValueError('只能合并当前空间的主题')
                    team = src.get('space_id')
                    if team:
                        if role_for(db, team, owner) not in ('owner', 'admin'): return self.send(403, {'error': '团队主题合并需要管理员权限'})
                    elif source['owner'] != owner or target['owner'] != owner: return self.send(403, {'error': '只能合并自己的主题'})
                    make_backup(db, owner)
                    for doc in rows(db, 'item'):
                        if src['id'] in doc.get('topic_ids', []) and doc.get('space_id') == team:
                            db.execute('INSERT INTO versions VALUES (?,?,?,?)', (uuid.uuid4().hex, doc['id'], now(), json.dumps(doc, ensure_ascii=False)))
                            doc['topic_ids'] = list(dict.fromkeys(dst['id'] if t == src['id'] else t for t in doc['topic_ids']))
                            doc['updated_at'] = now()
                            db.execute('UPDATE documents SET data=? WHERE id=?', (json.dumps(doc, ensure_ascii=False), doc['id']))
                    db.execute('INSERT INTO versions VALUES (?,?,?,?)', (uuid.uuid4().hex, src['id'], now(), source['data']))
                    src['deleted_at'] = now()
                    src['merged_into'] = dst['id']
                    db.execute('UPDATE documents SET data=? WHERE id=?', (json.dumps(src, ensure_ascii=False), src['id']))
                    return self.send(200, {'ok': True})
                if path == '/api/backups': return self.send(200, make_backup(db, owner))
                if path == '/api/restore':
                    row = db.execute('SELECT data FROM backups WHERE id=? AND owner=?', (data.get('id'), owner)).fetchone()
                    if not row: raise ValueError('备份不存在')
                    payload = json.loads(row['data'])
                    for doc in payload['items']:
                        if doc.get('space_id') and role_for(db, doc['space_id'], owner) not in ('owner', 'admin', 'editor'): raise ValueError('无法恢复已失去写入权限的团队内容')
                    make_backup(db, owner)
                    own_ids = {x['id'] for x in rows(db, 'item') if x['owner_id'] == owner}
                    for reply in rows(db, 'reply'):
                        if reply['item_id'] in own_ids: db.execute('DELETE FROM documents WHERE id=?', (reply['id'],))
                    db.execute('DELETE FROM documents WHERE owner=?', (owner,))
                    for kind, key in [('item', 'items'), ('reply', 'replies')]:
                        for doc in payload[key]:
                            db.execute('INSERT OR REPLACE INTO documents VALUES (?,?,?,?)', (doc['id'], doc['owner_id'], kind, json.dumps(doc, ensure_ascii=False)))
                    for ident in own_ids: db.execute('DELETE FROM versions WHERE item_id=?', (ident,))
                    for version in payload.get('versions', []):
                        db.execute('INSERT INTO versions VALUES (?,?,?,?)', (version['id'], version['item_id'], version['at'], version['data']))
                    db.execute("INSERT OR REPLACE INTO metadata VALUES (?,?)", ("preferences:" + owner, json.dumps(preferences(payload.get('preferences', {}), strict=False))))
                    db.execute('DELETE FROM reviews WHERE account=?', (owner,))
                    for review in payload.get('reviews', []): db.execute('INSERT INTO reviews VALUES (?,?,?)', (owner, review['item_id'], review['data']))
                    return self.send(200, {'ok': True})
                if path == '/api/import':
                    payload = data
                    if payload.get('format') != 'sediment' or payload.get('version') != 4: raise ValueError('请选择新版导出的完整 JSON 备份')
                    items, replies = payload.get('items'), payload.get('replies')
                    if not isinstance(items, list) or not isinstance(replies, list): raise ValueError('备份缺少内容或补充列表')
                    all_ids = [doc.get('id') for doc in items + replies if isinstance(doc, dict)]
                    if len(all_ids) != len(items) + len(replies) or len(set(all_ids)) != len(all_ids): raise ValueError('备份包含重复 ID 或无效内容')
                    for kind, docs in [('item', items), ('reply', replies)]:
                        for doc in docs:
                            existing = db.execute('SELECT kind FROM documents WHERE id=?', (doc.get('id'),)).fetchone()
                            if existing and existing['kind'] != kind: raise ValueError('备份 ID 与现有内容类型冲突')
                    for doc in items:
                        validate_doc(doc, 'item')
                        if doc.get('owner_id') != owner: raise ValueError('备份作者与当前工作空间不一致')
                        if doc.get('space_id') and role_for(db, doc['space_id'], owner) not in ('owner', 'admin', 'editor'): raise ValueError('没有备份中团队空间的写入权限')
                    item_ids = {d['id'] for d in items} | {x['id'] for x in rows(db, 'item') if visible(db, x, owner)}
                    for doc in replies:
                        validate_doc(doc, 'reply')
                        if doc['item_id'] not in item_ids: raise ValueError('补充对应的原文不存在')
                        if doc.get('owner_id') != owner:
                            existing = db.execute("SELECT data FROM documents WHERE id=? AND kind='reply'", (doc['id'],)).fetchone()
                            if not existing or json.loads(existing['data']) != doc: raise ValueError('不能通过导入创建或篡改其他作者的补充')
                    for doc in items + replies:
                        old = db.execute('SELECT owner FROM documents WHERE id=?', (doc['id'],)).fetchone()
                        if old and old['owner'] != doc['owner_id']: raise ValueError('备份 ID 与另一位作者的内容冲突')
                    make_backup(db, owner)
                    for kind, docs in [('item', items), ('reply', replies)]:
                        for doc in docs:
                            db.execute('INSERT OR REPLACE INTO documents VALUES (?,?,?,?)', (doc['id'], doc['owner_id'], kind, json.dumps(doc, ensure_ascii=False)))
                    for version in payload.get('versions', []):
                        if version.get('item_id') not in {d['id'] for d in items}: raise ValueError('版本记录必须属于当前作者')
                        db.execute('INSERT OR REPLACE INTO versions VALUES (?,?,?,?)', (version['id'], version['item_id'], version['at'], version['data']))
                    for review in payload.get('reviews', []):
                        if review.get('item_id') not in item_ids: raise ValueError('回顾记录对应的知识不可访问')
                        db.execute('INSERT OR REPLACE INTO reviews VALUES (?,?,?)', (owner, review['item_id'], review['data']))
                    return self.send(200, {'items': len(items), 'replies': len(replies)})
                if path == '/api/purge':
                    doc = db.execute("SELECT data,owner FROM documents WHERE id=? AND kind='item'", (data.get('id'),)).fetchone()
                    if not doc or doc['owner'] != owner or not json.loads(doc['data']).get('deleted_at'): raise ValueError('只能永久删除自己回收站中的内容')
                    make_backup(db, owner)
                    db.execute('DELETE FROM documents WHERE id=?', (data['id'],))
                    for reply in rows(db, 'reply'):
                        if reply['item_id'] == data['id']: db.execute('DELETE FROM documents WHERE id=?', (reply['id'],))
                    return self.send(200, {'ok': True})
            return self.send(404, {'error': '接口不存在'})
        except (ValueError, KeyError, TypeError) as e: self.send(400, {'error': str(e)})
        except Exception: self.send(500, {'error': '保存失败，请检查本地服务日志'})

if __name__ == '__main__':
    initialize()
    threading.Thread(target=periodic_backup, daemon=True).start()
    # The local owner session is deliberately loopback-only. This is not online authentication.
    port = int(os.environ.get('SEDIMENT_PORT', '8787'))
    print(f'沉淀 · 本地工作空间 http://127.0.0.1:{port}', flush=True)
    ThreadingHTTPServer(('127.0.0.1', port), Handler).serve_forever()
