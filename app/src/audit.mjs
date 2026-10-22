// 派生证据只读取现有快照/差异/决策/治理记录，不提取事实、不推断模型内部思考。
import report from '../evaluation.json';
export const validationReport=report;
const parts=['current','completed','history','pending'];
const flatten=s=>Object.fromEntries(parts.flatMap(p=>Object.entries(s[p]).map(([k,v])=>[p+'.'+k,v])));
const base=key=>key.replace(/__previous$/,'');
const records=(ds,index)=>ds.data.frames[index]?.governance?.versions||[];
const tally=(rows,pick)=>{const out={};for(const r of rows){const k=pick(r);out[k]=(out[k]||0)+1;}return out;};
export const lifecycleNames={current:'当前有效',completed:'已完成',history:'历史',pending:'待核实',superseded:'已被替代',quarantine:'隔离',invalidated:'已失效',forgotten:'已遗忘'};
export const authorityNames={direct:'直接来源',external:'外部来源',unknown:'未知来源'};
export const sourceKindNames={owner_direct:'主人直接陈述',external:'外部内容',summary:'摘要',tool_echo:'工具回显',inference:'推断',legacy:'旧数据',unknown:'未知'};
export function lifecycle(ds,index,node,{privateVisible=true}={}){
 if(!privateVisible||!node)return [];
 const result=[];
 for(const f of ds.data.frames.slice(0,index+1)){
  const b=flatten(f.before),a=flatten(f.after);
  for(const path of new Set([...f.diff.added,...f.diff.changed,...f.diff.removed])){
   const [part,key]=path.split('.');if(base(key)!==base(node.key))continue;
   const before=b[path]||null,after=a[path]||null;
   const evidence=(f.governance?.versions||[]).find(r=>r.key===base(key)&&r.revision===(after?.version||before?.version))||null;
   result.push({round:f.round,eventId:`round:${f.round}`,memoryId:after?`${ds.role}/${part}/${key}/${after.version}`:before?`${ds.role}/${part}/${key}/${before.version}`:null,
    role:ds.role,path,sourceType:f.source,source:after?.source||before?.source||null,
    change:!before&&!after?'REDACTED':!before?'ENTER':!after?'EXIT':'CHANGE',
    before,after,evidence,actions:f.decisions.map(d=>d.action),
    reasonScope:'本轮决策；源数据未提供逐字段决策关联',reasons:f.decisions.map(d=>d.reason)});
  }
 }
 return result;
}
// 同一记忆标识的已登记版本，按修订号排列；遗忘版本载荷为null，不恢复原值。
export function versionChain(ds,index,node,{privateVisible=true}={}){
 if(!privateVisible||!node)return [];
 const key=base(node.key);
 return records(ds,index).filter(r=>r.key===key).sort((a,b)=>a.revision-b.revision).map(r=>({versionId:r.version_id,revision:r.revision,lifecycle:r.lifecycle,part:r.part,
  value:r.payload?.value??null,receivedAt:r.created_at,supersedes:r.supersedes??null,supersededBy:r.superseded_by??null,authority:r.authority_class,selected:node.evidence?.version_id===r.version_id}));
}
export function provenance(node,{privateVisible=true}={}){
 if(!privateVisible||!node?.evidence)return [];
 return node.evidence.source.map(s=>({sourceId:s.source_id,kind:s.source_kind,authority:s.authority_class,turn:s.source_turn??null,conversation:s.conversation_id??null,receivedAt:s.ingestion_time??null,reference:s.evidence_reference??null}));
}
// 只列出已登记关系；对端不在本轮治理记录中时标为未解析，不补造节点。
export function lineage(ds,index,node,{privateVisible=true}={}){
 if(!privateVisible||!node?.evidence)return [];
 const map=new Map(records(ds,index).map(r=>[r.version_id,r])),id=node.evidence.version_id;
 return node.evidence.relations.filter(rel=>rel.parent===id||rel.child===id).map(rel=>{const other=rel.parent===id?rel.child:rel.parent,r=map.get(other);
  return {relation:rel.relation,direction:rel.parent===id?'child':'parent',other,otherKey:r?.key??null,otherLifecycle:r?.lifecycle??null,resolved:!!r,unresolved:rel.unresolved};});
}
export function lifecycleSummary(ds,index,{privateVisible=true}={}){
 if(!privateVisible)return null;
 const rows=records(ds,index);return {total:rows.length,counts:tally(rows,r=>r.lifecycle)};
}
export function roleBoundary(ds,index,{privateVisible=true}={}){
 if(!privateVisible)return {hidden:true,role:ds.role};
 const rows=records(ds,index);
 return {hidden:false,role:ds.role,versions:rows.length,owned:rows.filter(r=>r.owner===ds.role&&r.role===ds.role).length,
  scopes:tally(rows,r=>r.scope),audiences:tally(rows,r=>r.audience),projects:tally(rows,r=>r.project),privacy:tally(rows,r=>r.privacy),authority:tally(rows,r=>r.authority_class)};
}
// 审计行不含理由或原文；轮次取该记录首次出现的帧。未核验视角隐藏记忆标识。
export function auditEvents(ds,index,{privateVisible=true}={}){
 const first=new Map();
 for(const f of ds.data.frames.slice(0,index+1))for(const a of f.governance?.audit||[])if(!first.has(a.id))first.set(a.id,f.round);
 const audit=ds.data.frames[index]?.governance?.audit||[];
 return audit.map(a=>({id:a.id,round:first.get(a.id)??null,operation:a.operation,relation:a.relation,memoryId:privateVisible?a.memory_id:null,versionId:privateVisible?a.version_id:null,timestamp:a.timestamp,policy:a.policy}));
}
export function decisionTrace(ds,index,{privateVisible=true}={}){
 const f=ds.data.frames[index];if(!f)throw new Error('无效轮次');
 if(!privateVisible)return {hidden:true,round:f.round,steps:[{label:'展示边界',value:'未核验视角不披露输入、候选及私人状态。'}]};
 const changes=['added','changed','removed'].flatMap(kind=>f.diff[kind].map(path=>({kind,path})));
 return {hidden:false,round:f.round,source:f.source,changes,decisions:f.decisions,
  steps:[{label:'输入事件',value:f.input},
   {label:'候选记忆',value:'未单独记录提取候选。'},
   {label:'安全与可信检查',value:f.decisions.some(d=>d.action==='REJECT')?'记录中包含 REJECT，具体范围见原决策理由。':'源数据未单列安全检查记录。'},
   {label:'冲突检查',value:'源数据未单列冲突检查；可核对前后快照与当前决策。'},
   {label:'本地引擎决策',value:(f.decisions.map(d=>d.action+'：'+d.reason).join('\n')||'未记录操作')+(f.governance?'\n策略 '+f.governance.policy+'；已有版本 '+f.governance.versions.length+'；无原文审计事件 '+f.governance.audit.length+'。':'')},
   {label:'状态结果',value:changes.length?changes.map(c=>({added:'进入',changed:'变化',removed:'退出'})[c.kind]+' '+c.path).join('\n'):'快照无登记变化'}]};
}
export function diagnostics(graph){
 if(!graph)return {rendering:'二维降级',nodes:0,objects:null};
 let objects=0;graph.scene.traverse(()=>objects++);
 return {rendering:graph.destroyed?'已释放':'WebGL',nodes:graph.items.size,objects};
}
