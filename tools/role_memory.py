"""Readable, verified role projection. SQLite is authoritative; Markdown is never imported as state."""
import hashlib
import json
import os
from pathlib import Path
import re
import tempfile


def direct_statements(text):
    """Small offline extractor, not general semantic understanding or historical execution evidence."""
    from .engine import forbidden_personal, personal_kind
    out=[]
    # Explicit external containers never become owner statements merely because a line starts with I/我.
    if re.search(r'(?:^|\n)\s*(?:(?:请)?(?:分析|总结|翻译|阅读|检查|解释).{0,20})?(?:以下(?:内容|资料|文本)|外部资料|引用(?:内容|文本)?|转发(?:内容)?|第三方(?:消息)?|网页|邮件|短信|文档|日志|工具输出|quoted text|forwarded message)\s*[:：]',text,re.I):return out
    # Quoted/forwarded material cannot grant direct-source authority. Other independent sentences remain usable.
    for raw in re.split(r'[。！？!?；;\n]+',text):
        sentence=raw.strip()
        correction=bool(re.match(r'^(?:更正|纠正)[:：]',sentence))
        sentence=re.sub(r'^(?:更正|纠正)[:：]\s*','',sentence)
        deletion=re.fullmatch(r'(?:请)?(?:删除|忘记)(?:我的?)?(健康(?:信息|记忆)?|诊断|住址|地址|联系方式|手机号|家庭(?:信息|记忆)?|personal_(?:health|address|contact|family)|preference)(?:。)?',sentence)
        if deletion:
            name=deletion[1];key=name if name.startswith('personal_') or name=='preference' else 'personal_'+('health' if name.startswith('健康') or name=='诊断' else 'address' if name in ('住址','地址') else 'contact' if name in ('联系方式','手机号') else 'family')
            out.append(dict(op='delete',key=key,basis='self_report',evidence=dict(source='current_input',quote=raw.strip())))
            continue
        if (not sentence or len(sentence)>500 or forbidden_personal(sentence)
                or re.search(r'[“”"\'「」]|(?:不要|别|无需|不用)(?:记住|记|保存|存入|写入)|忘记|删除',sentence)
                or not re.match(r'^(?:请记住)?(?:我(?:的|偏好|喜欢|习惯|计划|决定|是|住在|患有|确诊|现在|叫|在|从|于|今年|目前|最近|刚|已经|还|已|要|准备|打算|希望|需要|会|能|有|负责|就职|从事|每天|每周|周末)|My |I (?:prefer|live at|have been diagnosed|suffer from))',sentence,re.I)):
            continue
        category=personal_kind(sentence)
        key='personal_'+category if category else next((key for pattern,key in (
            (r'^我(?:现在)?(?:偏好|喜欢)','preference'),(r'^我习惯','habit'),
            (r'^我的目标','goal'),(r'^我的项目','project'),(r'^我计划','plan'),
            (r'^我正在','progress')) if re.search(pattern,sentence)),None)
        # Unclassified direct statements remain verbatim restricted notes, not inferred objective facts.
        if not key:key='personal_background_'+str(len(out)+1)
        out.append(dict(op='set',key=key,value=sentence,basis='self_report',
                        evidence=dict(source='current_input',quote=raw.strip()),
                        **(dict(current_correction=True,archive_old=True) if correction else {})))
    # Different values of the same field in one message stay unresolved, never last-write-wins.
    counts={c['key']:sum(x['key']==c['key'] for x in out) for c in out}
    return [c for c in out if counts[c['key']]==1]


def render_memory(state):
    def line(value):return str(value).replace('\r','').replace('\n','\n    ')
    lines=['# '+state['role']+' 角色记忆','',
           '> SQLite 为事务权威源；本文件由内核状态原子生成并读回核验。手工编辑不会授权或覆盖内核。',
           '> 私人本地文件，请谨慎共享；不随安装器、网页或发布产物分发。','',
           f"- 实验：{state['id']}",f"- 状态版本：{state['revision']}",
           f"- 守则 SHA-256：{state['rules']['sha256']}",'']
    names={'current':'当前有效','pending':'待核实／隔离','completed':'已完成','history':'历史'}
    versions={r['version_id']:r for r in state['governance']['versions']}
    for part,name in names.items():
        lines+=['## '+name,'']
        for key,p in state['snapshot'][part].items():
            record=next((r for r in versions.values() if r['key']==key.removesuffix('__previous') and r['revision']==p['version']),None)
            lines += ['### '+key,'',line(p['value']),'',
                      '- 状态：'+part+'；来源性质：'+p['confidence'],
                      '- 版本：'+str(p['version'])+'；保存范围：'+state['role']+' / '+state['id']]
            if record:
                lines+=['- 版本标识：'+record['version_id'],
                        '- 来源：'+line(json.dumps(record['source'],ensure_ascii=False)),
                        '- 记录时间：'+record['created_at'],
                        '- 派生与版本关系：'+line(json.dumps(dict(parents=record['parents'],relations=record['relations']),ensure_ascii=False))]
            for field in ('event_time','expires_at','due_at','task_status'):
                if field in p:lines+=['- '+field+'：'+line(p[field])]
            lines+=['']
        if not state['snapshot'][part]:lines+=['无记录。','']
    lines+=['## 退出与删除标记','']
    for record in versions.values():
        if record['payload'] is None:lines+=['- '+record['version_id']+'：'+record['lifecycle']+'（原值已清除）']
    lines+=['','## 本轮处理','']
    if state['frames']:
        f=state['frames'][-1];lines+=['- 轮次：'+str(f['round'])]
        for decision in f['decisions']:lines+=['- '+decision['action']+'：'+line(decision['reason'])]
    else:lines+=['尚无轮次。']
    return '\n'.join(lines)+'\n'


def publish(root,state):
    folder=Path(root)/'role-memory'/state['id']
    for p in (folder,folder.parent):
        if p.is_symlink():raise OSError('拒绝链接记忆目录')
    folder.mkdir(parents=True,exist_ok=True,mode=0o700)
    target=folder/(state['role']+'_mem.md')
    if target.is_symlink():raise OSError('拒绝链接记忆文件')
    # Only our own interrupted staging files can exist here; no active publisher holds this lock.
    for staged in folder.glob('.'+state['role']+'_*.tmp'):
        if staged.is_file() or staged.is_symlink():staged.unlink()
    expected=render_memory(state).encode('utf-8')
    if not target.exists() or target.read_bytes()!=expected:
        fd,name=tempfile.mkstemp(prefix='.'+state['role']+'_',suffix='.tmp',dir=folder)
        try:
            with os.fdopen(fd,'wb') as out:
                out.write(expected);out.flush();os.fsync(out.fileno())
            os.replace(name,target)
            # fsync the directory where supported; Windows replace is atomic on the same volume.
            if os.name!='nt':
                fd=os.open(folder,os.O_RDONLY)
                try:os.fsync(fd)
                finally:os.close(fd)
        finally:
            if os.path.exists(name):os.unlink(name)
    actual=target.read_bytes()
    if actual!=expected:raise OSError('角色记忆文件读回不一致')
    return dict(path=str(target),sha256=hashlib.sha256(actual).hexdigest(),revision=state['revision'],text=actual.decode())
