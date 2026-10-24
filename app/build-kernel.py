"""Build the Windows x64 governance sidecar; archive audits remain host-independent."""
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

def archive_inventory(binary, *, reader=None):
    """Measure the actual onefile archive, including its bundled Python runtime."""
    size=binary.stat().st_size
    if size>=50_000_000:raise ValueError('治理内核必须小于50 MB（50,000,000字节）')
    if reader is None:
        from PyInstaller.archive.readers import CArchiveReader
        reader=CArchiveReader
    archive=reader(str(binary))
    entries=[dict(name=name,compressed_size=item[1],size=item[2],type=item[4]) for name,item in archive.toc.items()]
    compressed=sum(e['compressed_size'] for e in entries)
    modules=sorted(archive.open_embedded_archive('PYZ.pyz').toc)
    return dict(size=size,compressed_entries_size=compressed,
                uncompressed_entries_size=sum(e['size'] for e in entries),
                container_overhead_size=size-compressed,
                largest_entries=sorted(entries,key=lambda e:e['size'],reverse=True)[:15],
                python_modules=modules)

def main():
    if len(sys.argv)==3 and sys.argv[1]=='--audit':
        print(json.dumps(archive_inventory(Path(sys.argv[2])),indent=2));return
    if sys.platform!='win32':raise SystemExit('交付内核仅在Windows x64原生构建；其他开发机使用Python源码和原子检查')
    host=subprocess.check_output(['rustc','-vV'],text=True).split('host: ',1)[1].splitlines()[0]
    if platform.machine().upper() not in ('AMD64','X86_64') or host!='x86_64-pc-windows-msvc':raise SystemExit('Windows交付需要原生x64 Python和MSVC工具链')
    import PyInstaller
    if PyInstaller.__version__!='6.16.0':raise SystemExit('请使用PyInstaller==6.16.0及Windows x64 Python3.10–3.14构建')
    out=APP/'src-tauri/binaries';out.mkdir(exist_ok=True)
    with TemporaryDirectory(prefix='memory-kernel-build-') as tmp:
        tmp=Path(tmp);entry=tmp/'entry.py'
        entry.write_text('from tools.desktop_service import main\nraise SystemExit(main())\n',encoding='utf-8')
        subprocess.run([sys.executable,'-m','PyInstaller','--noconfirm','--onefile','--console','--noupx','--name','memory-kernel','--paths',str(ROOT),'--distpath',str(tmp/'dist'),'--workpath',str(tmp/'work'),'--specpath',str(tmp),str(entry)],check=True,cwd=ROOT)
        binary=tmp/'dist/memory-kernel.exe'
        inventory=archive_inventory(binary) # Reject oversize/invalid archives before replacing a valid worker.
        target=out/('memory-kernel-'+host+'.exe')
        # Atomic replacement of this generated sidecar; never touch user experiments.
        staged=target.with_suffix(target.suffix+'.new');staged.write_bytes(binary.read_bytes());staged.chmod(0o755);os.replace(staged,target)
        files=['app/build-kernel.py','tools/desktop_service.py','tools/chat_archive.py','tools/engine.py','tools/governance.py','tools/json_input.py']
        record=dict(format='memory-lab.kernel-build.v1',target=host,python=platform.python_version(),pyinstaller=PyInstaller.__version__,sha256=hashlib.sha256(target.read_bytes()).hexdigest(),size=target.stat().st_size,archive=inventory,inputs={p:hashlib.sha256((ROOT/p).read_bytes()).hexdigest() for p in files})
        (out/'kernel-manifest.json').write_text(json.dumps(record,indent=2)+'\n',encoding='utf-8')
        print(json.dumps(record,indent=2))
if __name__=='__main__':main()
