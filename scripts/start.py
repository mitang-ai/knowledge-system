"""Start the bundled, dependency-free local application and open the browser."""
from pathlib import Path
import sys, subprocess, time, urllib.request, urllib.error, webbrowser, os

root = Path(__file__).resolve().parents[1]
if not (root / 'dist/index.html').is_file():
    raise SystemExit('缺少构建文件，请先运行 npm install 和 npm run build。')
port = os.environ.get('SEDIMENT_PORT', '8787')
server = subprocess.Popen([sys.executable, str(root / 'server/app.py')], cwd=root)
try:
    for _ in range(50):
        if server.poll() is not None: raise SystemExit('服务未能启动，请检查端口是否已占用。')
        try:
            urllib.request.urlopen(f'http://127.0.0.1:{port}/api/state', timeout=1)
            break
        except urllib.error.HTTPError as e:
            if e.code == 401: break
        except urllib.error.URLError: pass
        time.sleep(.1)
    webbrowser.open(f'http://127.0.0.1:{port}')
    print('保持此窗口打开。按 Ctrl+C 停止服务。', flush=True)
    server.wait()
except KeyboardInterrupt:
    pass
finally:
    server.terminate()
    server.wait(timeout=5)
