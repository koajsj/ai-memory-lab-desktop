"""Read a local session ZIP as evidence, never as memory or executable input."""
from datetime import datetime, timezone
from io import BytesIO
from pathlib import Path, PurePosixPath
import hashlib
import stat
import zipfile

from .json_input import parse_json

MAX_ZIP = 4_000_000
MAX_JSON = 4_000_000
MAX_TOTAL = 8_000_000
MAX_TEXT = 1_000_000


class ArchiveError(ValueError):
    pass


def _invalid(reason):
    raise ArchiveError('会话ZIP' + reason)


def inspect_chat_archive(path):
    """Return only user/assistant text and source identifiers; omit tools/reasoning."""
    path = Path(path)
    if path.is_symlink() or not path.is_file() or path.stat().st_size > MAX_ZIP:
        _invalid('不存在、是链接或超过4MB')
    raw = path.read_bytes()
    try:
        with zipfile.ZipFile(BytesIO(raw)) as archive:
            entries = archive.infolist()
            if not 1 <= len(entries) <= 16 or sum(i.file_size for i in entries) > MAX_TOTAL:
                _invalid('条目数或解压总量超限')
            names = set()
            for item in entries:
                # ZipInfo.filename can hide Windows separators or NUL suffixes on read.
                name = item.orig_filename
                parts = PurePosixPath(name).parts
                if (name != item.filename or not name or name in names or name.startswith('/') or '\\' in name
                        or any(part in ('.', '..') for part in parts)
                        or stat.S_ISLNK(item.external_attr >> 16)
                        or item.flag_bits & 1 or item.compress_type not in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED)
                        or item.file_size > MAX_JSON
                        or item.file_size > max(item.compress_size, 1) * 200):
                    _invalid('包含不安全路径、链接、加密条目或异常压缩数据')
                names.add(name)
            data_files = [i for i in entries if not i.is_dir()]
            if len(data_files) != 1 or not data_files[0].filename.startswith('chat/export/') or not data_files[0].filename.endswith('.json'):
                _invalid('不是受支持的单会话导出')
            with archive.open(data_files[0]) as source:
                payload = source.read(MAX_JSON + 1)
            if len(payload) > MAX_JSON:
                _invalid('会话JSON超过4MB')
    except (zipfile.BadZipFile, zipfile.LargeZipFile, RuntimeError, OSError) as error:
        raise ArchiveError('会话ZIP损坏或无法读取') from error
    try:
        document = parse_json(payload.decode('utf-8-sig'))
    except (UnicodeError, ValueError) as error:
        raise ArchiveError('会话ZIP包含无效的UTF-8或JSON') from error
    if not isinstance(document, dict) or not isinstance(document.get('info'), dict) or not isinstance(document.get('messages'), list):
        _invalid('缺少会话或消息结构')
    messages = document['messages']
    if not 1 <= len(messages) <= 1000:
        _invalid('消息数量无效')
    session = document['info'].get('id')
    if not isinstance(session, str) or not session:
        _invalid('会话标识缺失')
    batches, users, seen = [], {}, set()
    previous_time = -1
    counts = dict(batches=0, messages=len(messages), user=0, assistant=0, assistant_with_text=0)
    text_size = 0
    for item in messages:
        if not isinstance(item, dict) or not isinstance(item.get('info'), dict) or not isinstance(item.get('parts'), list):
            _invalid('消息字段无效')
        info = item['info']
        ident, role, created = info.get('id'), info.get('role'), info.get('time', {}).get('created') if isinstance(info.get('time'), dict) else None
        if (not isinstance(ident, str) or not ident or ident in seen or info.get('sessionID') != session
                or role not in ('user', 'assistant') or type(created) is not int
                or created <= previous_time or not 0 <= created <= 253402300799999):
            _invalid('消息标识、角色、会话或时间顺序无效')
        seen.add(ident)
        previous_time = created
        if not all(isinstance(part, dict) and isinstance(part.get('type'), str) for part in item['parts']):
            _invalid('消息片段无效')
        contents = [part.get('text') for part in item['parts'] if part['type'] == 'text']
        if any(not isinstance(value, str) for value in contents):
            _invalid('对话文字字段无效')
        content = '\n'.join(contents)
        text_size += len(content)
        if text_size > MAX_TEXT:
            _invalid('可展示文字超过上限')
        record = dict(id=ident, text=content, time=datetime.fromtimestamp(created / 1000, timezone.utc).isoformat())
        if role == 'user':
            if not content.strip():
                _invalid('用户消息没有文字')
            batch = dict(number=len(batches) + 1, user=record, assistant=[])
            batches.append(batch)
            users[ident] = batch
            counts['user'] += 1
        else:
            parent = info.get('parentID')
            if parent not in users:
                _invalid('助手消息没有可核对的用户来源')
            users[parent]['assistant'].append(record)
            counts['assistant'] += 1
            counts['assistant_with_text'] += bool(content)
    counts['batches'] = len(batches)
    if not batches:
        _invalid('没有用户对话')
    return dict(format='memory-lab.chat-archive.v1', name=path.name,
                sha256=hashlib.sha256(raw).hexdigest(), counts=counts, batches=batches,
                historical_memory_evidence=False)
