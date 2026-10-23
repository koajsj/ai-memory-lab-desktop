"""SQLite治理扩展：版本/来源/派生/准入，与现有四区投影同事务。"""
from contextlib import contextmanager
from dataclasses import dataclass, replace
from datetime import datetime, timezone
import hashlib
import json
import re
from typing import Optional
from .json_input import parse_json

POLICY='V3.3'
TABLES={
 'clocks':['role','revision'],
 'evidence':['source_id','role','kind','metadata'],
 'memory_versions':['version_id','role','key','part','revision','lifecycle','payload','meta','created_at'],
 'relations':['parent','child','kind','unresolved'],
 'audit_events':['id','role','memory_id','version_id','operation','relation','timestamp','policy']}
DDL=[
 'CREATE TABLE clocks(role TEXT PRIMARY KEY,revision INTEGER NOT NULL)',
 'CREATE TABLE evidence(source_id TEXT PRIMARY KEY,role TEXT NOT NULL,kind TEXT NOT NULL,metadata TEXT NOT NULL)',
 'CREATE TABLE memory_versions(version_id TEXT PRIMARY KEY,role TEXT NOT NULL,key TEXT NOT NULL,part TEXT NOT NULL,revision INTEGER NOT NULL,lifecycle TEXT NOT NULL,payload TEXT,meta TEXT NOT NULL,created_at TEXT NOT NULL)',
 'CREATE TABLE relations(parent TEXT,child TEXT,kind TEXT,unresolved INTEGER NOT NULL,PRIMARY KEY(parent,child,kind))',
 'CREATE TABLE audit_events(id INTEGER PRIMARY KEY,role TEXT,memory_id TEXT,version_id TEXT,operation TEXT,relation TEXT,timestamp TEXT,policy TEXT)',
 'CREATE INDEX versions_role_key ON memory_versions(role,key,revision)',
 'CREATE INDEX relations_child ON relations(child,kind)']
KINDS={'owner_direct':'direct','external':'external','summary':'external','tool_echo':'external','inference':'external','legacy':'unknown','unknown':'unknown'}
ID=re.compile(r'^[A-Za-z][A-Za-z0-9_.:/-]{0,95}$')

def now(): return datetime.now(timezone.utc).isoformat(timespec='microseconds')
def dump(v): return json.dumps(v,ensure_ascii=False,sort_keys=True,separators=(',',':'))
def mid(role,key): return role+'/'+key

@dataclass(frozen=True)
class Evidence:
    """仅可信接入端创建；source_kind不是正文中的身份或授权声明。"""
    source_id:str
    source_kind:str
    source_turn:Optional[int]
    conversation_id:str='local'

