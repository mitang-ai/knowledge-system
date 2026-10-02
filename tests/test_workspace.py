"""Behavior and authorization checks against a fresh, isolated database."""
import unittest, tempfile, subprocess, socket, time, os, json, urllib.request, urllib.error, http.cookiejar
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

class Client:
    def __init__(self, url):
        self.url = url
        self.opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
    def request(self, path, data=None, origin=None):
        headers = {'Content-Type': 'application/json'}
        if origin: headers['Origin'] = origin
        request = urllib.request.Request(self.url + '/api/' + path, data=None if data is None else json.dumps(data).encode(), headers=headers)
        try:
            response = self.opener.open(request)
            return response.status, json.loads(response.read())
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read())

class WorkspaceTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory()
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0)); port = sock.getsockname()[1]
        cls.url = f'http://127.0.0.1:{port}'
        cls.process = subprocess.Popen(['python', str(ROOT / 'server/app.py')], env={**os.environ, 'SEDIMENT_STORAGE': cls.temp.name, 'SEDIMENT_PORT': str(port), 'SEDIMENT_QUIET': '1'}, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        cls.owner, cls.editor, cls.viewer = (Client(cls.url) for _ in range(3))
        for _ in range(50):
            try:
                status, cls.initial = cls.owner.request('state')
                if status == 200: break
            except Exception: time.sleep(.05)
        cls.owner.request('register', {'email': 'owner@example.test', 'password': 'owner-password', 'display_name': '所有者'})
        cls.editor.request('register', {'email': 'editor@example.test', 'password': 'editor-password', 'display_name': '编辑者'})
        cls.viewer.request('register', {'email': 'viewer@example.test', 'password': 'viewer-password', 'display_name': '阅读者'})
        cls.owner_id = cls.owner.request('state')[1]['me']['owner_id']
        cls.editor_id = cls.editor.request('state')[1]['me']['owner_id']
        cls.space = cls.owner.request('spaces', {'name': '测试团队', 'description': '隔离验证'})[1]['id']
        for client, role in [(cls.editor, 'editor'), (cls.viewer, 'viewer')]:
            code = cls.owner.request('invites', {'space': cls.space, 'role': role})[1]['code']
            assert client.request('join', {'code': code})[0] == 200

    @classmethod
    def tearDownClass(cls):
        cls.process.terminate(); cls.process.wait(timeout=5); cls.temp.cleanup()

    def item(self, kind='note', space=None, body='测试知识', topics=None):
        import uuid
        return {'id': uuid.uuid4().hex, 'type': kind, 'title': '验证记录', 'body': body, 'topic_ids': topics or [], 'atts': [], 'space_id': space, 'created_at': '2026-10-02T00:00:00+00:00'}

    def test_fresh_workspace_is_empty(self):
        self.assertEqual(self.initial['items'], [])
        self.assertEqual(self.initial['replies'], [])
        self.assertEqual(self.initial['profiles'], [])

    def test_server_rejects_ai_configuration_in_preferences(self):
        self.assertEqual(self.owner.request('preferences', {'font': 'noto-sans-sc', 'apiKey': 'synthetic-sentinel-secret'})[0], 400)
        self.assertNotIn('apiKey', self.owner.request('state')[1]['preferences'])

    def test_private_and_anonymous_isolation(self):
        private = self.owner.request('items', self.item())[1]
        other = self.editor.request('state')[1]
        self.assertNotIn(private['id'], [x['id'] for x in other['items']])
        self.assertEqual(Client(self.url).request('state')[0], 401)
        self.assertEqual(self.editor.request('versions/' + private['id'])[0], 403)
        self.assertEqual(self.editor.request('items', private)[0], 403)

    def test_team_role_and_owner_are_enforced(self):
        note = self.owner.request('items', self.item(space=self.space))[1]
        self.assertIn(note['id'], [x['id'] for x in self.viewer.request('state')[1]['items']])
        self.assertEqual(self.viewer.request('items', self.item(space=self.space))[0], 403)
        self.assertEqual(self.editor.request('items', {**note, 'body': '试图修改其他作者'})[0], 403)
        own = self.editor.request('items', {**self.item(space=self.space), 'owner_id': self.owner_id})[1]
        self.assertEqual(own['owner_id'], self.editor_id)
        reply = {'id': 'reply-' + own['id'], 'item_id': note['id'], 'body': '补充', 'atts': [], 'is_progress': True}
        self.assertEqual(self.editor.request('replies', reply)[0], 403)
        self.assertEqual(self.editor.request('replies', {**reply, 'is_progress': False})[0], 200)
        self.assertEqual(self.viewer.request('replies', {**reply, 'id': 'viewer-' + own['id'], 'is_progress': False})[0], 403)

    def test_invite_is_single_use_and_cannot_escalate(self):
        code = self.owner.request('invites', {'space': self.space, 'role': 'viewer'})[1]['code']
        outsider = Client(self.url)
        outsider.request('register', {'email': 'outside@example.test', 'password': 'outside-password'})
        self.assertEqual(outsider.request('join', {'code': code})[0], 200)
        self.assertEqual(self.editor.request('join', {'code': code})[0], 400)
        self.assertEqual(self.editor.request('invites', {'space': self.space, 'role': 'admin'})[0], 403)
        self.assertEqual(self.editor.request('members', {'space': self.space, 'account': self.editor_id, 'role': 'admin'})[0], 403)

    def test_cross_space_topic_rejected(self):
        topic = self.owner.request('items', self.item(kind='topic'))[1]
        self.assertEqual(self.owner.request('items', self.item(space=self.space, topics=[topic['id']]))[0], 400)

    def test_versions_and_atomic_topic_merge(self):
        t1 = self.owner.request('items', self.item(kind='topic', body='第一个主题'))[1]
        t2 = self.owner.request('items', self.item(kind='topic', body='第二个主题'))[1]
        note = self.owner.request('items', self.item(body='原始知识', topics=[t1['id'], t2['id']]))[1]
        self.owner.request('items', {**note, 'body': '更新后的知识'})
        versions = self.owner.request('versions/' + note['id'])[1]
        self.assertEqual(versions[0]['item']['body'], '原始知识')
        self.assertEqual(self.owner.request('merge-topics', {'source': t1['id'], 'target': t2['id']})[0], 200)
        state = self.owner.request('state')[1]
        actual = next(x for x in state['items'] if x['id'] == note['id'])
        self.assertEqual(actual['topic_ids'], [t2['id']])
        self.assertEqual(actual['body'], '更新后的知识')

    def test_understanding_must_belong_to_item(self):
        a = self.owner.request('items', self.item())[1]
        b = self.owner.request('items', self.item())[1]
        reply = self.owner.request('replies', {'id': 'understanding-' + a['id'], 'item_id': a['id'], 'body': '新理解', 'atts': [], 'is_progress': False})[1]
        a = next(x for x in self.owner.request('state')[1]['items'] if x['id'] == a['id'])
        self.assertEqual(self.owner.request('items', {**a, 'und': reply['id']})[0], 200)
        self.assertEqual(self.owner.request('items', {**b, 'und': reply['id']})[0], 400)

    def test_backup_restore_isolated_and_preserves_versions(self):
        note = self.editor.request('items', self.item(body='备份前内容'))[1]
        note = self.editor.request('items', {**note, 'body': '保存的内容'})[1]
        backup = self.editor.request('backups', {})[1]
        own_version_count = len(self.editor.request('versions/' + note['id'])[1])
        updated = self.editor.request('items', {**note, 'body': '备份后修改'})[1]
        other = self.owner.request('items', self.item(body='其他作者数据'))[1]
        self.assertEqual(self.editor.request('restore', {'id': backup['id']})[0], 200)
        actual = next(x for x in self.editor.request('state')[1]['items'] if x['id'] == updated['id'])
        self.assertEqual(actual['body'], '保存的内容')
        self.assertEqual(len(self.editor.request('versions/' + note['id'])[1]), own_version_count)
        self.assertIn(other['id'], [x['id'] for x in self.owner.request('state')[1]['items']])
        self.assertEqual(self.owner.request('backups/' + backup['id'])[0], 404)

    def test_import_cannot_forge_other_author(self):
        payload = self.owner.request('export')[1]
        parent = payload['items'][0]
        payload['replies'].append({'id': 'forged-other-comment', 'item_id': parent['id'], 'owner_id': self.editor_id, 'body': '伪造补充', 'is_progress': False, 'atts': []})
        before = len(self.owner.request('state')[1]['replies'])
        self.assertEqual(self.owner.request('import', payload)[0], 400)
        self.assertEqual(len(self.owner.request('state')[1]['replies']), before)

    def test_cross_origin_mutation_rejected(self):
        self.assertEqual(self.owner.request('items', self.item(), origin='https://unrelated.test')[0], 403)

    def test_removing_member_revokes_read_and_write(self):
        outsider = Client(self.url)
        outsider.request('register', {'email': 'removed@example.test', 'password': 'removed-password'})
        outsider_id = outsider.request('state')[1]['me']['owner_id']
        code = self.owner.request('invites', {'space': self.space, 'role': 'editor'})[1]['code']
        outsider.request('join', {'code': code})
        note = self.owner.request('items', self.item(space=self.space))[1]
        self.owner.request('members', {'space': self.space, 'account': outsider_id, 'role': 'remove'})
        self.assertNotIn(note['id'], [x['id'] for x in outsider.request('state')[1]['items']])
        self.assertEqual(outsider.request('items', self.item(space=self.space))[0], 403)

    def test_platform_control_and_disabled_sessions(self):
        outsider = Client(self.url)
        outsider.request('register', {'email': 'suspended@example.test', 'password': 'suspended-password'})
        ident = outsider.request('state')[1]['me']['owner_id']
        self.assertEqual(outsider.request('platform')[0], 403)
        self.assertEqual(self.owner.request('platform/accounts', {'id': ident, 'disabled': True})[0], 200)
        self.assertEqual(outsider.request('state')[0], 401)
        self.assertEqual(outsider.request('login', {'email': 'suspended@example.test', 'password': 'suspended-password'})[0], 403)
        self.owner.request('platform/accounts', {'id': ident, 'disabled': False})
        self.assertEqual(outsider.request('login', {'email': 'suspended@example.test', 'password': 'suspended-password'})[0], 200)
        self.assertEqual(self.owner.request('platform/accounts', {'id': self.owner_id, 'disabled': True})[0], 400)

    def test_deleted_topic_does_not_block_existing_note_edits(self):
        topic = self.owner.request('items', self.item(kind='topic'))[1]
        note = self.owner.request('items', self.item(topics=[topic['id']]))[1]
        self.owner.request('items', {**topic, 'deleted_at': '2026-10-02T00:00:00+00:00'})
        self.assertEqual(self.owner.request('items', {**note, 'body': '主题删除后继续写'})[0], 200)
        self.assertEqual(self.owner.request('items', self.item(topics=[topic['id']]))[0], 400)

    def test_review_is_personal_even_for_read_only_team_member(self):
        note = self.owner.request('items', self.item(space=self.space))[1]
        self.assertEqual(self.viewer.request('review', {'item_id': note['id'], 'interval': 7})[0], 200)
        viewer_note = next(x for x in self.viewer.request('state')[1]['items'] if x['id'] == note['id'])
        owner_note = next(x for x in self.owner.request('state')[1]['items'] if x['id'] == note['id'])
        self.assertEqual(viewer_note['review_count'], 1)
        self.assertEqual(viewer_note['review_interval'], 7)
        self.assertIsNone(owner_note.get('reviewed_at'))
        private = self.owner.request('items', self.item())[1]
        self.assertEqual(self.viewer.request('review', {'item_id': private['id'], 'interval': 7})[0], 403)

if __name__ == '__main__': unittest.main()
