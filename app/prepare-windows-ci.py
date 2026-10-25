"""Export reviewed Windows build inputs without private data or generated artifacts."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil

ROOT = Path(__file__).resolve().parents[1]


def export(destination):
    destination = Path(destination).resolve()
    if destination.exists() or destination == ROOT or ROOT in destination.parents:
        raise ValueError('Use a new directory outside the project; never overwrite a checkout')
    manifest = json.loads((ROOT / 'source-manifest.json').read_text(encoding='utf-8'))
    if manifest.get('format') != 'memory-lab.private-source.v1':
        raise ValueError('Private Windows source manifest required')
    for name, record in manifest['files'].items():
        rel = Path(name)
        if rel.is_absolute() or '..' in rel.parts or not rel.parts or '\\' in name:
            raise ValueError('Invalid source path')
        source = ROOT / rel
        if source.is_symlink() or not source.is_file() or any(p.is_symlink() for p in source.parents if p != ROOT and ROOT in p.parents):
            raise ValueError('Missing or linked build input: ' + name)
        raw = source.read_bytes()
        if len(raw) != record['size'] or hashlib.sha256(raw).hexdigest() != record['sha256']:
            raise ValueError('Source mismatch: ' + name)
    demo = json.loads((ROOT / 'app/src/public-demo.json').read_text(encoding='utf-8'))
    if demo.get('mode') != 'SIMULATED' or demo.get('role') != 'ATLAS_DEMO':
        raise ValueError('Only the reviewed independent simulation may be bundled')
    destination.mkdir(parents=True)
    for name in manifest['files']:
        target = destination / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(ROOT / name, target)
    shutil.copyfile(ROOT / 'source-manifest.json', destination / 'source-manifest.json')
    return manifest['files']


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', required=True)
    result = export(parser.parse_args().output)
    print(json.dumps({'files': len(result) + 1, 'listed_bytes': sum(r['size'] for r in result.values())}, indent=2))