class Governance:
    def _now(self):
        value=self._clock()
        at=datetime.fromisoformat(value.replace('Z','+00:00'))
        if at.tzinfo is None:raise ValueError('接收时钟须有时区')
        return value

    @contextmanager
    def _transaction(self):
        if self.db.in_transaction:
            yield
        else:
            with self.db:
                self.db.execute('BEGIN IMMEDIATE')
                yield

    def _migrate_governance(self,legacy):
        with self._transaction():
            # 先读旧载荷，损坏时整个迁移失败，不增加表或改变user_version。
            rows=list(self.db.execute('SELECT role FROM roles'))
            from .engine import Context
            snapshots={r['role']:self._read_facts(Context('owner',r['role'],True),r['role']) for r in rows}
            for sql in DDL:self.db.execute(sql)
            for role,snapshot in snapshots.items():
                ordered=[(part,key,p) for part,group in snapshot.items() for key,p in group.items()]
                ordered.sort(key=lambda x:(x[1].removesuffix('__previous'),not x[1].endswith('__previous'),x[2]['version']))
                for part,key,p in ordered:
                    ctx=Context('owner',role,True);base=key.removesuffix('__previous')
                    meta=self._metadata(ctx,0,p,Evidence('legacy/'+base,'legacy',None),scope='role')
                    if key.endswith('__previous'):
                        vid=self._new_version(ctx,base,'history',p,meta,lifecycle='history',write_projection=False)
                        payload=self.db.execute('SELECT payload FROM memory_versions WHERE version_id=?',(vid,)).fetchone()[0]
                        self.db.execute('UPDATE facts SET payload=? WHERE role=? AND key=? AND state=?',(payload,role,key,part))
                    else:self._new_version(ctx,key,part,p,meta,lifecycle='pending' if part=='pending' else part,write_projection=True)
            self.db.execute('PRAGMA user_version=3')

    def _scope_snapshot(self,ctx,snapshot):
        out={p:{} for p in snapshot}
        for part,group in snapshot.items():
            for key,p in group.items():
                if key.endswith('__previous'):
                    row=self.db.execute('SELECT * FROM memory_versions WHERE role=? AND key=? AND revision=?',(ctx.role,key.removesuffix('__previous'),p['version'])).fetchone()
                    rec=self._record(row)
                else:rec=self._latest(ctx.role,key,part,p)
                if not rec or rec['payload']!=p:raise ValueError('投影与版本链不一致，拒绝读取')
                if self._scope_allowed(ctx,rec) and (rec['privacy']!='restricted' or ctx.clearance=='restricted'):
                    out[part][key]=p
        return out

    def read(self,ctx,role,*,purpose='read'):
        snapshot=self._read_facts(ctx,role,purpose=purpose)
        self._context(ctx)
        return self._scope_snapshot(ctx,snapshot)

    def _context(self,ctx):
        if any(not isinstance(getattr(ctx,k,None),str) or not ID.fullmatch(getattr(ctx,k)) for k in ('project','audience','conversation')):
            raise ValueError('可信上下文范围不合法')
        if ctx.clearance not in ('private','restricted'):raise ValueError('敏感访问等级不合法')

    def _scope_allowed(self,ctx,meta):
        return (meta.get('role')==ctx.role and meta.get('project')==ctx.project and meta.get('audience')==ctx.audience
                and (meta.get('scope')=='role' or (meta.get('scope')=='conversation' and meta.get('conversation')==ctx.conversation)))

    def _source(self,ctx,evidence,unverified=False):
        from .engine import sensitive
        if not isinstance(evidence,Evidence) or evidence.source_kind not in KINDS:
            raise ValueError('来源必须由可信适配器绑定')
        if (not ID.fullmatch(evidence.source_id) or not ID.fullmatch(evidence.conversation_id)
                or (evidence.source_turn is None and evidence.source_kind not in ('legacy','unknown'))
                or (evidence.source_turn is not None and (type(evidence.source_turn)is not int or evidence.source_turn<0))
                or sensitive(evidence.source_id+evidence.conversation_id)):
            raise ValueError('来源引用不合法')
        kind='external' if unverified and evidence.source_kind=='owner_direct' else evidence.source_kind
        source_id=ctx.role+'/'+evidence.source_id
        metadata={'source_turn':evidence.source_turn,'conversation_id':evidence.conversation_id,'role':ctx.role,
                  'authority_class':KINDS[kind],'evidence_reference':source_id}
        old=self.db.execute('SELECT role,kind,metadata FROM evidence WHERE source_id=?',(source_id,)).fetchone()
        if old:
            if parse_json(old['metadata']).get('revoked'):raise ValueError('根来源已撤销，不接受回显重建')
            if old['role']!=ctx.role or old['kind']!=kind or any(parse_json(old['metadata']).get(k)!=v for k,v in metadata.items()):
                raise ValueError('根来源引用冲突，不能重标权威')
        else:
            self.db.execute('INSERT INTO evidence VALUES(?,?,?,?)',(source_id,ctx.role,kind,dump(dict(metadata,ingestion_time=self._now()))))
        return source_id,KINDS[kind]

    def _metadata(self,ctx,seq,p,evidence=None,*,scope='role',parents=None):
        self._context(ctx)
        if scope not in ('role','conversation'):raise ValueError('不支持的作用域')
        if parents:
            roots=sorted({r for parent in parents for r in parent['roots']})
            authority='direct' if all(x['authority_class']=='direct' for x in parents) else 'unknown' if any(x['authority_class']=='unknown' for x in parents) else 'external'
            if any(x['scope']=='conversation' for x in parents):scope='conversation'
        else:
            ref,authority=self._source(ctx,evidence or Evidence('event/'+str(seq)+'/'+('external' if p['confidence']=='unverified' else 'direct'),'owner_direct',seq,ctx.conversation),p['confidence']=='unverified')
            roots=[ref]
        return {'memory_id':None,'owner':ctx.role,'role':ctx.role,'project':ctx.project,'audience':ctx.audience,
                'conversation':ctx.conversation,'scope':scope,'authority_class':authority,'roots':roots,
                'parents':[x['version_id'] for x in parents or []],'privacy':p['privacy'],'policy_version':POLICY}

    def _revision(self,role,minimum=0):
        row=self.db.execute('SELECT revision FROM clocks WHERE role=?',(role,)).fetchone()
        rev=max(row[0]+1 if row else 1,minimum)
        if rev>2**63-1:raise ValueError('状态版本超限')
        self.db.execute('INSERT OR REPLACE INTO clocks VALUES(?,?)',(role,rev));return rev

    def _event(self,role,key,version_id,operation,relation='INDEPENDENT'):
        self.db.execute('INSERT INTO audit_events(role,memory_id,version_id,operation,relation,timestamp,policy) VALUES(?,?,?,?,?,?,?)',
                        (role,mid(role,key) if key else None,version_id,operation,relation,self._now(),POLICY))

    def _record(self,row):
        if row is None:return None
        meta=parse_json(row['meta']);payload=parse_json(row['payload']) if row['payload'] else None
        if (meta.get('memory_id')!=mid(row['role'],row['key']) or meta.get('role')!=row['role'] or meta.get('owner')!=row['role']
                or meta.get('scope') not in ('role','conversation') or meta.get('authority_class') not in ('direct','external','unknown')
                or not isinstance(meta.get('roots'),list) or not 1<=len(meta['roots'])<=128
                or not isinstance(meta.get('parents'),list) or len(meta['parents'])>32
                or meta.get('privacy') not in ('private','restricted')
                or (payload is not None and (payload.get('version')!=row['revision'] or payload.get('privacy')!=meta['privacy']))):
            raise ValueError('版本元数据或载荷不一致')
        relations=[dict(r) for r in self.db.execute('SELECT * FROM relations WHERE parent=? OR child=?',(row['version_id'],row['version_id']))]
        supersedes=next((r['parent'] for r in relations if r['kind']=='SUPERSEDE' and r['child']==row['version_id']),None)
        superseded_by=next((r['child'] for r in relations if r['kind']=='SUPERSEDE' and r['parent']==row['version_id']),None)
        sources=[]
        for ref in meta['roots']:
            source=self.db.execute('SELECT kind,metadata FROM evidence WHERE source_id=?',(ref,)).fetchone()
            if not source or source['kind'] not in KINDS:raise ValueError('来源根缺失，停止使用')
            origin=parse_json(source['metadata'])
            if origin.get('role')!=row['role'] or origin.get('authority_class')!=KINDS[source['kind']]:raise ValueError('来源权威或角色不一致')
            sources.append(dict(source_id=ref,source_kind=source['kind'],**parse_json(source['metadata'])))
        if meta['authority_class']=='direct' and any(x['authority_class']!='direct' for x in sources):raise ValueError('来源权威被错误提升')
        if set(meta['parents'])!={r['parent'] for r in relations if r['kind']=='DERIVE' and r['child']==row['version_id']}:raise ValueError('派生谱系断链')
        return dict(meta,version_id=row['version_id'],key=row['key'],part=row['part'],revision=row['revision'],lifecycle=row['lifecycle'],
                    payload=payload,created_at=row['created_at'],effective_at=payload.get('event_time') if payload else None,
                    valid_until=payload.get('expires_at') if payload else None,source=sources,
                    supersedes=supersedes,superseded_by=superseded_by,
                    relations=[dict(parent=r['parent'],child=r['child'],relation=r['kind'],unresolved=bool(r['unresolved'])) for r in relations])

    def _latest(self,role,key,part,payload=None):
        if payload:
            row=self.db.execute('SELECT * FROM memory_versions WHERE role=? AND key=? AND part=? AND revision=?',(role,key,part,payload['version'])).fetchone()
        else:
            row=self.db.execute('SELECT * FROM memory_versions WHERE role=? AND key=? AND part=? ORDER BY revision DESC LIMIT 1',(role,key,part)).fetchone()
        return self._record(row)

    def _new_version(self,ctx,key,part,payload,meta,*,lifecycle=None,write_projection=True,old=None,operation='ADD'):
        p=dict(payload);rev=self._revision(ctx.role,p['version']);p['version']=rev
        vid=mid(ctx.role,key)+'/'+str(rev)
        fields=('memory_id','owner','role','project','audience','conversation','scope','authority_class','roots','parents','privacy','policy_version')
        meta={k:meta[k] for k in fields};meta.update(memory_id=mid(ctx.role,key),privacy=p['privacy'])
        relation='SUPERSEDE' if old else 'DERIVE' if meta['parents'] else 'INDEPENDENT'
        if old:
            self.db.execute("UPDATE memory_versions SET lifecycle='superseded' WHERE version_id=?",(old['version_id'],))
            self.db.execute('INSERT INTO relations VALUES(?,?,?,0)',(old['version_id'],vid,'SUPERSEDE'))
        self.db.execute('INSERT INTO memory_versions VALUES(?,?,?,?,?,?,?,?,?)',
                        (vid,ctx.role,key,part,rev,lifecycle or part,dump(p),dump(meta),self._now()))
        for parent in meta['parents']:
            self.db.execute('INSERT INTO relations VALUES(?,?,?,0)',(parent,vid,'DERIVE'))
        if write_projection:
            self.db.execute('UPDATE facts SET payload=? WHERE role=? AND key=? AND state=?',(dump(p),ctx.role,key,part))
        self._event(ctx.role,key,vid,operation,relation)
        if old:self._invalidate(ctx,[old['version_id']],erase=False,include_roots=False)
        return vid

    def _invalidate(self,ctx,ids,*,erase,include_roots=True):
        seen=set(ids) if include_roots else set();queue=list(ids)
        while queue:
            parent=queue.pop()
            for row in self.db.execute("SELECT child FROM relations WHERE parent=? AND kind='DERIVE'",(parent,)):
                if row[0] not in seen:seen.add(row[0]);queue.append(row[0])
        for vid in seen:
            row=self.db.execute('SELECT * FROM memory_versions WHERE version_id=? AND role=?',(vid,ctx.role)).fetchone()
            if not row:raise ValueError('谱系跨角色或损坏')
            meta=parse_json(row['meta'])
            if not self._scope_allowed(ctx,meta) or (meta['privacy']=='restricted' and ctx.clearance!='restricted'):
                raise PermissionError('清理影响超出当前作用域；事务未提交')
            active=self.db.execute('SELECT payload FROM facts WHERE role=? AND key=? AND state=?',(ctx.role,row['key'],row['part'])).fetchone()
            if active and row['payload'] and parse_json(active[0])==parse_json(row['payload']):
                self.db.execute('DELETE FROM facts WHERE role=? AND key=? AND state=?',(ctx.role,row['key'],row['part']))
            self.db.execute("UPDATE memory_versions SET lifecycle=?,payload=CASE WHEN ? THEN NULL ELSE payload END WHERE version_id=?",
                            ('forgotten' if erase else 'invalidated',erase,vid))
            # A history alias may belong to an independent version of this field.
            history_key=row['key']+'__previous'
            history=self.db.execute("SELECT payload FROM facts WHERE role=? AND key=? AND state='history'",(ctx.role,history_key)).fetchone()
            if history and parse_json(history['payload'])['version']==row['revision']:
                self.db.execute("DELETE FROM facts WHERE role=? AND key=? AND state='history'",(ctx.role,history_key))
            if not self.db.execute('SELECT 1 FROM facts WHERE role=? AND key=?',(ctx.role,row['key'])).fetchone():
                seq=self.db.execute('SELECT seq FROM roles WHERE role=?',(ctx.role,)).fetchone()
                self.db.execute('INSERT OR REPLACE INTO tombstones VALUES(?,?,?)',(ctx.role,row['key'],seq[0] if seq else 0))
            self._event(ctx.role,row['key'],vid,'DELETE' if erase else 'RETIRE','DERIVE')

    def _prepare(self,ctx,event,evidence,scope,derivations):
        import copy
        from .engine import unsafe_fact
        clean=copy.deepcopy(event);metadata={};blocked=set()
        if not isinstance(clean,dict) or not isinstance(clean.get('ops'),list):return clean,metadata,blocked
        keys=[op.get('key') for op in clean['ops'] if isinstance(op,dict) and isinstance(op.get('key'),str)]
        if len(keys)!=len(set(keys)):raise ValueError('同一批次重复修改同一键，须拆分明确有序事件')
        for i,op in enumerate(clean['ops']):
            if not isinstance(op,dict) or not isinstance(op.get('key'),str):continue
            key=op['key'];prior=self._latest(ctx.role,key,'current') or self._latest(ctx.role,key,'completed') or self._latest(ctx.role,key,'pending') or self._latest(ctx.role,key,'history')
            if prior and (not self._scope_allowed(ctx,prior) or (prior['privacy']=='restricted' and ctx.clearance!='restricted')):
                clean['ops'][i]={'op':'reject'};blocked.add(i);continue
            if op.get('op')!='set' or not isinstance(op.get('value'),str) or unsafe_fact(op):continue
            parents=[]
            if derivations and key in derivations:
                if not self.allowed(ctx,ctx.role,'read'):raise PermissionError('派生需来源读取权限')
                refs=derivations[key]
                if not isinstance(refs,list) or not 1<=len(refs)<=32 or len(set(refs))!=len(refs):raise ValueError('派生来源引用无效')
                for ref in refs:
                    parent=self._record(self.db.execute('SELECT * FROM memory_versions WHERE version_id=?',(ref,)).fetchone())
                    if not parent or parent['role']!=ctx.role or not self._scope_allowed(ctx,parent) or (parent['privacy']=='restricted' and ctx.clearance!='restricted'):raise PermissionError('派生不允许跨越来源范围')
                    if parent['key']==key or parent['payload'] is None or parent['lifecycle'] not in ('current','completed','pending'):
                        raise ValueError('派生来源失效或自引用')
                    reason=self._admitted(ctx,parent,self._now()[:10])
                    if reason:raise ValueError('派生依据未获准：'+reason)
                    parents.append(parent)
                if any(p['privacy']=='restricted' for p in parents):op['privacy']='restricted'
                dates=[p['payload']['expires_at'] for p in parents if 'expires_at' in p['payload']]
                if dates:op['expires_at']=min(dates+[op['expires_at']] if 'expires_at'in op else dates)
                starts=[p['payload']['event_time'] for p in parents if 'event_time' in p['payload']]
                if starts:op['event_time']=max(starts+[op['event_time']] if 'event_time'in op else starts)
                op['origin']='派生摘要；原始来源见谱系'
            elif evidence and evidence.source_kind!='owner_direct':op['confidence']='unverified'
            p={'confidence':op.get('confidence','self_reported'),'privacy':op.get('privacy','private')}
            if p['privacy']=='high':continue
            # 同值确认沿用来源可避免无意义元数据版本；legacy未知来源须显式本轮重新核验。
            meta=self._metadata(ctx,clean.get('seq',0),p,evidence,scope=scope,parents=parents)
            metadata[key]=meta
        return clean,metadata,blocked

    def apply(self,ctx,event,*,evidence=None,scope='role',_derivations=None):
        from .engine import Context,unsafe_fact
        if not isinstance(ctx,Context) or not any(self.allowed(ctx,ctx.role,p) for p in ('write','delete')):
            return self._apply_core(ctx,event)
        with self._transaction():
            self._context(ctx)
            before=self._read_facts(replace(ctx,permissions=('read',)),ctx.role)
            self._scope_snapshot(ctx,before)  # 内部复核全部投影，返回值不向修改端披露。
            if isinstance(event,dict) and event.get('role',ctx.role)!=ctx.role:return self._apply_core(ctx,event)
            if isinstance(event,dict) and isinstance(event.get('ops'),list) and event['ops'] and all(isinstance(op,dict) and not self.allowed(ctx,ctx.role,'delete' if op.get('op')=='delete' else 'write') for op in event['ops']):return self._apply_core(ctx,event)
            clean,metadata,blocked=self._prepare(ctx,event,evidence,scope,_derivations)
            if blocked and len(blocked)==len(clean['ops']):
                return {'decisions':[self.decision('REJECT','来源作用域不允许此修改') for _ in clean['ops']]}
            result=self._apply_core(ctx,clean)
            after=self._read_facts(replace(ctx,permissions=('read',)),ctx.role)
            decisions=result['decisions']
            resolved=set()
            for i,op in enumerate(clean['ops']):
                d=decisions[i];key=op.get('key');operation=d['action']
                if i in blocked:d['reason']='来源作用域不允许此修改'
                if operation in ('DELETE','RETIRE') and key:
                    ids=[r[0] for r in self.db.execute('SELECT version_id FROM memory_versions WHERE role=? AND key=?',(ctx.role,key))]
                    self._invalidate(ctx,ids,erase=True)
                elif operation=='REJECT' and key and d['reason'].startswith('同一生效日') and not unsafe_fact(op) and op.get('privacy')!='high':
                    prior=self._latest(ctx.role,key,'current')
                    p={'value':op['value'],'source':op.get('origin','主人自述'),'confidence':'unverified','privacy':op.get('privacy',prior['privacy']),
                       'ttl':'冲突待可信更正','version':event['seq'],'event_time':op['event_time']}
                    vid=self._new_version(ctx,key,'pending',p,metadata[key],lifecycle='quarantine',write_projection=False,operation='REJECT')
                    self.db.execute('INSERT INTO relations VALUES(?,?,?,1)',(prior['version_id'],vid,'CONTRADICT'))
                elif operation=='NO_CHANGE' and key:
                    prior=self._latest(ctx.role,key,'current')
                    if (op.get('current_correction') is True and op.get('state','current')=='current'
                            and metadata.get(key,{}).get('authority_class')=='direct'
                            and prior and any(r['relation']=='CONTRADICT' and r['unresolved'] for r in prior['relations'])):
                        resolved.add(key)
                        d.update(action='UPDATE',reason='本人明确同值更正，解决冲突并复核派生')
                    else:self._event(ctx.role,key,None,'NO_CHANGE','MERGE')
            for part,group in after.items():
                for key,p in group.items():
                    if key.endswith('__previous'):continue
                    previous=before[part].get(key)
                    existing=self._latest(ctx.role,key,part)
                    meta=metadata.get(key)
                    reverified=(part=='current' and key in resolved) or (existing and existing['authority_class']=='unknown' and meta and meta['authority_class']=='direct')
                    if previous==p and not reverified:continue
                    if not meta:
                        oldmeta=existing or self._latest(ctx.role,key,'current')
                        meta={k:v for k,v in oldmeta.items() if k in ('memory_id','owner','role','project','audience','conversation','scope','authority_class','roots','parents','privacy','policy_version')} if oldmeta else self._metadata(ctx,event['seq'],p,evidence,scope=scope)
                    old=existing
                    if part in ('current','completed'):
                        old=self._latest(ctx.role,key,'current') or self._latest(ctx.role,key,'completed')
                    self._new_version(ctx,key,part,p,meta,old=old,operation='UPDATE' if old else 'ADD')
                    if part in ('current','completed'):
                        self.db.execute("UPDATE relations SET unresolved=0 WHERE kind='CONTRADICT' AND parent IN (SELECT version_id FROM memory_versions WHERE role=? AND key=?)",(ctx.role,key))
            # 主人确认清除了待核实分区时，同时使旧候选及其派生失效。
            for key,p in before['pending'].items():
                if key not in after['pending']:
                    old=self._latest(ctx.role,key,'pending',p)
                    if old and old['lifecycle'] not in ('forgotten','invalidated'):
                        self._invalidate(ctx,[old['version_id']],erase=False)
            # 拒绝/临时事件只保留枚举审计，不复制原输入或攻击内容。
            for d in decisions:
                if d['action'] in ('REJECT','TEMPORARY'):self._event(ctx.role,None,None,d['action'])
            self._read_facts(replace(ctx,permissions=('read',)),ctx.role)
        return result

    def expire(self,ctx,today):
        from .engine import Context
        if not isinstance(ctx,Context) or not self.allowed(ctx,ctx.role,'write'):raise PermissionError('未授权清理')
        with self._transaction():
            before=self._read_facts(replace(ctx,permissions=('read',)),ctx.role)
            before=self._scope_snapshot(ctx,before)
            count=self._expire_core(ctx,today)
            after=self._read_facts(replace(ctx,permissions=('read',)),ctx.role)
            for part,group in before.items():
                for key,p in group.items():
                    if key.endswith('__previous'):continue
                    record=self._latest(ctx.role,key,part,p)
                    if key not in after[part] and record:self._invalidate(ctx,[record['version_id']],erase=True)
                    elif after[part].get(key)!=p and record:
                        self._new_version(ctx,key,part,after[part][key],record,old=record,operation='LIFECYCLE')
            return count

    def revoke(self,ctx,*,seq,key):
        return self.apply(ctx,{'seq':seq,'ops':[{'op':'retire','key':key}]})

    def revoke_source(self,ctx,source_id):
        if not self.allowed(ctx,ctx.role,'delete'):raise PermissionError('撤销根来源需删除权限')
        with self._transaction():
            root=self.db.execute('SELECT * FROM evidence WHERE source_id=? AND role=?',(source_id,ctx.role)).fetchone()
            if not root:raise ValueError('来源不存在')
            records=[self._record(r) for r in self.db.execute('SELECT * FROM memory_versions WHERE role=?',(ctx.role,))]
            targets=[r for r in records if source_id in r['roots']]
            if any(not self._scope_allowed(ctx,r) or (r['privacy']=='restricted' and ctx.clearance!='restricted') for r in targets):
                raise PermissionError('根来源影响超出当前作用域')
            meta=parse_json(root['metadata']);meta['revoked']=True
            self.db.execute('UPDATE evidence SET metadata=? WHERE source_id=?',(dump(meta),source_id))
            self._invalidate(ctx,[r['version_id'] for r in targets],erase=True)
        return {'operation':'REVOKE','affected_versions':len(targets),'policy':POLICY}

    def derive(self,ctx,*,seq,key,value,parents):
        return self.apply(ctx,{'seq':seq,'ops':[{'op':'set','key':key,'value':value}]},_derivations={key:parents})

    def versions(self,ctx,key):
        if not self.allowed(ctx,ctx.role,'read'):raise PermissionError('未授权审计')
        rows=[self._record(r) for r in self.db.execute('SELECT * FROM memory_versions WHERE role=? AND key=? ORDER BY revision',(ctx.role,key))]
        if any(not self._scope_allowed(ctx,r) or (r['privacy']=='restricted' and ctx.clearance!='restricted') for r in rows):raise PermissionError('审计范围不匹配')
        return rows

    def inspect_memory(self,ctx,key,*,part='current'):
        if not self.allowed(ctx,ctx.role,'read'):raise PermissionError('未授权读取')
        record=self._latest(ctx.role,key,part)
        if record and (not self._scope_allowed(ctx,record) or (record['privacy']=='restricted' and ctx.clearance!='restricted')):raise PermissionError('记忆范围不匹配')
        return record

    def export_governance(self,ctx):
        if not self.allowed(ctx,ctx.role,'read') or not self.allowed(ctx,ctx.role,'export'):raise PermissionError('未授权治理快照导出')
        versions=[self._record(r) for r in self.db.execute('SELECT * FROM memory_versions WHERE role=? ORDER BY revision',(ctx.role,))]
        versions=[r for r in versions if self._scope_allowed(ctx,r) and (r['privacy']!='restricted' or ctx.clearance=='restricted')]
        return {'format':'memory-lab.governance.v1','policy':POLICY,'versions':versions,'audit':self.audit(ctx)}

    def audit(self,ctx):
        if not self.allowed(ctx,ctx.role,'read'):raise PermissionError('未授权审计')
        result=[]
        for r in self.db.execute('SELECT * FROM audit_events WHERE role=? ORDER BY id',(ctx.role,)):
            if r['memory_id']:
                key=r['memory_id'].split('/',1)[1]
                records=[self._record(v) for v in self.db.execute('SELECT * FROM memory_versions WHERE role=? AND key=?',(ctx.role,key))]
                if not any(self._scope_allowed(ctx,x) and (x['privacy']!='restricted' or ctx.clearance=='restricted') for x in records):continue
            result.append(dict(r))
        return result

    def as_of(self,ctx,role,timestamp):
        if not self.allowed(ctx,role,'read'):raise PermissionError('未授权历史审计')
        at=datetime.fromisoformat(timestamp.replace('Z','+00:00'))
        if at.tzinfo is None:raise ValueError('审计时间须含时区')
        rows={}
        for r in self.db.execute('SELECT * FROM memory_versions WHERE role=? ORDER BY revision',(role,)):
            rec=self._record(r)
            if datetime.fromisoformat(rec['created_at'])<=at and self._scope_allowed(ctx,rec) and (rec['privacy']!='restricted' or ctx.clearance=='restricted') and rec['payload'] is not None and rec['lifecycle'] not in ('invalidated','forgotten'):
                rows[(r['key'],r['part'])]=rec
        return list(rows.values())

    def _admitted(self,ctx,r,today,seen=None):
        if not r or not self._scope_allowed(ctx,r):return 'scope'
        if r['policy_version']!=POLICY:return 'policy'
        if r['lifecycle'] not in ('current','completed') or r['payload'] is None:return 'lifecycle'
        if r['authority_class']!='direct' or r['payload'].get('confidence')!='self_reported' or any(x.get('revoked') for x in r['source']):return 'provenance'
        if r['privacy']=='restricted' and ctx.clearance!='restricted':return 'sensitivity'
        if r['effective_at'] and r['effective_at']>today:return 'future'
        if r['valid_until'] and r['valid_until']<=today:return 'expired'
        if any(x['relation']=='CONTRADICT' and x['unresolved'] for x in r['relations']):return 'contradiction'
        seen=set() if seen is None else set(seen)
        if r['version_id'] in seen:return 'cycle'
        seen.add(r['version_id'])
        for ref in r['parents']:
            parent=self._record(self.db.execute('SELECT * FROM memory_versions WHERE version_id=?',(ref,)).fetchone())
            if self._admitted(ctx,parent,today,seen):return 'lineage'
        return None

    def retrieve_for_context(self,ctx,role,*,today,keys=None,purpose='answer',confirmed=False):
        from .engine import iso
        iso(today)
        if not self.allowed(ctx,role,'read'):raise PermissionError('未授权检索')
        self._context(ctx)
        if purpose not in ('answer','high_impact'):raise ValueError('不支持的用途')
        if purpose=='high_impact' and (confirmed is not True or 'high_impact' not in ctx.permissions):raise PermissionError('高影响用途需独立权限与本轮明确确认')
        snapshot=self.read(ctx,role);accepted=[];denied=[]
        for part in ('current','completed'):
            for key,p in snapshot[part].items():
                if keys is not None and key not in keys:continue
                record=self._latest(role,key,part,p)
                reason=self._admitted(ctx,record,today)
                if reason:denied.append({'reason':reason})
                else:accepted.append(record)
        return {'memories':accepted,'denied':denied,'policy':POLICY,'boundary':'可信本地适配器；不是现实身份认证或自然语言提取结果'}
