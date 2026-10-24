"""通用结构化记忆引擎；不解析原始自然语言，不承担真实身份认证。"""
import json
import os
from pathlib import Path
import re
import sqlite3
import unicodedata
from dataclasses import dataclass
from datetime import date
from .json_input import parse_json
from .governance import Governance, TABLES

STATES = ('current', 'completed', 'history', 'pending')
BLOCKED = {'bank_account','id_number','phone','password','verification_code','otp',
           'access_token','token','api_key','secret_key','private_key','rules','system_prompt','user_md'}
KEY = re.compile(r'^[a-z][a-z0-9_]{0,63}$')

def blocked_key(value):
    key=unicodedata.normalize('NFKC',str(value))
    key=re.sub(r'([A-Z]+)([A-Z][a-z])',r'\1_\2',key)
    key=re.sub(r'([a-z0-9])([A-Z])',r'\1_\2',key).lower()
    key=re.sub(r'[^a-z0-9\u4e00-\u9fff]+','_',key).strip('_')
    aliases=BLOCKED|{'mobile','mobile_phone','mobile_number','phone_number','telephone','cellphone','contact_number',
                    'contact_details','contact_info','identity_number','identity_card','identity_card_number','bank_card',
                    'bank_card_number','bank_account_number','id_card','id_card_number','account_password','passcode','pwd','api_token','auth_token','bearer_token',
                    'client_secret','session_cookie','手机号','手机号码','电话','电话号码','联系电话','联系方式','身份证','身份证号','身份证号码',
                    '银行卡','银行卡号','银行卡号码','银行账号','银行账户','密码','口令','验证码','短信验证码','密钥','访问令牌','私钥'}
    return key in aliases or any(key.endswith('_'+name) for name in aliases)

def credentials(value):
    if isinstance(value,dict):return any((blocked_key(k) and v not in (None,'')) or credentials(k) or credentials(v) for k,v in value.items())
    if isinstance(value,list):return any(credentials(v) for v in value)
    text=unicodedata.normalize('NFKC',str(value))
    return bool(re.search(
        r'(?:https?://[^\s/@]+@|[?&](?:api[_-]?key|api[_-]?token|access[_-]?token|password|client[_-]?secret)=[^&#\s]+|'
        r'\bsk-[A-Za-z0-9_-]{16,}|\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AIza[A-Za-z0-9_-]{30,}|A[KS]IA[A-Z0-9]{16}|xox[baprs]-[A-Za-z0-9-]{15,})|'
        r'\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/-]{8,}=*|\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}|'
        r'-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----|'
        r'(?:password|passcode|pwd|otp|verification[_ -]?code|api[_ -]?(?:key|token)|access[_ -]?token|auth[_ -]?token|client[_ -]?secret|密码|口令|动态码|(?:短信)?验证码)'
        r'[\"\']?\s*(?:[=:：]|为|是)\s*[\"\']?[^\s\"\',;，；]{4,})',text,re.I))

def sensitive(value):
    if isinstance(value,dict):return any((blocked_key(k) and v not in (None,'')) or sensitive(k) or sensitive(v) for k,v in value.items())
    if isinstance(value,list):return any(sensitive(v) for v in value)
    text=unicodedata.normalize('NFKC',str(value))
    # Do not treat digit runs inside UUIDs/hashes as identifiers or bare 11-digit
    # business numbers as phones. Explicit labels carry contact semantics.
    numeric=re.sub(r'\b(?:[a-f0-9]{64}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\b','',text,flags=re.I)
    return credentials(text) or bool(re.search(
        r'(?<![A-Za-z0-9])(?:\d[\s-]*){13,19}[xX]?(?![A-Za-z0-9])|'
        r'(?:身份证(?:号码?)?|(?:银行|信用)卡(?:号码?)?|银行(?:账户|账号))(?:尾号|末四位|后四位)?\s*[:=：]?\s*[0-9xX* -]{4,}|'
        r'(?:手机号?|手机号码|(?:联系)?电话(?:号码)?|联系方式|contact[_ -]?(?:phone|number)|telephone|phone(?:[_ -]?number)?|mobile(?:[_ -]?number)?)'
        r'[\"\']?\s*[:=：]?\s*[\"\']?\s*\+?\(?(?:\d[\s().-]*){7,15}(?!\d)', numeric,re.I))

