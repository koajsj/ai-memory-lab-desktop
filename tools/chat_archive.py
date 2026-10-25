"""Read a local session ZIP as evidence, never as memory or executable input."""
from datetime import datetime, timezone
from io import BytesIO
from pathlib import Path
import hashlib
import stat
import re
import zipfile

from .json_input import parse_json
from .engine import forbidden_personal

MAX_ZIP = 4_000_000
MAX_JSON = 4_000_000
MAX_TOTAL = 8_000_000
MAX_TEXT = 1_000_000


class ArchiveError(ValueError):
    pass


def _invalid(reason):
    raise ArchiveError('会话ZIP' + reason)


MASK='[高敏内容已遮蔽]'


def display_text(value):
    """Redact before IPC. Raw archives and internal/tool bodies are never cached here."""
    value=re.sub(r'-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----.*?(?:-----END (?:[A-Z0-9]+ )*PRIVATE KEY-----|$)',MASK,value,flags=re.S|re.I)
    # Work on individual visible clauses: a secret must not suppress an independent safe statement.
    return ''.join(MASK if forbidden_personal(clause) else clause
                   for clause in re.split(r'([。；;，,\n])',value))


def _identifier(value):
    return isinstance(value,str) and bool(re.fullmatch(r'[A-Za-z0-9_-]{1,128}',value)) and not forbidden_personal(value)


def inspect_chat_archive(path):
    """Return masked user/assistant text and verified source metadata; omit tool/reasoning bodies."""
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
                if (name != item.filename or not name or name in names or name.startswith('/') or '\\' in name
                        or ':' in name or any(part in ('.', '..') for part in name.rstrip('/').split('/'))
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
    if not _identifier(session):
        _invalid('会话标识缺失')
    batches, by_message, seen_parts, anomalies = [], {}, set(), []
    previous_time = -1
    counts = dict(sessions=1,batches=0,messages=len(messages),user=0,assistant=0,assistant_with_text=0,
                  text_parts=0,visible_text_chars=0,tool=0,reasoning=0,unknown_parts=0,masked_messages=0)
    text_size = 0
    for item in messages:
        if not isinstance(item, dict) or not isinstance(item.get('info'), dict) or not isinstance(item.get('parts'), list):
            _invalid('消息字段无效')
        info = item['info']
        ident, role, created = info.get('id'), info.get('role'), info.get('time', {}).get('created') if isinstance(info.get('time'), dict) else None
        if (not _identifier(ident) or ident in by_message or info.get('sessionID') != session
                or role not in ('user', 'assistant') or type(created) is not int
                or created < previous_time or not 0 <= created <= 253402300799999):
            _invalid('消息标识、角色、会话或时间顺序无效')
        previous_time = created
        parent=info.get('parentID')
        if parent is not None and (not _identifier(parent) or parent not in by_message):
            _invalid('消息父来源缺失或尚未出现')
        parts,contents={},[]
        for part in item['parts']:
            if not isinstance(part,dict) or not isinstance(part.get('type'),str):_invalid('消息片段无效')
            if any(field in part and part[field]!=expected for field,expected in (('messageID',ident),('sessionID',session))):
                _invalid('片段与所属消息不一致')
            if 'id' in part:
                if not _identifier(part['id']) or part['id'] in seen_parts:_invalid('片段标识无效或重复')
                seen_parts.add(part['id'])
            kind=part['type']
            if kind not in ('text','tool','reasoning','step-start','step-finish'):
                kind='unknown';counts['unknown_parts']+=1
                anomalies.append(dict(message_id=ident,reason='未知片段类型；未作为回答或记忆输入'))
            parts[kind]=parts.get(kind,0)+1
            if kind in ('tool','reasoning'):counts[kind]+=1
            if kind=='text':
                if not isinstance(part.get('text'),str):_invalid('对话文字字段无效')
                contents.append(part['text']);counts['text_parts']+=1
        content='\n'.join(contents)
        text_size+=len(content)
        if text_size>MAX_TEXT:_invalid('可展示文字超过上限')
        visible=display_text(content)
        masked=visible!=content
        counts['masked_messages']+=masked;counts['visible_text_chars']+=len(visible)
        record=dict(id=ident,role=role,parent_id=parent,text=visible,masked=masked,parts=parts,
                    time=datetime.fromtimestamp(created / 1000, timezone.utc).isoformat(),sequence=len(by_message)+1)
        if role=='user':
            if not content.strip():
                anomalies.append(dict(message_id=ident,reason='用户消息无可展示文字；仍保留原始边界'))
            batch=dict(number=len(batches)+1,user=record,assistant=[])
            batches.append(batch);counts['user']+=1
        else:
            if parent is None:_invalid('助手消息没有可核对的用户来源')
            batch=by_message[parent]
            batch['assistant'].append(record);counts['assistant']+=1;counts['assistant_with_text']+=bool(content)
        by_message[ident]=batch
    counts['batches']=len(batches)
    counts['anomalies']=len(anomalies)
    if not batches:_invalid('没有用户对话')
    return dict(format='memory-lab.chat-archive.v1',name=display_text(path.name),session_id=session,
                sha256=hashlib.sha256(raw).hexdigest(),counts=counts,batches=batches,anomalies=anomalies,
                historical_memory_evidence=False,display_redacted=True)
