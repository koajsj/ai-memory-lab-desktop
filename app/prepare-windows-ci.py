"""Export an allowlisted private build checkout; never copy competition inputs or Git history."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil

ROOT = Path(__file__).resolve().parents[1]
SHARED = ['index.html', 'style.css', 'state.js', 'model.js', 'app.js', 'platform.js',
          'native-ui.js', 'sandbox.js', 'lab-ui.js', 'src/graph.js', 'src/view-math.mjs', 'src/audit.mjs']
FILES = ['memory-rules.md', 'requirements-dev.txt', '.github/workflows/windows.yml',
         'docs/windows-delivery.md', 'tests/test_desktop_service.py',
         'tools/desktop_service.py', 'tools/chat_archive.py', 'tools/engine.py', 'tools/governance.py', 'tools/json_input.py',
         'tools/check_native_worker.py', 'tools/check_windows_release.mjs',
         'app/package.json', 'app/package-lock.json', 'app/build.mjs', 'app/sync-frontend.mjs',
         'app/build-kernel.py', 'app/check-kernel.mjs', 'app/package-windows.mjs',
         'app/prepare-windows-ci.py', 'app/README.md', 'app/QUICKSTART.md',
         'app/THIRD_PARTY_NOTICES.txt', 'app/icon.png', 'app/src-tauri/Cargo.toml',
         'app/src-tauri/Cargo.lock', 'app/src-tauri/build.rs', 'app/src-tauri/tauri.conf.json',
         'app/src-tauri/tauri.windows.conf.json', 'app/src-tauri/windows-hooks.nsh', 'app/src-tauri/src/main.rs',
         'app/src-tauri/src/desktop.rs', 'app/src-tauri/src/model_api.rs',
         'app/src-tauri/icons/icon.png', 'app/src-tauri/icons/icon.ico',
         'web-public/package.json', 'web-public/package-lock.json', 'web-public/build.mjs',
         'web-public/check.mjs', 'web-public/check-sandbox.mjs', 'web-public/check-native.mjs',
         'web-public/icon.png', 'web-public/THIRD_PARTY_NOTICES.txt',
         'web-public/evaluation.json', 'web-public/src/public-demo.json']


def export(destination):
    destination = Path(destination).resolve()
    if destination.exists() or destination == ROOT or ROOT in destination.parents:
        raise ValueError('Use a new directory outside the competition project; never overwrite a checkout')
    paths = sorted(set(FILES + ['web-public/' + name for name in SHARED]))
    # Resolve and inspect the entire allowlist before creating any output.
    for name in paths:
        source = ROOT / name
        if not source.is_file() or source.is_symlink():
            raise ValueError('Missing or linked build input: ' + name)
    demo = json.loads((ROOT / 'web-public/src/public-demo.json').read_text(encoding='utf-8'))
    if demo.get('mode') != 'SIMULATED' or demo.get('role') != 'ATLAS_DEMO':
        raise ValueError('Only the reviewed independent public simulation may be bundled')
    destination.mkdir(parents=True)
    for name in paths:
        target = destination / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(ROOT / name, target)
    # Preserve license wording; remove trailing whitespace only in the exported copies.
    for name in ['app/THIRD_PARTY_NOTICES.txt', 'web-public/THIRD_PARTY_NOTICES.txt']:
        notice = destination / name
        notice.write_text('\n'.join(line.rstrip() for line in notice.read_text(encoding='utf-8').splitlines()).rstrip() + '\n', encoding='utf-8')
    # This is an independent fictional demo, not the official replay or its evaluation.
    for name in SHARED:
        target = destination / 'app' / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(destination / 'web-public' / name, target)
    html = destination / 'app/index.html'
    html.write_text(html.read_text(encoding='utf-8').replace("connect-src 'none'", 'connect-src ipc: http://ipc.localhost'), encoding='utf-8')
    package = destination / 'app/package.json'
    settings = json.loads(package.read_text(encoding='utf-8'))
    settings['scripts']['check'] = 'node sync-frontend.mjs --check && npm --prefix ../web-public run check && node ../tools/check_windows_release.mjs'
    package.write_text(json.dumps(settings, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    data = 'window.REPLAY_DATA=' + json.dumps(demo, ensure_ascii=False, separators=(',', ':')).replace('<', '\\u003c') + ';\n'
    report = json.loads((destination / 'web-public/evaluation.json').read_text(encoding='utf-8'))
    inputs = ['memory-rules.md', 'tools/engine.py', 'tools/governance.py', 'tools/desktop_service.py', 'tools/chat_archive.py',
              'tools/json_input.py', 'web-public/src/public-demo.json']
    # Preserve the public evaluation's original claims; input hashes are build provenance only.
    report['inputs'] = {name: hashlib.sha256((destination / name).read_bytes()).hexdigest() for name in inputs}
    report['inputs']['app/data.js'] = hashlib.sha256(data.encode('utf-8')).hexdigest()
    (destination / 'app/evaluation.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    (destination / '.gitignore').write_text('node_modules/\n__pycache__/\n.pytest_cache/\napp/src-tauri/target/\napp/src-tauri/gen/\napp/src-tauri/binaries/\napp/web-dist/\napp/graph.bundle.js\napp/data.js\napp/assets-manifest.json\napp/releases/\napp/ci-artifact/\nweb-public/dist/\nweb-public/graph.bundle.js\nweb-public/data.js\n*.log\n.env*\n.venv/\n', encoding='utf-8')
    (destination / '.gitattributes').write_text('* text=auto eol=lf\n*.png binary\n*.ico binary\n', encoding='utf-8')
    (destination / 'README.md').write_text('# AI Memory Lab · private desktop build\n\nWindows native CI source. The bundled ATLAS_DEMO is an independent SIMULATED dataset.\nNo official competition inputs, private memories, platform logs, credentials or prebuilt binaries are included.\n\nPush build-related changes to main, or run **Actions → Windows native build → Run workflow**. A successful main build publishes its verified unsigned Windows installer and SHA-256 file in a private Release; manual runs retain a private workflow artifact for 14 days. Windows installation and real model use require separate acceptance. See [Windows build and verification](docs/windows-delivery.md).\n', encoding='utf-8')
    listing = {p.relative_to(destination).as_posix(): {'size': p.stat().st_size, 'sha256': hashlib.sha256(p.read_bytes()).hexdigest()}
               for p in sorted(destination.rglob('*')) if p.is_file()}
    (destination / 'source-manifest.json').write_text(json.dumps({'format': 'memory-lab.private-source.v1', 'files': listing}, indent=2) + '\n', encoding='utf-8')
    return listing


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', required=True)
    result = export(parser.parse_args().output)
    print(json.dumps({'files': len(result) + 1, 'listed_bytes': sum(r['size'] for r in result.values())}, indent=2))
