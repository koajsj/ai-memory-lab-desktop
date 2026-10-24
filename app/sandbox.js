/* 临时确定性实验。可信身份由本地控件显式选择；不提供真实身份认证。 */
(function(root){
'use strict';
const M=typeof module!=='undefined'?require('./model.js'):root.MemoryModel;
const clone=x=>JSON.parse(JSON.stringify(x)),blank=()=>({current:{},history:{},pending:{},completed:{}});
const check=(ok,msg)=>{if(!ok)throw Error(msg);};
const iso=s=>typeof s==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(s)&&s>='0001-01-01'&&Number.isFinite(Date.parse(s))&&new Date(s+'T00:00:00Z').toISOString().slice(0,10)===s;
const actions=['ADD','CORRECT','CONFLICT','DERIVE','READ','DELETE','REBUILD','RESTORE','COMPLETE','CANCEL','PAUSE','RESUME','ADVANCE'];
function create(policy){
 check(policy?.version==='V3.3'&&/^[a-f0-9]{64}$/.test(policy.sha256),'策略登记无效');
 let personalGrant=null;
 let roles={},now='2026-01-01',sequence=0;
 const roleName=s=>typeof s==='string'&&/^[A-Z][A-Z0-9_]{0,31}$/.test(s);
 function init(role){if(!roles[role]){const snap=blank();roles[role]={date:'2026-01-01',records:[],tombstones:[],frames:[{round:1,source:'owner',input:'建立空白临时实验',annotation:'浏览器确定性模拟；状态仅在内存中。',status:'PASS',decisions:[{action:'NO_CHANGE',reason:'空白初始状态'}],before:clone(snap),after:snap,diff:{added:[],changed:[],removed:[]},governance:{format:'memory-lab.governance.v1',policy:'V3.3',versions:[],audit:[]},admission:{allowed_ids:[],denied:[]}}]};}return roles[role];}
 function diff(b,a){const d={added:[],changed:[],removed:[]};for(const p of M.partitions)for(const k of new Set([...Object.keys(b[p]),...Object.keys(a[p])]))if(JSON.stringify(b[p][k])!==JSON.stringify(a[p][k]))d[!b[p][k]?'added':!a[p][k]?'removed':'changed'].push(p+'.'+k);return d;}
 function admission(state,project,at){const allowed_ids=[],denied=[],byId=new Map(state.records.map(r=>[r.version_id,r]));
 function reasonFor(r,seen=new Set()){if(!r||seen.has(r.version_id))return 'lineage';let reason=null;
 if(r.payload?.retention)reason='local_only';else if(r.project!==project)reason='permission';else if(r.scheduled&&r.effective_at>at)reason='future';else if(['pending','quarantine'].includes(r.lifecycle))reason='contradiction';else if(!['current','completed'].includes(r.lifecycle))reason='expired';else if(r.effective_at&&r.effective_at>at)reason='future';else if(r.valid_until&&r.valid_until<=at)reason='expired';else if(r.payload.paused)reason='paused';else if(state.records.some(x=>x.lifecycle==='quarantine'&&x.relations.some(z=>z.parent===r.version_id&&z.unresolved)))reason='contradiction';
 if(reason)return reason;const path=new Set(seen).add(r.version_id);return r.parents.some(id=>reasonFor(byId.get(id),path))?'lineage':null;}
 for(const r of state.records){if(!r.payload)continue;const reason=reasonFor(r);if(reason)denied.push({reason});else allowed_ids.push(r.version_id);}return {allowed_ids,denied};}
 function dataset(role='RESEARCHER_A'){check(roleName(role),'角色标识无效');const s=init(role);now=s.date;return M.adapt({format:'memory-lab.replay.v1',mode:'SIMULATED',role,data:{kind:'本地结构化回放：浏览器临时实验',policy:clone(policy),experiment:{engine:'browser-deterministic.v1',temporary:true},frames:clone(s.frames),summary:{PASS:s.frames.length,FAIL:0},final:clone(s.frames.at(-1).after)}},{personal:true});}
 function apply(input){
 check(input&&typeof input==='object'&&!Array.isArray(input),'实验输入无效');check(Object.keys(input).every(k=>['action','actor','owner','key','project','value','source','parents','effective','expires','due','kind','privacy','date','confirmed'].includes(k)),'不支持的输入字段');
 const x={action:'ADD',actor:'RESEARCHER_A',owner:'RESEARCHER_A',key:'preference',project:'default',value:'',source:'owner_direct',parents:[],kind:'fact',privacy:'private',...input};
 check(actions.includes(x.action)&&roleName(x.actor)&&roleName(x.owner),'操作或角色无效');
 check(typeof x.project==='string'&&/^[A-Za-z][A-Za-z0-9_-]{0,23}$/.test(x.project),'项目仅支持24位以内字母、数字、下划线');
 check(typeof x.key==='string'&&/^[A-Za-z][A-Za-z0-9_-]{0,39}$/.test(x.key)&&!M.isProtectedKey(x.key),'字段无效或属于高敏／治理字段');
 check(['owner_direct','external'].includes(x.source)&&['fact','task'].includes(x.kind)&&['private','restricted'].includes(x.privacy),'来源、类型或隐私无效');
 check(typeof x.value==='string'&&x.value.length<=1000&&((personalGrant&&personalGrant.value===x.value&&personalGrant.scope===x.actor+'/'+x.project&&x.source==='owner_direct')||(!M.isSensitive(x.value)&&!M.personalKind(x.value))),'内容过长或包含高敏长号码');
 check(Array.isArray(x.parents)&&x.parents.length<=8&&x.parents.every(id=>typeof id==='string'&&id.length<=120),'派生引用无效');
 for(const k of ['date','effective','expires','due'])if(x[k])check(iso(x[k]),'日期须为有效YYYY-MM-DD');
 check(!x.effective||!x.expires||x.expires>x.effective,'失效日期须晚于生效日期');check(x.kind!=='task'||!x.expires,'任务截止使用截止日，不使用信息失效日');
 const backup=clone({roles,now,sequence});
 try{
 const s=init(x.actor);now=s.date;check(s.frames.length<200&&s.records.length<150,'临时实验已达容量，请导出后重置');
 const before=clone(s.frames.at(-1).after),after=clone(before),key=x.project+'__'+x.key;
 const records=s.records;const latest=()=>records.filter(r=>r.key===key).at(-1);
 const active=()=>records.findLast(r=>r.key===key&&r.lifecycle==='current'&&r.part==='current');
 let action='NO_CHANGE',reason='',result=null,timeFloor=null;
 const remove=r=>{for(const p of M.partitions)for(const [k,v]of Object.entries(after[p]))if(k===r.key&&v.version===r.revision)delete after[p][k];};
 const invalidate=(roots,erase=false)=>{const ids=new Set(roots);let changed=true;while(changed){changed=false;for(const r of records)if(r.parents.some(id=>ids.has(id))&&!ids.has(r.version_id)){ids.add(r.version_id);changed=true;}}
 for(const r of records)if(ids.has(r.version_id)&&!roots.includes(r.version_id)){remove(r);r.lifecycle='invalidated';if(erase)r.payload=null;}
 if(erase)for(const r of records)if(ids.has(r.version_id)){remove(r);r.payload=null;r.lifecycle=roots.includes(r.version_id)?'forgotten':'invalidated';}
 if(erase)for(const r of records)if(ids.has(r.version_id)&&!s.tombstones.includes(r.key)&&!records.some(v=>v.key===r.key&&v.payload&&['current','completed','pending','quarantine'].includes(v.lifecycle)))s.tombstones.push(r.key);
 if(erase)for(const f of s.frames){for(const p of M.partitions)for(const snap of [f.before,f.after])for(const [k,v]of Object.entries(snap[p]))if(ids.has(x.actor+'/'+k+'/'+v.version))delete snap[p][k];for(const r of f.governance.versions)if(ids.has(r.version_id)){r.payload=null;r.lifecycle=roots.includes(r.version_id)?'forgotten':'invalidated';}f.diff=diff(f.before,f.after);}
 return ids;};
 function addRecord(part,lifecycle,parents=[],old=null,value=x.value){
 const revision=++sequence,version_id=x.actor+'/'+key+'/'+revision,source_id=x.actor+'/event/'+revision;
 let source=[{source_id,source_kind:x.source,authority_class:x.source==='owner_direct'?'direct':'external',conversation_id:'experiment',evidence_reference:source_id,ingestion_time:now+'T12:00:00Z',role:x.actor,source_turn:s.frames.length+1}];
 if(parents.length)source=[...new Map(parents.flatMap(r=>r.source).map(v=>[v.source_id,v])).values()];
 const unverified=lifecycle==='pending'||lifecycle==='quarantine'||source.some(v=>v.authority_class!=='direct');
 const payload={value,source:parents.length?'本地派生：保留根证据':x.source==='owner_direct'?'本人结构化输入':'外部线索',confidence:unverified?'unverified':'self_reported',privacy:old?.privacy==='restricted'||parents.some(r=>r.privacy==='restricted')?'restricted':x.privacy,version:revision,ttl:'依赖状态、时效与用途准入',kind:x.kind};
 if(personalGrant){payload.data_type='personal_information';payload.retention={category:personalGrant.category,purpose:personalGrant.purpose,scope:personalGrant.scope,request_id:personalGrant.id,use:'local_only'};payload.privacy='restricted';}
 if(timeFloor)payload.time_floor=timeFloor;
 if(x.effective)payload.event_time=x.effective;if(x.expires)payload.expires_at=x.expires;if(x.kind==='task'){payload.task_status=old?.payload.task_status==='overdue'&&x.due===old.payload.due_at?'overdue':'active';if(x.due)payload.due_at=x.due;}
 const r={owner:x.actor,role:x.actor,key,memory_id:x.actor+'/'+key,version_id,revision,part,lifecycle,payload,authority_class:source.every(v=>v.authority_class==='direct')?'direct':'external',source,roots:source.map(v=>v.source_id),parents:parents.map(v=>v.version_id),relations:parents.map(v=>({parent:v.version_id,child:version_id,relation:'DERIVE',unresolved:false})),privacy:payload.privacy,scope:'role',project:x.project,audience:'owner',conversation:'experiment',policy_version:'V3.3',created_at:now+'T12:00:00Z',effective_at:x.effective||null,valid_until:x.expires||null,supersedes:old?.version_id||null,superseded_by:null};
 if(old){old.superseded_by=version_id;const rel={parent:old.version_id,child:version_id,relation:'SUPERSEDE',unresolved:false};r.relations.push(rel);old.relations.push(clone(rel));}
 for(const p of parents)p.relations.push(clone(r.relations.find(v=>v.parent===p.version_id)));
 records.push(r);after[part][key]=clone(payload);return r;
 }
 // 生命周期变化不是新的独立事实：继承原根来源及派生约束。
 function lifecycleVersion(old,part){
 remove(old);old.lifecycle='superseded';invalidate([old.version_id]);
 const n=clone(old);n.revision=++sequence;n.version_id=x.actor+'/'+old.key+'/'+n.revision;n.lifecycle=part;n.part=part;n.payload.version=n.revision;n.created_at=now+'T12:00:00Z';n.supersedes=old.version_id;n.superseded_by=null;
 n.relations=n.parents.map(parent=>({parent,child:n.version_id,relation:'DERIVE',unresolved:false}));
 for(const rel of n.relations)records.find(r=>r.version_id===rel.parent).relations.push(clone(rel));
 const rel={parent:old.version_id,child:n.version_id,relation:'SUPERSEDE',unresolved:false};old.superseded_by=n.version_id;old.relations.push(clone(rel));n.relations.push(rel);records.push(n);return n;
 }
 if(x.actor!==x.owner){action='REJECT';reason='未获跨角色权限；不确认目标记录是否存在。';}
 else if(/忽略.{0,12}(规则|守则)|修改.{0,12}(USER\.md|系统指令)|system_prompt/i.test(x.value)){action='REJECT';reason='内容试图改变治理约束；不保存指令。';}
 else if(x.source!=='owner_direct'&&!['ADD','CONFLICT','READ'].includes(x.action)){action='REJECT';reason='外部内容没有更正、删除或修改生命周期的权限。';}
 else if(x.action==='ADVANCE'){
 check(iso(x.date)&&x.date>=now,'实验时间只能向前推进');s.date=now=x.date;action='NO_CHANGE';reason='已复核时间；逾期任务仍待确认，不自动完成。';
 for(const r of records.filter(r=>r.scheduled&&r.lifecycle==='pending'&&r.effective_at<=now)){
  const old=records.findLast(v=>v.key===r.key&&v.part==='current'&&v.lifecycle==='current');
  remove(r);if(old){remove(old);old.lifecycle='superseded';old.superseded_by=r.version_id;r.supersedes=old.version_id;const rel={parent:old.version_id,child:r.version_id,relation:'SUPERSEDE',unresolved:false};old.relations.push(clone(rel));r.relations.push(rel);after.history[r.key]=clone(old.payload);invalidate([old.version_id]);}
  r.lifecycle='current';r.part='current';delete r.scheduled;after.current[r.key]=clone(r.payload);action='UPDATE';reason='已到明确生效日，计划更正现在替代旧状态。';
 }
 for(const r of [...records])if(r.lifecycle==='current'&&r.payload){if(r.valid_until&&r.valid_until<=now){remove(r);r.lifecycle='history';r.part='history';after.history[r.key]=clone(r.payload);invalidate([r.version_id]);action='RETIRE';}else if(r.payload.kind==='task'&&r.payload.due_at<now&&r.payload.task_status==='active'){
 // 任务状态变更产生新版本；不改写既有版本载荷。
 const n=lifecycleVersion(r,'current');n.payload.task_status='overdue';after.current[r.key]=clone(n.payload);action='UPDATE';}}
 }
 else if(x.action==='READ'){
 const a=admission(s,x.project,now);action='NO_CHANGE';reason='已执行用途、时间、冲突、候选与谱系准入检查。';result={allowed_ids:a.allowed_ids,denied:a.denied};
 }
 else if(x.action==='RESTORE'){action='REJECT';reason='旧值不能通过恢复指令复活；请由本人提供新的明确依据。';}
 else if(x.action==='DELETE'){
 const ids=records.filter(r=>r.key===key).map(r=>r.version_id);invalidate(ids,true);if(!s.tombstones.includes(key))s.tombstones.push(key);action='DELETE';reason='已清除本实验可控载荷和历史快照，失效受影响派生；独立记录保留。';
 }
 else if(['COMPLETE','CANCEL','PAUSE','RESUME'].includes(x.action)){
 const r=active();check(r?.payload?.kind==='task','当前字段不是有效任务');
 if(['COMPLETE','CANCEL'].includes(x.action))for(const pending of records.filter(v=>v.key===key&&v.scheduled&&v.lifecycle==='pending')){remove(pending);pending.lifecycle='invalidated';invalidate([pending.version_id]);}
 const part=x.action==='COMPLETE'?'completed':x.action==='CANCEL'?'history':'current';const n=lifecycleVersion(r,part);if(x.action==='COMPLETE'){n.payload.task_status='completed';delete n.payload.paused;}if(x.action==='PAUSE')n.payload.paused=true;if(x.action==='RESUME')delete n.payload.paused;if(x.action==='CANCEL')n.payload.ttl='已取消；仅历史用途';after[part][key]=clone(n.payload);action=x.action==='CANCEL'?'RETIRE':'UPDATE';reason={COMPLETE:'任务明确完成。',CANCEL:'任务明确取消，独立事实不变。',PAUSE:'任务暂停而非取消；限制用于当前行动。',RESUME:'任务重新开始。'}[x.action];
 }
 else {
 check(x.value.trim(),'请提供记忆内容');const old=active()||(x.action==='CORRECT'?records.findLast(r=>r.key===key&&r.payload&&['completed','history'].includes(r.lifecycle)):null),deleted=s.tombstones.includes(key);
 timeFloor=old?.payload.time_floor||null;
 if(old&&x.source==='owner_direct'&&['ADD','CORRECT'].includes(x.action)){
  if(old.payload.value===x.value){if(!x.effective)x.effective=old.effective_at;if(!x.expires)x.expires=old.valid_until;}
  if(!Object.hasOwn(input,'kind'))x.kind=old.payload.kind;
  if(x.kind==='task'&&!x.due)x.due=old.payload.due_at;
  if(!x.effective&&old.effective_at&&x.action==='CORRECT')timeFloor=[timeFloor,old.effective_at].filter(Boolean).sort().at(-1);
  check(!x.effective||!x.expires||x.expires>=x.effective,'继承后的失效日期早于生效日期');
 }
 if(deleted&&(x.action!=='REBUILD'||x.source!=='owner_direct'||x.confirmed!==true)){action='REJECT';reason='字段已删除；须本人提供新的独立内容并明确确认重建。';}
 else if(x.action==='REBUILD'&&(!deleted||x.confirmed!==true||x.source!=='owner_direct')){action='REJECT';reason='重建要求已有删除标记及本人新依据。';}
 else if(old&&x.source==='owner_direct'&&['ADD','CORRECT'].includes(x.action)&&x.effective&&((old.effective_at&&x.effective<old.effective_at)||(timeFloor&&x.effective<=timeFloor))){action='REJECT';reason='早于当前事实或不晚于已更正的时间界限，不能恢复旧状态。';}
 else if(!old&&x.action==='ADD'&&x.source==='owner_direct'&&records.some(r=>r.key===key&&['completed','history','invalidated'].includes(r.lifecycle))){action='REJECT';reason='已完成或已失效，须本人明确新决定才能重新启用。';}
 else if(x.action==='DERIVE'){
 const allowed=new Set(admission(s,x.project,now).allowed_ids),parents=x.parents.map(id=>records.find(r=>r.version_id===id));check(parents.length&&parents.every(r=>r&&allowed.has(r.version_id)),'派生依据须是本角色、本项目当前获准使用的版本');
 const ends=parents.map(r=>r.valid_until).filter(Boolean).sort();check(!x.expires||!ends.length||x.expires<=ends[0],'派生不能延长根来源有效期');if(ends.length&&!x.expires)x.expires=ends[0];
 const starts=parents.map(r=>r.effective_at).filter(Boolean);if(x.effective)starts.push(x.effective);if(starts.length)x.effective=starts.sort().at(-1);
 check(!x.effective||!x.expires||x.expires>=x.effective,'派生有效区间为空');check(!old,'派生目标已存在，请使用新的字段');addRecord('current','current',parents);action='ADD';reason='派生保留根来源、隐私、用途及有效期；不增加可信度。';
 }
 else if(x.source==='external'||x.action==='CONFLICT'||(old&&x.action==='ADD'&&old.payload.value!==x.value)){
 if(records.some(r=>r.key===key&&r.part==='pending'&&r.payload?.value===x.value)){action='NO_CHANGE';reason='同一候选重复，不产生独立证据或可信升级。';}
 else {const currentOld=x.source==='owner_direct'?old:null;const r=addRecord('pending',currentOld?'quarantine':'pending');r.payload.confidence='unverified';after.pending[key]=clone(r.payload);if(currentOld){const rel={parent:currentOld.version_id,child:r.version_id,relation:'CONTRADICT',unresolved:true};r.relations.push(rel);currentOld.relations.push(clone(rel));}action='TEMPORARY';reason=currentOld?'冲突隔离；未覆盖可信现状，限制当前检索。':'外部线索仅保留为隔离候选，不参与派生或正常回答。';}
 }
 else if(old&&old.payload.value===x.value&&x.action==='ADD'&&x.effective===old.effective_at&&x.expires===old.valid_until&&x.kind===old.payload.kind&&x.due===old.payload.due_at&&(x.privacy===old.privacy||x.privacy==='private')){action='NO_CHANGE';reason='同值同约束合并，不创建重复版本或提升可信度。';}
 else if(old&&x.action==='CORRECT'&&x.effective&&x.effective>now){
 for(const r of records)if(r.key===key&&r.scheduled&&r.lifecycle==='pending'){remove(r);r.lifecycle='invalidated';}
 const r=addRecord('pending','pending');r.scheduled=true;r.payload.confidence='self_reported';after.pending[key]=clone(r.payload);action='TEMPORARY';reason='明确的未来更正等待生效；当前有效事实继续使用。';
 }
 else {
 if(old){remove(old);old.lifecycle='superseded';invalidate([old.version_id]);after.history[key]=clone(old.payload);}
 // 明确更正解决同字段冲突，但不为外部候选制造新的独立证据。
 for(const r of records)if(r.key===key&&['quarantine','pending'].includes(r.lifecycle)){remove(r);r.lifecycle='invalidated';for(const rel of r.relations)rel.unresolved=false;}
 for(const r of records)for(const rel of r.relations)if(rel.child.startsWith(x.actor+'/'+key+'/'))rel.unresolved=false;
 addRecord('current','current',[],old);if(deleted)s.tombstones=s.tombstones.filter(k=>k!==key);action=old?'UPDATE':'ADD';reason=old?'本人明确更正；旧版本退出，相关派生需重新评估。':deleted?'本人提供新的明确依据，建立新版本；不读取旧值。':'新增有明确用途的记忆。';}
 }
 const round=s.frames.length+1,versions=clone(records),audit=clone(s.frames.at(-1).governance.audit),lastRecord=records.at(-1);
 audit.push({id:round,role:x.actor,memory_id:x.actor===x.owner?x.actor+'/'+key:null,version_id:x.actor===x.owner&&lastRecord?.key===key?lastRecord.version_id:null,operation:action,relation:x.action==='DERIVE'?'DERIVE':x.action==='CONFLICT'?'CONTRADICT':'INDEPENDENT',timestamp:now+'T12:00:00Z',policy:'V3.3'});
 // 删除后的before必须来自已清理帧，不能把旧值复制回当前事件。
 const safeBefore=clone(s.frames.at(-1).after);
 const a=admission(s,x.project,now);
 s.frames.push({round,source:x.actor!==x.owner?'stranger':x.source==='external'?'push':'owner',input:x.actor!==x.owner?'跨角色操作请求（不确认目标存在性）':x.action+' · '+key,annotation:'本地模拟实验 · 确定性结构化转移；PASS仅为记录格式状态，不是评估成绩。',status:'PASS',decisions:[{action,reason}],before:safeBefore,after,diff:diff(safeBefore,after),governance:{format:'memory-lab.governance.v1',policy:'V3.3',versions,audit},admission:a});
 const ds=dataset(x.actor);return {action,reason,result,dataset:ds,date:now};
 }catch(err){({roles,now,sequence}=backup);throw err;}
 }
 function confirmPersonal(draft,id,actor,project){
 const plan=draft.take(id);check(plan.scope===actor+'/'+project,'确认范围已变化');
 check(!M.forbiddenPersonal(plan.value),'高敏禁存');
 personalGrant={...plan,id};
 try{const state=init(actor),key=project+'__personal_'+plan.category;
 const action=state.tombstones.includes(key)?'REBUILD':state.records.some(r=>r.key===key&&r.lifecycle==='current')?'CORRECT':'ADD';
 return apply({action,actor,owner:actor,project,key:'personal_'+plan.category,value:plan.value,source:'owner_direct',privacy:'restricted',confirmed:true});
 }finally{personalGrant=null;}
 }
 function exportSelected(role,{history=false}={}){const ds=dataset(role),f=ds.data.frames.at(-1);return JSON.stringify({format:'memory-lab.experiment.v1',version:1,mode:'SIMULATED',engine:'browser-deterministic.v1',policy:clone(policy),role,date:now,memory:history?clone(f.after):{...blank(),current:clone(f.after.current)},...(history?{events:f.governance.audit.map(a=>({operation:a.operation,relation:a.relation,timestamp:a.timestamp})),versions:f.governance.versions.map(r=>({id:r.version_id,key:r.key,lifecycle:r.lifecycle,parents:r.parents,source:r.source,payload:r.payload}))}:{})},null,2);}
 return {apply,dataset,exportSelected,confirmPersonal,get date(){return now;}};
}
const api={create,actions};if(typeof module!=='undefined')module.exports=api;else root.MemorySandbox=api;
})(typeof window!=='undefined'?window:globalThis);
