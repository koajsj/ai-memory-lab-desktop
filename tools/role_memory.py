"""Readable, verified role projection. SQLite is authoritative; Markdown is never imported as state."""
import hashlib
import json
import os
from pathlib import Path
import re
import tempfile


def direct_statements(text, *, memories=()):
    """Bounded local parsing, preserving exact clauses; unresolved references are not inferred."""
    from .engine import forbidden_personal, personal_kind
    out=[]
    # An external container taints its remaining body, not independent owner statements before it.
    external=re.search(r'(?:^|[。！？!?；;\n])\s*(?:(?:请)?(?:分析|总结|翻译|阅读|检查|解释).{0,20})?(?:以下(?:内容|资料|文本)|外部资料|引用(?:内容|文本)?|转发(?:内容)?|第三方(?:消息)?|网页|邮件|短信|文档|日志|工具输出|quoted text|forwarded message)\s*[:：]',text,re.I)
    if external:text=text[:external.start()]
    # Split commas only before an explicit new subject, retaining conditions and correction complements.
    clauses=[]
    for clause in re.split(r'(?<=[。！？!?；;\n])',text):
        if clause.rstrip().endswith(('?','？')):continue
        clause=clause.strip().rstrip('。！!；;\n')
        clauses.extend([clause] if re.match(r'^(?:(?:更正|纠正)[:：]\s*)?(?:如果|只有|当)',clause.strip()) else
                       re.split(r'[，,]\s*(?=(?:更正[:：]|纠正[:：]|我(?:的|偏好|不喜欢|喜欢|习惯|计划)))',clause))
    for raw in clauses:
        quote=raw.strip()
        correction=bool(re.match(r'^(?:更正|纠正)[:：]',quote))
        sentence=re.sub(r'^(?:更正|纠正)[:：]\s*','',quote)
        # Resolve only a bounded task reference against current admitted direct facts, never summaries.
        if sentence in ('这项任务已完成','该任务已完成'):
            tasks=[r for r in memories if r['part']=='current' and r['payload'].get('kind')=='task'
                   and not r['parents'] and any(x['source_kind']=='owner_direct' for x in r['source'])]
            if len(tasks)!=1:continue
            task=tasks[0];title=re.fullmatch(r'我的任务是(.+)',task['payload']['value'])
            if not title:continue
            out.append(dict(op='set',key=task['key'],value='我的任务'+title[1]+'已完成',kind='task',state='completed',
                            basis='self_report',evidence=dict(source='current_input',quote=quote)))
            continue
        deletion=re.fullmatch(r'(?:请)?(?:删除|忘记)(?:我的?)?(健康(?:信息|记忆)?|诊断|住址|地址|联系方式|手机号|家庭(?:信息|记忆)?|personal_(?:health|address|contact|family)|preference)',sentence)
        if deletion:
            name=deletion[1];key=name if name.startswith('personal_') or name=='preference' else 'personal_'+('health' if name.startswith('健康') or name=='诊断' else 'address' if name in ('住址','地址') else 'contact' if name in ('联系方式','手机号') else 'family')
            out.append(dict(op='delete',key=key,basis='self_report',evidence=dict(source='current_input',quote=quote)))
            continue
        if (not sentence or len(sentence)>500 or forbidden_personal(sentence)
                or re.search(r'[“”"\'「」]|(?:不要|别|无需|不用)(?:记住|记|保存|存入|写入)|忘记|删除|可能|也许|据说|听说|开玩笑|反话|反讽',sentence)):
            continue
        # Keep conditional preferences/plans as conditional statements, never assert their fulfilment.
        subject=sentence
        if re.match(r'^(?:如果|只有|当).+[，,]我(?:计划|偏好|喜欢)',sentence):
            subject=re.split(r'[，,](?=我)',sentence,maxsplit=1)[1]
        if not re.match(r'^(?:请记住)?(?:我(?:的|不喜欢|不再(?:偏好|喜欢)|偏好|喜欢|习惯|计划|决定|是|住在|患有|确诊|现在|叫|在|从|于|今年|目前|最近|刚|已经|还|已|要|准备|打算|希望|需要|会|能|有|负责|就职|从事|每天|每周|周末)|My |I (?:prefer|live at|have been diagnosed|suffer from))',subject,re.I):
            continue
        correction=correction or bool(re.match(r'^我(?:现在(?:偏好|喜欢)|不再(?:偏好|喜欢))',sentence))
        category=personal_kind(sentence)
        key='personal_'+category if category else next((key for pattern,key in (
            (r'^我(?:现在)?(?:不喜欢|不再(?:偏好|喜欢)|偏好|喜欢)','preference'),(r'^I prefer','preference'),
            (r'^我习惯','habit'),(r'^我的目标','goal'),(r'^我的项目','project'),
            (r'^我计划','plan'),(r'^我正在','progress')) if re.search(pattern,subject,re.I)),None)
        project=re.match(r'^我的项目(.+?)(?:使用|采用|选择)',sentence)
        if project:key='project_'+hashlib.sha256(project[1].strip().encode()).hexdigest()[:12]
        fields={}
        task_sentence='我的任务'+sentence[len('我的任务是'):] if sentence.startswith('我的任务是') else sentence
        completed=re.fullmatch(r'我的任务([^，,]+?)(?:[，,]\s*)?已完成',task_sentence)
        task=completed or re.fullmatch(r'我的任务是([^，,]+)',sentence)
        if task:
            title=task[1].strip()
            # Do not turn unresolved status clauses or negated completion into a new title.
            if (completed and re.search(r'(?:并非|不是|没有|不|未|没)$',title)
                    or not completed and re.search(r'(?:已完成|已取消|已暂停|暂时不做|(?:尚|并)?未完成)$',title)):
                continue
            key='task_'+hashlib.sha256(title.encode()).hexdigest()[:12]
            fields=dict(kind='task',state='completed' if completed else 'current')
            if completed:sentence='我的任务'+title+'已完成'
        elif sentence.startswith('我的任务'):continue  # Unsupported lifecycle wording must not become unrelated background.
        if not key:key='personal_background_'+str(len(out)+1)
        out.append(dict(op='set',key=key,value=sentence,basis='self_report',
                        evidence=dict(source='current_input',quote=quote),**fields,
                        **(dict(current_correction=True,archive_old=True) if correction else {})))
    # Identical clauses merge. Different values of one field remain unresolved, not last-write-wins.
    unique={}
    for c in out:unique.setdefault((c['key'],c.get('value'),c['op']),c)
    counts={c['key']:sum(x['key']==c['key'] for x in unique.values()) for c in unique.values()}
    return [c for c in unique.values() if counts[c['key']]==1]


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
