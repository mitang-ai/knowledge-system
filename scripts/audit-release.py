"""Audit tracked release files; report paths only, never credential contents."""
from pathlib import Path
import argparse,json,re,subprocess
root=Path(__file__).resolve().parents[1]
parser=argparse.ArgumentParser();parser.add_argument('--private-seed',type=Path);args=parser.parse_args()
paths=subprocess.check_output(['git','ls-files','-z'],cwd=root).decode().split('\0')
private_ids=set()
if args.private_seed:
 for name in ['ks_items.json','ks_replies.json','ks_profiles.json']:
  file=args.private_seed/name
  for row in json.loads(file.read_text()):
   for key in ['id','owner_id','item_id']:
    value=row.get(key)
    if isinstance(value,str) and len(value)>8:private_ids.add(value)
blocked=['server/storage/','server/seed/','docs/screenshots/','test-results/','private-data/','node_modules/']
patterns=[re.compile(r'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----'),re.compile(r'github_pat_[A-Za-z0-9_]{30,}'),re.compile(r'gh[pousr]_[A-Za-z0-9]{30,}'),re.compile(r'sk-(?:proj-|ant-)?[A-Za-z0-9_-]{25,}')]
issues=[]
for name in filter(None,paths):
 file=root/name
 if any(name.startswith(prefix) for prefix in blocked) or file.suffix.lower() in ['.sqlite','.sqlite3','.db','.zip'] or file.name=='.env' or file.name.startswith('.env.'):
  issues.append((name,'runtime/private path'));continue
 if file.is_symlink():issues.append((name,'symbolic link'));continue
 if file.suffix in ['.woff2','.png','.pdf']:continue
 try:text=file.read_text()
 except (UnicodeError,OSError):continue
 if any(pattern.search(text) for pattern in patterns):issues.append((name,'credential-shaped content'))
 if any(ident in text for ident in private_ids):issues.append((name,'private migration identifier'))
if issues:
 for name,reason in issues:print(reason+': '+name)
 raise SystemExit(1)
print('Release audit passed: '+str(len(list(filter(None,paths))))+' tracked files; no blocked paths or detected private credentials/identifiers.')
