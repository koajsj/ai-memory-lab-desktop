"""Build the existing Python authority as a self-contained native sidecar, never cross-compile."""
from pathlib import Path
import hashlib
import json
import os
import platform
import subprocess
import sys
from tempfile import TemporaryDirectory

APP=Path(__file__).resolve().parent
ROOT=APP.parent

def main():
    host=subprocess.check_output(['rustc','-vV'],text=True).split('host: ',1)[1].splitlines()[0]
    if sys.platform=='win32' and (platform.machine().upper() not in ('AMD64','X86_64') or host!='x86_64-pc-windows-msvc'):raise SystemExit('Windows交付需要原生x64 Python和MSVC工具链')
    import PyInstaller
    if PyInstaller.__version__!='6.16.0':raise SystemExit('请使用PyInstaller==6.16.0及Python3.10–3.14构建（macOS本地检查也支持3.9）')
    out=APP/'src-tauri/binaries';out.mkdir(exist_ok=True)
    with TemporaryDirectory(prefix='memory-kernel-build-') as tmp:
        tmp=Path(tmp);entry=tmp/'entry.py'
        entry.write_text('from tools.desktop_service import main\nraise SystemExit(main())\n',encoding='utf-8')
        subprocess.run([sys.executable,'-m','PyInstaller','--noconfirm','--clean','--onefile','--console','--name','memory-kernel','--paths',str(ROOT),'--distpath',str(tmp/'dist'),'--workpath',str(tmp/'work'),'--specpath',str(tmp),str(entry)],check=True,cwd=ROOT)
        suffix='.exe' if sys.platform=='win32' else ''
        binary=tmp/'dist'/('memory-kernel'+suffix)
        target=out/('memory-kernel-'+host+suffix)
        # Atomic replacement of this generated sidecar; never touch user experiments.
        staged=target.with_suffix(target.suffix+'.new');staged.write_bytes(binary.read_bytes());staged.chmod(0o755);os.replace(staged,target)
        files=['tools/desktop_service.py','tools/engine.py','tools/governance.py','tools/json_input.py']
        record=dict(format='memory-lab.kernel-build.v1',target=host,python=platform.python_version(),pyinstaller=PyInstaller.__version__,sha256=hashlib.sha256(target.read_bytes()).hexdigest(),size=target.stat().st_size,inputs={p:hashlib.sha256((ROOT/p).read_bytes()).hexdigest() for p in files})
        (out/'kernel-manifest.json').write_text(json.dumps(record,indent=2)+'\n',encoding='utf-8')
        print(json.dumps(record,indent=2))
if __name__=='__main__':main()
