"""Exercise the packaged stdio kernel with no Python/Node in its PATH (no GUI or real API)."""
import argparse
import json
import os
from pathlib import Path
import subprocess
from tempfile import TemporaryDirectory


def check(binary):
    binary = Path(binary).resolve(strict=True)
    env = dict(os.environ)
    # os.environ is case-insensitive on Windows; a plain copied dict is not.
    env['PATH'] = str(Path(os.environ['SystemRoot']) / 'System32') if os.name == 'nt' else '/usr/bin:/bin'
    env.pop('PYTHONHOME', None)
    env.pop('PYTHONPATH', None)
    with TemporaryDirectory(prefix='memory-worker-') as tmp:
        root = Path(tmp).resolve() / '中文 空格 实验'

        def invoke(request, directory=root):
            proc = subprocess.run([str(binary), str(directory)], input=json.dumps(request, ensure_ascii=False).encode('utf-8'),
                                  capture_output=True, env=env, cwd=tmp, timeout=40)
            assert proc.returncode == 0, 'worker did not exit successfully'
            response = json.loads(proc.stdout.decode('utf-8'))
            assert response['ok'] is True, response.get('error')
            return response['result']

        exp = invoke({'op': 'create', 'name': '原生进程实验', 'rules': '保留来源；候选不得成为确定事实。'})
        pending = invoke({'op': 'prepare', 'id': exp['id'], 'revision': exp['revision'], 'request_id': 'cancelled', 'input': '消息', 'model': {}})
        exp = invoke({'op': 'abort', 'id': exp['id'], 'revision': pending['revision'], 'request_id': 'cancelled', 'status': 'cancelled'})
        # Terminate a worker waiting for input; a subsequent process must recover committed state.
        child = subprocess.Popen([str(binary), str(root)], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env, cwd=tmp)
        try:
            child.terminate()
            child.communicate(timeout=15)
        finally:
            if child.poll() is None:
                child.kill()
                child.communicate()
        assert invoke({'op': 'open', 'id': exp['id']}) == exp
        p = invoke({'op': 'prepare', 'id': exp['id'], 'revision': exp['revision'], 'request_id': 'r', 'input': '我偏好简洁回答', 'model': {}})
        exp = invoke({'op': 'finish', 'id': exp['id'], 'revision': p['revision'], 'request_id': 'r', 'reply': '模拟HTTP测试响应', 'usage': None, 'candidates': [{'op': 'set', 'key': 'preference', 'value': '简洁回答'}]})
        exp = invoke({'op': 'decide', 'id': exp['id'], 'revision': exp['revision'], 'index': 0, 'confirm': True})
        assert exp['snapshot']['current']['preference']['value'] == '简洁回答'
        assert invoke({'op': 'open', 'id': exp['id']}) == exp
        exported = invoke({'op': 'export', 'id': exp['id'], 'sections': ['rules', 'memory']})
        assert exported['mode'] == 'MODEL_EXPERIMENT' and 'turns' not in exported
        invalid_root = Path(tmp) / 'not-a-directory'
        invalid_root.write_text('must not overwrite', encoding='utf-8')
        bad = subprocess.run([str(binary), str(invalid_root)], input=b'{"op":"list"}', capture_output=True, env=env, cwd=tmp, timeout=40)
        assert bad.returncode != 0 or json.loads(bad.stdout.decode('utf-8'))['ok'] is False
        assert invalid_root.read_text(encoding='utf-8') == 'must not overwrite'
        assert invoke({'op': 'remove', 'id': exp['id']}) is True
        assert invoke({'op': 'list'}) == []
    print('PASS: packaged kernel: restricted PATH, UTF-8/spaces, save/reopen/export/delete, cancellation, terminated process recovery and invalid destination; no GUI/API test')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('binary')
    check(parser.parse_args().binary)
