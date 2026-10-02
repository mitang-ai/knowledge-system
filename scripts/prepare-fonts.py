from pathlib import Path
import re,shutil,json
root=Path(__file__).resolve().parents[1]
ids=['noto-sans-sc','noto-serif-sc','lxgw-wenkai-tc','lxgw-wenkai-mono-tc','zcool-xiaowei','zcool-qingke-huangyou','inter','ibm-plex-sans','source-sans-3','literata']
manifest=[]
for ident in ids:
 source=root/'node_modules'/'@fontsource'/ident
 dest=root/'public'/'fonts'/ident
 dest.mkdir(parents=True,exist_ok=True)
 css=(source/'400.css').read_text()
 css=re.sub(r",\s*url\([^)]*\.woff\) format\('woff'\)", '', css)
 files=set(re.findall(r'url\(([^)]+)\)',css))
 for file in files:
  relative=file.strip('"\'').removeprefix('./')
  target=dest/relative;target.parent.mkdir(parents=True,exist_ok=True)
  shutil.copy2(source/relative,target)
 (dest/'400.css').write_text(css)
 for legacy in dest.rglob('*.woff'):legacy.unlink()
 for license in source.glob('*LICENSE*'):shutil.copy2(license,dest/license.name)
 meta=json.loads((source/'metadata.json').read_text())
 manifest.append({'id':ident,'family':meta.get('family'),'license':meta.get('license'),'source':'https://fontsource.org/fonts/'+ident})
(root/'public/fonts/manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2))
print('Prepared',len(manifest),'open-source fonts; total',round(sum(x.stat().st_size for x in (root/'public/fonts').rglob('*') if x.is_file())/1024/1024,1),'MB')

for folder in ('cmaps', 'standard_fonts', 'wasm'):
 source=root/'node_modules'/'pdfjs-dist'/folder
 if source.exists():shutil.copytree(source,root/'public'/'pdfjs'/folder,dirs_exist_ok=True)