def unsafe_fact(payload):
    """Business identifiers exempt only their value, never credential formats or metadata."""
    business=payload.get('data_type')=='business_identifier'
    if ('key' in payload and blocked_key(payload['key'])) or credentials(payload):
        return True
    if business and not re.fullmatch(r'[A-Za-z0-9._:/-]{1,80}',payload.get('value','')):
        return True
    checked={k:v for k,v in payload.items() if k!='version' and not (business and k=='value')}
    return sensitive(checked)

def iso(value):
    if not isinstance(value,str) or date.fromisoformat(value).isoformat()!=value:
        raise ValueError('日期必须为明确的ISO日期')
    return value

@dataclass(frozen=True)
class Context:
    """必须由可信调用端创建。正文中的同名字段不会建立此权限。"""
    actor: str
    role: str
    verified: bool
    permissions: tuple = ('read','write','delete','export')
    project: str = 'default'
    audience: str = 'owner'
    conversation: str = 'local'
    clearance: str = 'restricted'

class Store(Governance):
    def __init__(self,path,*,clock=None):
        from .governance import now
        self._clock=clock or now
        self.path=Path(path)
        if any(p.is_symlink() for p in (self.path,*self.path.parents)):
            raise ValueError('拒绝符号链接数据库')
        self.path.parent.mkdir(parents=True, exist_ok=True)
        if not self.path.exists(): self.path.touch(mode=0o600,exist_ok=False)
        self.db=sqlite3.connect(str(self.path),timeout=5)
        self.db.row_factory=sqlite3.Row
        try:
            version=self.db.execute('PRAGMA user_version').fetchone()[0]
            if version not in (0,2,3): raise ValueError('不支持的数据库版本')
            tables={r[0] for r in self.db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")}
            expected={'roles':['role','seq'], 'facts':['role','key','state','payload'], 'tombstones':['role','key','seq']}
            if version==0 and tables: raise ValueError('拒绝接管已有的非本项目数据库')
            if version in (2,3):
                if version==3:expected.update(TABLES)
                if tables!=set(expected): raise ValueError('数据库结构不完整')
                for table,columns in expected.items():
                    info=list(self.db.execute('PRAGMA table_info('+table+')'))
                    if [r['name'] for r in info]!=columns: raise ValueError('数据库结构不兼容')
                    pk={'roles':[1,0],'facts':[1,2,3,0],'tombstones':[1,2,0],
                        'clocks':[1,0],'evidence':[1,0,0,0],'memory_versions':[1,0,0,0,0,0,0,0,0],
                        'relations':[1,2,3,0],'audit_events':[1,0,0,0,0,0,0,0]}[table]
                    if [r['pk'] for r in info]!=pk: raise ValueError('数据库主键约束缺失')
                if self.db.execute('PRAGMA quick_check').fetchone()[0]!='ok': raise ValueError('数据库完整性异常')
            self.db.execute('PRAGMA secure_delete=ON')
            self.db.execute('PRAGMA journal_mode=DELETE')
            if version==0:self.db.executescript('''
              CREATE TABLE IF NOT EXISTS roles(role TEXT PRIMARY KEY, seq INTEGER NOT NULL);
              CREATE TABLE IF NOT EXISTS facts(role TEXT, key TEXT, state TEXT, payload TEXT,
                PRIMARY KEY(role,key,state));
              CREATE TABLE IF NOT EXISTS tombstones(role TEXT, key TEXT, seq INTEGER,
                PRIMARY KEY(role,key));
              PRAGMA user_version=2;
            ''')
            if version in (0,2):self._migrate_governance(legacy=version==2)
            os.chmod(self.path,0o600)
        except Exception:
            self.db.close(); raise
    def __enter__(self): return self
    def __exit__(self,*args): self.db.close()
    @staticmethod
    def allowed(ctx,role,permission='read'):
        return (isinstance(ctx,Context) and ctx.verified is True and ctx.actor=='owner'
                and ctx.role==role and isinstance(role,str) and
                bool(re.fullmatch(r'[A-Z][A-Z0-9_]{0,39}',role)) and
                isinstance(ctx.permissions,tuple) and permission in ctx.permissions)
    def _read_facts(self,ctx,role,*,purpose='read'):
        if purpose not in ('read','export') or not self.allowed(ctx,role,purpose):
            raise PermissionError('来源未核验、跨角色或操作未授权')
        out={s:{} for s in STATES}
        for row in self.db.execute('SELECT key,state,payload FROM facts WHERE role=? ORDER BY key',(role,)):
            base=row['key'].removesuffix('__previous') if isinstance(row['key'],str) else ''
            if (not KEY.fullmatch(base) or blocked_key(base)
                    or (row['key'].endswith('__previous') and row['state']!='history')):
                raise ValueError('存储事实键不合法或属于禁存类别，拒绝读取')
            payload=parse_json(row['payload'])
            required={'value','source','confidence','privacy','ttl','version'}
            if (row['state'] not in STATES or not isinstance(payload,dict) or not required<=payload.keys()
                    or payload.keys()-required-{'event_time','expires_at','time_floor','kind','due_at','task_status','data_type'}
                    or any(not isinstance(payload[k],str) or not payload[k].strip() for k in ('value','source','ttl'))
                    or payload['confidence'] not in ('self_reported','unverified')
                    or payload['privacy'] not in ('private','restricted')
                    or type(payload['version']) is not int or not 1<=payload['version']<=2**63-1
                    or (payload['confidence']=='unverified' and row['state']!='pending')
                    or payload.get('kind','fact') not in ('fact','task','reminder')
                    or payload.get('data_type','text') not in ('text','business_identifier')
                    or unsafe_fact(payload)):
                raise ValueError('存储事实结构或内容异常，拒绝读取')
            if payload.get('kind')=='task':
                if 'expires_at' in payload or payload.get('task_status') not in ('active','overdue','completed'):
                    raise ValueError('任务不能混用信息失效日')
                if ((row['state']=='completed' and payload['task_status']!='completed')
                        or (row['state']=='current' and payload['task_status']=='completed')
                        or (payload['task_status']=='overdue' and 'due_at' not in payload)):
                    raise ValueError('任务状态不一致')
            elif 'task_status' in payload or 'due_at' in payload:
                raise ValueError('非任务不能包含任务状态')
            for field in ('event_time','expires_at','due_at','time_floor'):
                if field in payload: iso(payload[field])
            out[row['state']][row['key']]=payload
        return out
    @staticmethod
    def decision(action,reason):
        return {'action':action,'reason':reason}
    def _apply_core(self,ctx,event):
        reject=lambda reason: {'decisions':[self.decision('REJECT',reason)]}
        if not isinstance(ctx,Context): raise PermissionError('缺少可信权限上下文')
        if not any(self.allowed(ctx,ctx.role,p) for p in ('write','delete')):
            # 仅承认适配器指定的无状态临时分类，不执行任何读写或正文指令。
            if (ctx.actor in ('push','system') and isinstance(event,dict)
                    and set(event)=={'seq','ops'} and event['ops']==[{'op':'temporary'}]):
                return {'decisions':[self.decision('TEMPORARY','外部临时内容，不写长期记忆')]}
            return reject('未授权来源')
        if not isinstance(event,dict): raise ValueError('事件必须为对象')
        if event.get('role',ctx.role)!=ctx.role: return reject('禁止跨角色修改')
        if set(event)-{'seq','ops','role'}: raise ValueError('事件包含未支持字段')
        seq=event.get('seq'); ops=event.get('ops')
        if type(seq) is not int or not 1<=seq<=2**63-1 or not isinstance(ops,list) or not ops:
            raise ValueError('需要正整数版本和非空操作列表')
        if all(isinstance(op,dict) and not self.allowed(ctx,ctx.role,'delete' if op.get('op')=='delete' else 'write') for op in ops):
            return reject('该操作未授权')
        # 所有拒绝内容均不写入审计、错误消息或数据库。
        decisions=[]
        with self._transaction():
            # 内部一致性校验不向调用端返回私人值，不以读取权限代替修改/删除权限。
            self._read_facts(Context('owner',ctx.role,True),ctx.role)
            row=self.db.execute('SELECT seq FROM roles WHERE role=?',(ctx.role,)).fetchone()
            if row and seq<=row[0]: raise ValueError('拒绝重复或倒退版本')
            for op in ops:
                if not isinstance(op,dict): raise ValueError('操作必须为对象')
                kind=op.get('op')
                permission='delete' if kind=='delete' else 'write'
                if not self.allowed(ctx,ctx.role,permission):
                    decisions.append(self.decision('REJECT','该操作未授权')); continue
                if unsafe_fact(op):
                    decisions.append(self.decision('REJECT','敏感号码保护')); continue
                if kind in ('temporary','reject','noop'):
                    if set(op)-{'op'}: raise ValueError('非持久操作不能附带数据')
                    decisions.append(self.decision({'temporary':'TEMPORARY','reject':'REJECT','noop':'NO_CHANGE'}[kind],
                                                   {'temporary':'仅临时上下文','reject':'不可信内容','noop':'无长期变更'}[kind])); continue
                if kind not in ('set','retire','delete','review'): raise ValueError('未知操作')
                key=op.get('key')
                if not isinstance(key,str) or not KEY.fullmatch(key) or key.endswith('__previous'):
                    raise ValueError('事实键不合法或属于内部归档保留字段')
                if blocked_key(key):
                    decisions.append(self.decision('REJECT','禁存字段或规则修改')); continue
                if kind=='review':
                    if set(op)-{'op','key'}: raise ValueError('复核操作不能附带其他数据')
                    row=self.db.execute("SELECT payload FROM facts WHERE role=? AND key=? AND state='current'",(ctx.role,key)).fetchone()
                    if not row:
                        decisions.append(self.decision('NO_CHANGE','没有待复核的当前事实')); continue
                    payload=json.loads(row['payload'])
                    if payload.get('kind')=='task':
                        decisions.append(self.decision('REJECT','未完成任务不能因复核而退出待办')); continue
                    payload.update(confidence='unverified',version=seq)
                    self.db.execute("DELETE FROM facts WHERE role=? AND key=? AND state='current'",(ctx.role,key))
                    self.db.execute('INSERT OR REPLACE INTO facts VALUES(?,?,?,?)',
                                    (ctx.role,key,'pending',json.dumps(payload,ensure_ascii=False)))
                    decisions.append(self.decision('UPDATE','现时适用性待核实，保留原始来源；没有取消或删除')); continue
                if kind in ('retire','delete'):
                    if set(op)-{'op','key'}: raise ValueError('失效操作不能附带旧值')
                    self._retire(ctx.role,key,seq)
                    decisions.append(self.decision(kind.upper(),
                        '清理本库该键及归档副本，保留无值防回退标记' if kind=='delete' else '退出活跃并清理无用副本；不宣称平台彻底删除')); continue
                if set(op)-{'op','key','value','state','origin','confidence','privacy','ttl','expires_at','event_time','archive_old','reactivate','current_correction','kind','due_at','data_type'}:
                    raise ValueError('事实包含未支持字段')
                value=op.get('value'); origin=op.get('origin','主人自述'); ttl=op.get('ttl','直至更新或失效')
                if any(not isinstance(v,str) or not v.strip() or len(v)>500 for v in (value,origin,ttl)):
                    raise ValueError('事实内容和元数据必须为非空短文本')
                state=op.get('state','current'); confidence=op.get('confidence','self_reported')
                privacy=op.get('privacy','private')
                if state not in STATES or confidence not in ('self_reported','unverified') or privacy not in ('private','restricted','high'):
                    raise ValueError('状态或可信度或敏感等级无效')
                if privacy=='high':
                    decisions.append(self.decision('REJECT','禁止高敏数据持久化')); continue
                if confidence=='unverified': state='pending'
                for flag in ('archive_old','reactivate','current_correction'):
                    if flag in op and type(op[flag]) is not bool: raise ValueError('开关必须为布尔值')
                for field in ('event_time','expires_at','due_at'):
                    if field in op: iso(op[field])
                if op.get('expires_at','9999-12-31')<op.get('event_time','0001-01-01'):
                    raise ValueError('到期日期早于事件日期')
                dead=self.db.execute('SELECT seq FROM tombstones WHERE role=? AND key=?',(ctx.role,key)).fetchone()
                if dead and not (op.get('reactivate',False) and confidence=='self_reported' and state in ('current','completed')):
                    decisions.append(self.decision('REJECT','已撤销，不接受自动复活')); continue
                if state in ('pending','history'):
                    oldrow=self.db.execute('SELECT state,payload FROM facts WHERE role=? AND key=? AND state=?',
                                           (ctx.role,key,state)).fetchone()
                else:
                    oldrow=self.db.execute("SELECT state,payload FROM facts WHERE role=? AND key=? AND state IN ('current','completed') ORDER BY CASE state WHEN 'current' THEN 0 ELSE 1 END",
                                           (ctx.role,key)).fetchone()
                old=json.loads(oldrow['payload']) if oldrow else None
                current_statement=(op.get('current_correction',False) or op.get('reactivate',False)
                                   or (state=='completed' and oldrow and oldrow['state']=='current'))
                if oldrow and oldrow['state']=='completed' and state=='current' and not op.get('reactivate'):
                    decisions.append(self.decision('REJECT','已完成，需本人明确新决定才重新启用')); continue
                fact_kind=op.get('kind',old.get('kind','fact') if old else 'fact')
                if fact_kind not in ('fact','task','reminder'): raise ValueError('事实类型无效')
                data_type=op.get('data_type',old.get('data_type','text') if old else 'text')
                if data_type not in ('text','business_identifier'): raise ValueError('数据类型无效')
                if fact_kind!='task' and 'due_at' in op: raise ValueError('只有任务可有截止日')
                if fact_kind=='task' and 'expires_at' in op: raise ValueError('任务截止使用due_at，不能以失效日删除任务')
                if 'privacy' not in op:
                    # 同事实跨分区也不因缺省值降低已有的受限标记。
                    prior=self.db.execute('SELECT payload FROM facts WHERE role=? AND key=?',(ctx.role,key))
                    if any(json.loads(r['payload'])['privacy']=='restricted' for r in prior): privacy='restricted'
                # 确认相同状态和值不应抹掉已知时间；缺日期的矛盾不能绕过时序保护。
                dates={k:op[k] for k in ('event_time','expires_at') if k in op}
                if old and old['value']==value:
                    for field in ('event_time','expires_at'):
                        if field not in dates and field in old: dates[field]=old[field]
                elif old and (old.get('event_time') or old.get('time_floor')) and 'event_time' not in dates and not current_statement:
                    decisions.append(self.decision('REJECT','与已知日期事实冲突但缺少事件日期，需核实')); continue
                if old and op.get('event_time') and old.get('event_time') and op['event_time']<old['event_time']:
                    decisions.append(self.decision('REJECT','事件日期早于当前事实')); continue
                if (old and old['value']!=value and op.get('event_time')
                        and op['event_time']==old.get('event_time') and not current_statement):
                    decisions.append(self.decision('REJECT','同一生效日的矛盾缺少先后或明确更正，需核实')); continue
                floor=old.get('time_floor') if old else None
                if old and old.get('event_time') and 'event_time' not in dates and current_statement:
                    floor=max(filter(None,(floor,old['event_time'])))
                if floor and op.get('event_time') and op['event_time']<=floor:
                    decisions.append(self.decision('REJECT','旧事件不晚于已被更正的时间界限')); continue
                if old and floor and not old.get('event_time') and old['value']!=value and not current_statement:
                    decisions.append(self.decision('REJECT','无法与无精确日期的明确更正排序，需核实')); continue
                if dates.get('expires_at','9999-12-31')<dates.get('event_time','0001-01-01'):
                    raise ValueError('到期日期早于事件日期')
                payload={'value':value,'source':origin,'confidence':confidence,'privacy':privacy,'ttl':ttl,
                         'version':seq, **dates}
                if floor: payload['time_floor']=floor
                if 'kind' in op or (old and 'kind' in old): payload['kind']=fact_kind
                if data_type!='text': payload['data_type']=data_type
                if fact_kind=='task':
                    due=op.get('due_at',old.get('due_at') if old else None)
                    if due: payload['due_at']=due
                    payload['task_status']='completed' if state=='completed' else (
                        'overdue' if old and old.get('task_status')=='overdue' and op.get('due_at',due)==old.get('due_at') else 'active')
                if unsafe_fact(payload):
                    decisions.append(self.decision('REJECT','敏感内容或业务编号类型不符')); continue
                comparable=lambda p:{k:v for k,v in p.items() if k!='version'}
                if old and oldrow['state']==state and comparable(old)==comparable(payload):
                    if state in ('current','completed'):
                        cleared=self.db.execute('DELETE FROM facts WHERE role=? AND key=? AND state=?',
                                                (ctx.role,key,'pending')).rowcount
                        if cleared:
                            decisions.append(self.decision('UPDATE','本人同值确认，清理待核实矛盾')); continue
                    decisions.append(self.decision('NO_CHANGE','同值同元数据合并')); continue
                if old and state in ('current','completed') and oldrow['state'] in ('current','completed') and op.get('archive_old') and old['value']!=value:
                    hkey=key+'__previous'
                    self.db.execute('INSERT OR REPLACE INTO facts VALUES(?,?,?,?)',
                                    (ctx.role,hkey,'history',json.dumps(old,ensure_ascii=False)))
                if state in ('current','completed'):
                    self.db.execute("DELETE FROM facts WHERE role=? AND key=? AND state!='history'",(ctx.role,key))
                self.db.execute('INSERT OR REPLACE INTO facts VALUES(?,?,?,?)',
                                (ctx.role,key,state,json.dumps(payload,ensure_ascii=False)))
                self.db.execute('DELETE FROM tombstones WHERE role=? AND key=?',(ctx.role,key))
                decisions.append(self.decision('UPDATE' if old else 'ADD','状态唯一；来源和生命周期已保留'))
            self._read_facts(Context('owner',ctx.role,True),ctx.role)  # 提交前复核，结构不一致时整体回滚。
            self.db.execute('INSERT OR REPLACE INTO roles VALUES(?,?)',(ctx.role,seq))
        return {'decisions':decisions}
    def _retire(self,role,key,seq):
        self.db.execute('DELETE FROM facts WHERE role=? AND key IN (?,?)',(role,key,key+'__previous'))
        self.db.execute('INSERT OR REPLACE INTO tombstones VALUES(?,?,?)',(role,key,seq))
    def _expire_core(self,ctx,today):
        iso(today)
        if not isinstance(ctx,Context) or not self.allowed(ctx,ctx.role,'write'):
            raise PermissionError('未授权清理')
        with self._transaction():
            snapshot=self._scope_snapshot(ctx,self._read_facts(Context('owner',ctx.role,True),ctx.role))
            expired=[(key,state) for state,group in snapshot.items() for key,p in group.items() if p.get('expires_at','9999-12-31')<=today]
            seq=self.db.execute('SELECT seq FROM roles WHERE role=?',(ctx.role,)).fetchone()
            overdue=[(key,p) for key,p in snapshot['current'].items() if p.get('kind')=='task'
                     and p.get('due_at','9999-12-31')<today and p.get('task_status')!='overdue']
            for key,payload in overdue:
                payload['task_status']='overdue'
                self.db.execute('UPDATE facts SET payload=? WHERE role=? AND key=? AND state=?',
                                (json.dumps(payload,ensure_ascii=False),ctx.role,key,'current'))
            for key,state in expired:
                if state in ('pending','history'):
                    self.db.execute('DELETE FROM facts WHERE role=? AND key=? AND state=?',(ctx.role,key,state))
                else:
                    self._retire(ctx.role,key,seq[0] if seq else 0)
        return len(expired)+len(overdue)
