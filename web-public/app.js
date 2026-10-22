(function(root){
 'use strict';
 const diagnostic=(stage,line=0,column=0)=>root.__TAURI__?.core.invoke('frontend_diagnostic',{stage,line,column}).catch(()=>{});
 root.addEventListener('error',event=>diagnostic('error',event.lineno||0,event.colno||0));
 root.addEventListener('unhandledrejection',()=>diagnostic('rejection'));
 diagnostic('boot');
 const M=root.MemoryModel,S=root.MemoryState,A=root.MemoryGraph,doc=root.document;
 if(!M||!S||!A){doc.getElementById('notice').hidden=false;doc.getElementById('notice').textContent='应用资源不完整，请完整保留应用目录。';return;}
 const ids=['evolution-panel','reading-round','changes-list','snapshot-title','snapshot-note','snapshot-all','detail-round','admission-summary','admission-list','workbench','inspector','toggle-inspector','close-inspector','memory-browser','validation','evidence-mode','node-summary','memory-evidence','round-evidence','lifecycle','trace','diagnostics','validation-summary','validation-results','choose-file','navigation','policy','data-name','import-file','restore','export','notice','view-title','view-kicker','count-current','count-task','count-pending','count-events','category','state','reset','focus','motion','low','role-panel','role-name','permission','overview-panel','overview-state','graph-stage','graph','graph-fallback','fallback-message','security-panel','security-events','legend','visible-count','node-list','round-status','node-title','node-value','node-meta','detail-focus','node-diff','round-title','input','decisions','annotation','diff','restart','prev','play','next','speed','round-label','event-description','source','timeline','range','tour','tour-label','versions','provenance','lineage','lifecycle-summary','role-boundary','audit-summary','audit-log'];
 const e=Object.fromEntries(ids.map(id=>[id,doc.getElementById(id)]));
 const text=(tag,value,className)=>{const n=doc.createElement(tag);n.textContent=value;if(className)n.className=className;return n;};
 const titles={spatial:['关系分析','三维关系图谱'],overview:['记忆演化','记忆演化'],graph:['记忆演化','记忆演化'],evolution:['记忆演化','记忆演化'],roles:['角色作用域','角色边界'],security:['治理事件','安全事件']};
 let experimentMode=false;
 let ds,clock,view='graph',selected=null,model={nodes:[],edges:[],count:0},graphics=null,empty=false,tourState=null,last=performance.now(),animationFrame,disposed=false,importGeneration=0,evidenceMode=false,inputFingerprint=null,inspectorChoice=null;
 function notice(message,error=false){e.notice.hidden=false;e.notice.textContent=message;e.notice.classList.toggle('error',error);}
 function unavailable(message){e.workbench.classList.add('fallback-mode');e['memory-browser'].open=true;e['graph-fallback'].hidden=false;e['fallback-message'].textContent=message;e.focus.disabled=true;e.reset.disabled=true;e['detail-focus'].disabled=true;doc.getElementById('graph-caption').hidden=true;graphics=null;}
 try{ds=M.adapt(root.REPLAY_DATA);}catch(err){notice('内置数据未通过校验：'+err.message,true);for(const n of doc.querySelectorAll('button,input,select'))n.disabled=true;return;}
 clock=M.controller(ds.data.frames.length);
 e.motion.checked=!root.matchMedia('(prefers-reduced-motion: reduce)').matches;
 for(const [key,s]of Object.entries(M.states)){const o=text('option',s.name);o.value=key;e.state.append(o);const n=text('span','');const b=text('b','');b.style.color='#'+s.color.toString(16).padStart(6,'0');n.append(b,text('span',s.name));e.legend.append(n);}
 for(const [type,name]of [['主体归属','主体归属'],['已存储历史版本','历史版本'],['SUPERSEDE','替代'],['DERIVE','派生']]){const n=text('span','','edge-key');const b=text('i','');b.style.background='#'+(A?.edgeColors?.[type]??0x35515b).toString(16).padStart(6,'0');n.append(b,text('span',name));e.legend.append(n);}
 const chip=(label,value,className)=>{const n=text('span','',className?'chip '+className:'chip');n.append(text('span',label),text('b',String(value)));return n;};
 const stateLabel=n=>n.evidence?.scheduled?'等待生效':n.state==='task'&&n.payload?.paused?'任务已暂停':n.state==='task'&&n.payload?.task_status==='overdue'?'逾期待确认':n.evidence?.relations.some(r=>r.relation==='CONTRADICT'&&r.unresolved)?'有冲突，回答受限':M.states[n.state].name;
 const lifeName=k=>A.lifecycleNames?.[k]||k,authName=k=>A.authorityNames?.[k]||k,kindName=k=>A.sourceKindNames?.[k]||k;
 try{if(!root.MemoryGraph?.GraphView)throw new Error('缺少本地Three.js资源');graphics=new root.MemoryGraph.GraphView(e.graph,{states:M.states,onSelect:id=>{selected=id;showDetails();renderDetails();renderNodes();graphics?.select(id);},onUnavailable:unavailable});graphics.configure({motion:e.motion.checked,low:e.low.checked});}catch(err){unavailable('设备或WebView未提供可用WebGL2；未启用三维场景。');}
 function updateInspector(){const open=inspectorChoice??((root.innerWidth||1440)>=1150);e.workbench.classList.toggle('inspector-open',open);e.inspector.hidden=!open;e['toggle-inspector'].setAttribute('aria-expanded',String(open));}
 function showDetails(){inspectorChoice=true;updateInspector();}
 const onResize=()=>updateInspector();root.addEventListener('resize',onResize);
 e['toggle-inspector'].addEventListener('click',()=>{inspectorChoice=e.inspector.hidden;updateInspector();});
 e['close-inspector'].addEventListener('click',()=>{inspectorChoice=false;updateInspector();e['toggle-inspector'].focus?.();});
 updateInspector();
 function visible(){return !empty&&e.permission.value==='owner';}
 function frame(){return ds.data.frames[clock.index];}
 function stopTour(){tourState=null;e.tour.classList.remove('tour-active');e.tour.textContent='30 秒导览';e['tour-label'].hidden=true;e['tour-label'].textContent='虚构图册项目 · SIMULATED';e.speed.disabled=false;}
 function pause(){clock.pause();graphics?.setPaused?.(true);e.play.textContent='继续';}
 root.addEventListener('memory-native-open',()=>{pause();stopTour();});
 function jump(index,fromTour=false){if(!fromTour)stopTour();clock.jump(index);graphics?.setPaused?.(false);render(false);}
 function setView(name){const detail=name;name=['overview','evolution'].includes(name)?'graph':name;view=name;e.workbench.dataset.view=name;e.workbench.classList.toggle('spatial-mode',name==='spatial');e['view-title'].textContent=titles[name][1];e['view-kicker'].textContent=titles[name][0];for(const b of e.navigation.querySelectorAll('button')){b.classList.toggle('active',b.dataset.view===name);b.setAttribute('aria-current',b.dataset.view===name?'page':'false');}e['role-panel'].hidden=name!=='roles';e['overview-panel'].hidden=detail!=='overview';e['security-panel'].hidden=name!=='security';e['graph-stage'].hidden=!['spatial','roles'].includes(name);e['evolution-panel'].hidden=name!=='graph';e['memory-browser'].hidden=name==='security';e['memory-browser'].open=true;render(false);graphics?.resizeToHost?.();graphics?.request();}
 function renderDetails(){
   const n=model.nodes.find(n=>n.id===selected);for(const id of ['node-meta','lifecycle','versions','provenance','lineage'])e[id].replaceChildren();e['node-summary'].textContent='';
   if(!n||!visible()){e['node-title'].textContent=visible()?'选择一个记忆节点':'私人记忆不向该视角展示';e['node-value'].textContent=visible()?'图谱与二维列表均可选择。':'这是本地展示边界，不是平台认证结果。';e['node-diff'].textContent='';e['detail-focus'].disabled=true;e['detail-round'].disabled=true;e.focus.disabled=true;return;}
   e['node-title'].textContent=n.label;e['node-value'].textContent=n.payload?.value||(n.redacted?'无值证据；原载荷已清除，仅展示已登记的来源、版本与关系。':'仅有退出记录，原值已清理或未在快照保留。');
   const p=n.payload,meta=[['状态',stateLabel(n)],['所属角色',ds.role],['类别',n.category],['来源',p?.source||'本轮差异与决策'],['可信度',p?(p.confidence==='unverified'?'未经证实':'本人自述'):'无事实值'],['隐私',p?(p.privacy==='restricted'?'受限':'个人'):'不含原值'],['版本',p?String(p.version):'退出标记'],['时效',p?.ttl||'非长期记忆节点']];
   if(n.evidence)meta.push(['记忆标识',n.evidence.memory_id],['版本标识',n.evidence.version_id],['来源权威',authName(n.evidence.authority_class)],['治理状态',lifeName(n.evidence.lifecycle)],['范围',n.evidence.project+' / '+n.evidence.audience+' / '+n.evidence.scope],['根证据',n.evidence.roots.join('、')],['派生依据',n.evidence.parents.join('、')||'无派生依赖']);
   if(p?.due_at)meta.push(['截止',p.due_at]);if(p?.task_status)meta.push([n.state==='task'?'任务状态':'记录中的任务状态',({active:'进行中',overdue:'逾期待确认',completed:'已完成'})[p.task_status]]);
   for(const [k,v]of meta)e['node-meta'].append(text('dt',k),text('dd',v));
   e['node-summary'].textContent=stateLabel(n)+' · '+n.category+' · '+(p?.source||'无值退出标记');
   renderLifecycle(n);renderGovernance(n);
   const old=frame().before[n.part]?.[n.key],after=frame().after[n.part]?.[n.key];
   e['node-diff'].textContent=!n.payload?'当前展示仅保留无值元数据，不重建已清除内容。':JSON.stringify(old)===JSON.stringify(after)&&!n.transient?'本轮没有变化。':'之前：'+(old?.value||'无保留值')+'\n之后：'+(after?.value||'退出该分区，无保留值')+'\n'+(n.transient?'可控记录已退出。':'按本轮快照更新。');
   e['detail-focus'].disabled=!graphics;e.focus.disabled=!graphics;const first=ds.data.frames.slice(0,clock.index+1).find(f=>n.evidence?(f.governance?.versions||[]).some(r=>r.version_id===n.evidence.version_id):n.payload?f.after[n.part]?.[n.key]?.version===n.payload.version:f.round===frame().round);e['detail-round'].disabled=!first;e['detail-round'].dataset.round=String(first?.round||'');
 }
 function renderLifecycle(n){
   const rows=A.lifecycle(ds,clock.index,n,{privateVisible:visible()});
   for(const row of rows){const item=text('li',''),button=text('button','第 '+row.round+' 轮');button.addEventListener('click',()=>{pause();jump(row.round-1);});
     item.append(button,text('strong',({ENTER:'进入 ',CHANGE:'变化 ',EXIT:'退出 ',REDACTED:'无值差异标记 '})[row.change]+row.path));
     item.append(text('p',!n.payload?'当前仅保留退出或无值证据，不回查历史原文。':(row.before?.value||'无保留值')+' → '+(row.after?.value||'无保留值')));
     const detail=doc.createElement('details');detail.append(text('summary','来源与版本'),text('pre','memoryId：'+(row.memoryId||'未记录')+'\n事件：'+row.eventId+' · '+M.sourceNames[row.sourceType]+'\n事实来源：'+(row.source||'未保留')+'\n版本：'+(row.before?.version??'无')+' → '+(row.after?.version??'无')+'\n'+row.reasonScope+'\n'+row.actions.join(' / ')+'\n'+row.reasons.join('；')+(row.evidence?'\n治理版本：'+row.evidence.version_id+' · '+lifeName(row.evidence.lifecycle)+' · '+authName(row.evidence.authority_class):'\n治理版本：未记录')));item.append(detail);e.lifecycle.append(item);
   }
   if(!rows.length)e.lifecycle.append(text('li','截至本轮没有可展示的生命周期变化。'));
 }
 function renderGovernance(n){
   const versions=A.versionChain(ds,clock.index,n,{privateVisible:visible()});
   for(const v of versions){const li=text('li','',v.selected?'selected':'');const head=text('div','','step-head');head.append(text('strong','修订 '+v.revision),text('span',lifeName(v.lifecycle),'chip state-'+v.lifecycle));li.append(head,text('p',v.value??'原值已清除，不恢复'));
     li.append(text('small',v.versionId+' · '+authName(v.authority)+' · 接收 '+v.receivedAt.slice(11,19)+'（虚拟时钟）'+(v.supersedes?' · 替代 '+v.supersedes:'')+(v.supersededBy?' · 被 '+v.supersededBy+' 替代':'')));e.versions.append(li);}
   if(!versions.length)e.versions.append(text('li',n.evidence?'本轮无已登记版本。':'该节点没有绑定治理版本（退出标记或旧版本快照）。','empty'));
   const sources=A.provenance(n,{privateVisible:visible()});
   for(const s of sources){const li=text('li','');li.append(text('strong',kindName(s.kind)+' · '+authName(s.authority)),text('small','证据 '+(s.reference||'未记录')+' · 源轮次 '+(s.turn??'未记录')+' · 会话 '+(s.conversation||'未记录')));e.provenance.append(li);}
   if(!sources.length)e.provenance.append(text('li','未登记来源记录。','empty'));
   const rels=A.lineage(ds,clock.index,n,{privateVisible:visible()});
   for(const r of rels){const li=text('li','');li.append(text('strong',(r.relation==='SUPERSEDE'?'替代':r.relation==='DERIVE'?'派生':'冲突')+' · '+(r.direction==='parent'?'上游 ':'下游 ')+r.other),text('small',r.resolved?(M.label(r.otherKey)+' · '+lifeName(r.otherLifecycle)):'对端未在本轮记录中')+(r.unresolved?'；冲突未解决':''));e.lineage.append(li);}
   if(!rels.length)e.lineage.append(text('li','无已登记派生、替代或冲突关系。','empty'));
 }
 function renderGovernanceSummary(){
   e['lifecycle-summary'].replaceChildren();e['role-boundary'].replaceChildren();
   const summary=A.lifecycleSummary(ds,clock.index,{privateVisible:visible()});
   if(summary&&summary.total){e['lifecycle-summary'].append(text('span','治理版本 '+summary.total,'chip-label'));for(const [k,v]of Object.entries(summary.counts))e['lifecycle-summary'].append(chip(lifeName(k),v,'state-'+k));}
   const b=A.roleBoundary(ds,clock.index,{privateVisible:visible()});
   const rows=b.hidden?[['角色',b.role],['可见范围','未核验视角不展示版本统计']]:[['角色',b.role],['归属一致','本角色 '+b.owned+' / '+b.versions+' 条版本（导入校验要求 owner = role）'],['作用域',Object.entries(b.scopes).map(([k,v])=>k+' '+v).join(' · ')||'无'],['受众',Object.entries(b.audiences).map(([k,v])=>k+' '+v).join(' · ')||'无'],['项目',Object.entries(b.projects).map(([k,v])=>k+' '+v).join(' · ')||'无'],['隐私',Object.entries(b.privacy).map(([k,v])=>(k==='restricted'?'受限':'个人')+' '+v).join(' · ')||'无'],['来源权威',Object.entries(b.authority).map(([k,v])=>authName(k)+' '+v).join(' · ')||'无']];
   for(const [k,v]of rows)e['role-boundary'].append(text('dt',k),text('dd',v));
 }
 function renderAudit(){
   e['audit-summary'].replaceChildren();e['audit-log'].replaceChildren();
   if(!visible()){e['audit-log'].append(text('li','当前视角不披露私人审计记录或统计。'));return;}
   const rows=A.auditEvents(ds,clock.index,{privateVisible:visible()}),counts={};for(const r of rows)counts[r.operation]=(counts[r.operation]||0)+1;
   for(const [k,v]of Object.entries(counts))e['audit-summary'].append(chip(k,v,['REJECT','DELETE','REVOKE'].includes(k)?'op-alert':''));
   for(const r of rows.filter(r=>!['ADD','UPDATE','NO_CHANGE'].includes(r.operation))){const li=text('li','');const go=text('button','第 '+r.round+' 轮');go.addEventListener('click',()=>jump(r.round-1));li.append(go,text('strong',r.operation+' · '+r.relation),text('small',(r.memoryId||(visible()?'无记忆标识':'记忆标识已隐藏'))+' · #'+r.id+' · '+r.policy));e['audit-log'].append(li);}
   if(!rows.length)e['audit-log'].append(text('li','截至本轮没有治理审计记录。','empty'));
   else if(!e['audit-log'].children.length)e['audit-log'].append(text('li','截至本轮仅有新增、更新或无变化记录。','empty'));
 }
 function renderEvidence(){
   renderAdmission();
   const trace=A.decisionTrace(ds,clock.index,{privateVisible:visible()});e.trace.replaceChildren();
   for(const step of trace.steps){const li=text('li','');li.append(text('strong',step.label),text('p',step.value));e.trace.append(li);}
   const stats=A.diagnostics(graphics);e.diagnostics.textContent='第 '+frame().round+' 轮 · '+ds.mode+'\n渲染：'+stats.rendering+'\n事实节点：'+model.count+' · 场景节点（含过渡）：'+stats.nodes+'\n场景对象：'+(stats.objects??'不可用')+'\n策略：'+ds.data.policy.version+'\n输入 SHA-256：'+(inputFingerprint||'内置数据由资源清单校验；未计算导入指纹')+'\n指纹仅校验完整性，不认证来源。';
   const report=A.validationReport,summary=report.summary;if(ds.data.experiment){e['validation-summary'].textContent='当前为交互实验，不套用内置演示评估结果。';e['validation-results'].replaceChildren();return;}e['validation-summary'].textContent=visible()?`内置演示：${summary.scenarios} 场景 · ${summary.passed} PASS · ${summary.failed} FAIL · ${summary.turns} 轮\n执行：${report.executed_at}；不用于评价导入文件。`:'当前视角不披露私人评估统计。';
   e['validation-results'].replaceChildren();
   if(!e.validation.open)return;
   if(!visible()){e['validation-results'].append(text('p','当前视角不展开基线输入及状态值。'));return;}
   for(const row of report.results){const d=doc.createElement('details');d.append(text('summary',row.id+' · '+row.status+' · '+row.turns.length+' 轮'));for(const turn of row.turns){const inner=doc.createElement('details');inner.append(text('summary','第 '+turn.turn+' 轮 · '+turn.status),text('pre',JSON.stringify(turn,null,2)));d.append(inner);}e['validation-results'].append(d);}
 }
 function renderAdmission(){
   e['admission-list'].replaceChildren();
   if(!visible()){e['admission-summary'].textContent='当前视角无权查看私人检索记录。';return;}
   const a=frame().admission;
   if(!a){e['admission-summary'].textContent='本轮未记录检索准入，不能从已保存状态推定可用。';return;}
   const records=new Map((frame().governance?.versions||[]).map(r=>[r.version_id,r]));
   e['admission-summary'].textContent=`当轮记录：${a.allowed_ids.length} 项准入 · ${a.denied.length} 项限制。`;
   for(const id of a.allowed_ids){const r=records.get(id);const li=text('li',M.label(r.key)+' · 当轮准入'+(r.payload?'':'；载荷已清除，不恢复原值'));li.append(text('small',id));e['admission-list'].append(li);}
   const reasons={contradiction:'存在未解决冲突，限制作为当前依据',future:'生效时间在未来，暂不进入当前回答',expired:'信息已经失效',permission:'当前用途或权限不允许',lineage:'派生依据不可用',paused:'任务已暂停，当前行动不准入'};
   for(const d of a.denied)e['admission-list'].append(text('li',reasons[d.reason]||('已记录限制：'+d.reason)));
   if(!a.allowed_ids.length&&!a.denied.length)e['admission-list'].append(text('li','没有登记准入项或限制项。'));
 }
 e.validation.addEventListener('toggle',renderEvidence);
 e['evidence-mode'].addEventListener('click',()=>{evidenceMode=!evidenceMode;e['evidence-mode'].setAttribute('aria-pressed',String(evidenceMode));e['evidence-mode'].textContent=evidenceMode?'收起证据':'展开证据';for(const d of doc.querySelectorAll('.audit-section'))d.open=evidenceMode;renderEvidence();});
 function renderNodes(){
   e['node-list'].replaceChildren();e['visible-count'].textContent=visible()?`${model.count} 条事实`+(model.nodes.length>model.count?` · ${model.nodes.length-model.count} 条无值证据`:''):'内容受限';
   e['snapshot-title'].textContent='第 '+frame().round+' 轮后的记忆';
   e['snapshot-note'].textContent=visible()?'本轮变化优先显示。当前、任务、候选、完成与历史记录均取自本轮快照；已保存不等于获准回答。':'当前视角不展示私人快照或数量。';
   e['snapshot-all'].hidden=e.category.value==='all'&&e.state.value==='all'||!visible();
   const order={current:0,task:1,pending:2,completed:3,history:4,retired:5};
   for(const n of [...model.nodes].sort((a,b)=>Number(b.changed)-Number(a.changed)||(order[a.state]-order[b.state]))){
     const b=text('button',n.label);b.dataset.memoryId=n.id;b.dataset.part=n.part;b.dataset.changed=String(n.changed);
     b.append(text('small',stateLabel(n)+(n.changed?' · 本轮变化':'')),text('span',n.payload?.value||(n.redacted?'原值已清除，仅保留无值证据':'已退出；本轮未保留原值'),'memory-preview'));
     if(n.payload)b.append(text('span',[n.payload.source,n.state==='task'&&n.payload.paused?'已暂停':n.state==='task'&&n.payload.task_status==='overdue'?'逾期待确认':null,n.payload.due_at?'截止 '+n.payload.due_at:n.payload.event_time?'生效 '+n.payload.event_time:n.payload.ttl].filter(Boolean).join(' · '),'memory-source'));
     b.classList.toggle('selected',n.id===selected);b.setAttribute('aria-pressed',String(n.id===selected));b.addEventListener('click',()=>{selected=n.id;showDetails();renderDetails();renderNodes();graphics?.select(n.id);if(!e['graph-stage'].hidden)graphics?.focus(n.id);});e['node-list'].append(b);
   }
   if(!model.nodes.length)e['node-list'].append(text('p',visible()?'本轮没有可展示的记忆；也可检查筛选条件。':'当前视角没有可展示的私人节点。','empty'));
 }
 function renderRound(){
   const r=M.roundView(ds,clock.index,{privateVisible:visible()});
   e.input.textContent=r.input;e['reading-round'].textContent='第 '+frame().round+' 轮输入';e['changes-list'].replaceChildren();
   const parts={current:'当前记录',pending:'待核实区',completed:'已完成',history:'历史区'};
   for(const c of r.changes){
     const row=text('article','','memory-change');row.dataset.path=c.path;row.dataset.kind=c.kind;
     row.append(text('h3',c.label),text('small',({added:'进入',changed:'更新',removed:'移出'})[c.kind]+' · '+parts[c.part]));
     if(c.kind!=='added')row.append(text('p','原记忆：'+(c.before??'原值已清除或未记录'),'change-before'));
     if(c.kind!=='removed')row.append(text('p','处理后：'+(c.after??'原值已清除或未记录'),'change-after'));
     else row.append(text('p','处理后：不再位于'+parts[c.part]+'。其他仍保留的内容见本轮快照。','change-after'));
     if(c.before!==null&&c.before===c.after)row.append(text('small','内容相同；记录或版本发生变化。'));
     e['changes-list'].append(row);
   }
   if(!r.changes.length)e['changes-list'].append(text('p',visible()?'本轮没有登记快照变化。操作是否被拒绝、仅临时处理或保持原状，见下方实际记录。':'当前视角不展示私人变化。','empty'));
   e.decisions.replaceChildren();for(const d of r.decisions){const n=text('div','','decision');n.append(text('strong',actionNames[d.action]||d.action),text('span',d.reason));e.decisions.append(n);}
   if(visible())for(const a of A.auditEvents(ds,clock.index).filter(a=>a.round===frame().round&&a.operation==='NO_CHANGE')){
     const n=model.nodes.find(n=>n.payload&&n.evidence?.version_id===a.versionId);
     if(n)e.decisions.append(text('p','未改写的关联记录：'+n.label+' · '+n.payload.value,'retained-record'));
   }
   if(!r.decisions.length)e.decisions.append(text('p',visible()?'本轮未记录处理决定。':'当前视角不披露私人处理记录。','empty'));
 }
 function renderEvents(){
   e['security-events'].replaceChildren();
   if(!visible()){e['security-events'].append(text('p','未核验视角不展示私人事件、目标或数量。授权视角可查看拒绝依据。'));renderAudit();return;}
   const events=M.events(ds,clock.index).filter(x=>e.source.value==='all'||M.sourceNames[e.source.value]===x.source);
   for(const event of events){const row=text('div','','security-event'),jumpButton=text('button','第 '+event.round+' 轮');jumpButton.addEventListener('click',()=>jump(event.round-1));const body=text('div','');body.append(text('strong',event.type+' · '+event.action),text('p','来源：'+event.source+'；目标：'+event.target),text('p',visible()?event.reason:'未核验视角不披露私人原文及其存在性。'));row.append(jumpButton,body);e['security-events'].append(row);}
   if(!events.length)e['security-events'].append(text('p','当前轮次范围与来源筛选下没有安全事件。','empty'));
   renderAudit();
 }
 function setCatalog(){graphics?.setCatalog(ds.data.frames.flatMap((_,i)=>M.graph(ds,i).nodes));}
 setCatalog();
 const actionNames={ADD:'新增',UPDATE:'更新',RETIRE:'退出活跃状态',DELETE:'删除可控记录',REJECT:'拒绝请求',TEMPORARY:'仅临时上下文',NO_CHANGE:'状态不变'};
 function focusChange(){const n=model.nodes.find(n=>n.changed&&!n.transient)||model.nodes.find(n=>n.changed);if(n){selected=n.id;renderDetails();renderNodes();graphics?.select(selected);graphics?.focus(selected);}else graphics?.reset();}
 function render(animate=false){
   const f=frame(),list=S.indices(ds.data,e.source.value),previous=model.nodes.find(n=>n.id===selected);empty=!list.length;
   model=M.graph(ds,clock.index,{category:e.category.value,state:e.state.value,privateVisible:visible()});
   if(!model.nodes.some(n=>n.id===selected))selected=model.nodes.find(n=>previous&&n.key===previous.key&&n.part===previous.part)?.id||model.nodes.find(n=>previous&&!n.transient&&n.key===previous.key)?.id||model.nodes.find(n=>n.changed&&!n.transient)?.id||model.nodes[0]?.id||null;
   graphics?.setData(model,ds.role,{animate,privateVisible:visible()});graphics?.select(selected);
   const g=f.after,current=Object.values(g.current),events=M.events(ds,clock.index);
   e['count-current'].textContent=visible()?current.filter(p=>p.kind!=='task').length:'—';e['count-task'].textContent=visible()?current.filter(p=>p.kind==='task').length:'—';e['count-pending'].textContent=visible()?Object.keys(g.pending).length:'—';e['count-events'].textContent=visible()?events.length:'—';
   e.export.disabled=e.permission.value!=='owner'||experimentMode;e['choose-file'].disabled=experimentMode;e.restore.disabled=experimentMode;
   e.policy.textContent=ds.data.policy.version+' / '+ds.data.policy.sha256.slice(0,8);e['data-name'].textContent=`${ds.role} · ${ds.data.frames.length} 轮模拟`;e.workbench.classList.toggle('experiment-active',experimentMode);e['role-name'].textContent=ds.role+' · 角色专属作用域';
   e['overview-state'].textContent=visible()?(f.decisions[0]?.reason||'本轮没有记录变化。'):'当前视角不展示私人内容。';e['overview-state'].title=e['overview-state'].textContent;
   e['round-status'].textContent=ds.data.experiment?'结构化操作记录 · 本地模拟':f.status+' · 本地';e['round-title'].textContent='第 '+f.round+' 轮 · '+M.sourceNames[f.source];
   renderRound();
   e.annotation.textContent=visible()?f.annotation:'';
   e.diff.textContent=visible()?['新增：'+(f.diff.added.map(k=>k.split('.').map(M.label).join(' · ')).join('、')||'无'),'更新：'+(f.diff.changed.map(k=>k.split('.').map(M.label).join(' · ')).join('、')||'无'),'移出：'+(f.diff.removed.map(k=>k.split('.').map(M.label).join(' · ')).join('、')||'无')].join('\n'):'字段和值已隐藏。';
   renderDetails();renderNodes();renderEvents();renderEvidence();renderGovernanceSummary();
   e.timeline.replaceChildren();for(const i of list){const f=ds.data.frames[i],b=text('button',String(f.round).padStart(2,'0'));b.title='第 '+f.round+' 轮 · '+M.sourceNames[f.source]+' · '+f.decisions.map(d=>d.action).join(' / ');b.classList.toggle('selected',i===clock.index);b.classList.toggle('reject',f.decisions.some(d=>d.action==='REJECT'));b.classList.toggle('update',f.decisions.some(d=>d.action==='UPDATE'));b.classList.toggle('retire',f.decisions.some(d=>['RETIRE','DELETE'].includes(d.action)));b.classList.toggle('add',f.decisions.some(d=>d.action==='ADD'));b.textContent=String(f.round).padStart(2,'0');b.setAttribute('aria-label',b.title);if(i===clock.index)b.setAttribute('aria-current','step');b.addEventListener('click',()=>jump(i));e.timeline.append(b);}
   if(empty)e.timeline.append(text('p','此来源没有轮次。','empty'));
   e.range.setAttribute('aria-valuetext',`第 ${f.round} 轮，共 ${ds.data.frames.length} 轮`);e.range.max=String(ds.data.frames.length);e.range.value=String(f.round);e.range.disabled=empty;e.play.disabled=empty;e.prev.disabled=empty||S.select(ds.data,clock.index,-1,e.source.value)===clock.index;e.next.disabled=empty||S.select(ds.data,clock.index,1,e.source.value)===clock.index;
   e['round-label'].textContent=String(f.round).padStart(2,'0')+' / '+ds.data.frames.length;e['event-description'].textContent=empty?'筛选无结果':M.sourceNames[f.source]+' · '+[...new Set(f.decisions.map(d=>actionNames[d.action]||d.action))].join('、');e['event-description'].title=e['event-description'].textContent;const active=e.timeline.querySelector('[aria-current=step]');if(active)e.timeline.scrollLeft=Math.max(0,active.offsetLeft-e.timeline.offsetLeft-e.timeline.clientWidth/2+active.offsetWidth/2);e.play.textContent=clock.playing?'暂停':'播放';
 }
 e.navigation.addEventListener('click',event=>{const b=event.target.closest('[data-view]');if(b)setView(b.dataset.view);});
 e.prev.addEventListener('click',()=>jump(S.select(ds.data,clock.index,-1,e.source.value)));e.next.addEventListener('click',()=>jump(S.select(ds.data,clock.index,1,e.source.value)));
 e.range.addEventListener('input',()=>{e.source.value='all';empty=false;jump(Number(e.range.value)-1);});
 e.source.addEventListener('change',()=>{pause();stopTour();const index=S.select(ds.data,clock.index,0,e.source.value);empty=index<0;if(index>=0)clock.jump(index);render(false);});
 e.play.addEventListener('click',()=>{if(clock.playing)pause();else{const previousIndex=clock.index;clock.play();if(tourState)clock.jump(previousIndex);else{const list=S.indices(ds.data,e.source.value);if(list.length&&(previousIndex===list.at(-1)||!list.includes(clock.index)))clock.jump(list[0]);}graphics?.setPaused?.(false);if(previousIndex!==clock.index)render(false);}e.play.textContent=clock.playing?'暂停':'继续';});
 e.restart.addEventListener('click',()=>{stopTour();e.source.value='all';empty=false;clock.jump(0);clock.play();graphics?.setPaused?.(false);render(false);});
 e.speed.addEventListener('change',()=>clock.setSpeed(Number(e.speed.value)));
 for(const id of ['category','state','permission'])e[id].addEventListener('change',()=>render(false));
 for(const id of ['motion','low'])e[id].addEventListener('change',()=>graphics?.configure({motion:e.motion.checked,low:e.low.checked}));
 e.reset.addEventListener('click',()=>graphics?.reset());for(const id of ['focus','detail-focus'])e[id].addEventListener('click',()=>{if(id==='detail-focus'&&e['graph-stage'].hidden)setView('spatial');graphics?.focus(selected);});
 e['detail-round'].addEventListener('click',()=>{if(e['detail-round'].disabled||!visible())return;pause();e.source.value='all';jump(Number(e['detail-round'].dataset.round)-1);});
 e['snapshot-all'].addEventListener('click',()=>{e.category.value='all';e.state.value='all';render(false);});
 e.tour.addEventListener('click',()=>{if(tourState){stopTour();pause();return;}const stops=M.tour(ds);tourState={stops,index:0,elapsed:0};e.tour.textContent='结束路演';e['tour-label'].hidden=false;e.tour.classList.add('tour-active');e.speed.disabled=true;e.source.value='all';e.permission.value='owner';e.category.value='all';e.state.value='all';empty=false;clock.jump(stops[0].index);clock.play();graphics?.setPaused?.(false);setView('overview');focusChange();e['tour-label'].textContent='路演 1 / '+stops.length+' · '+stops[0].title;});
 function replaceData(next,fingerprint=null,incremental=false){inputFingerprint=fingerprint;pause();stopTour();ds=next;clock=M.controller(ds.data.frames.length);if(!incremental){selected=null;e.source.value='all';e.category.value='all';e.state.value='all';setCatalog();}empty=false;render(false);}
 for(const id of ['choose-file','restore','export'])e[id].addEventListener('click',()=>{const menu=e[id].closest('details');if(menu)menu.open=false;});
 e['choose-file'].addEventListener('click',()=>e['import-file'].click());
 e['import-file'].addEventListener('change',async()=>{if(experimentMode){notice('请先返回演示再导入回放；实验状态保留。',true);return;}const generation=++importGeneration;const file=e['import-file'].files[0];if(!file)return;try{
   if(file.size>5*1024*1024)throw new Error('文件超过5MB');const bytes=await file.arrayBuffer();
   const next=M.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
   const fingerprint=root.crypto?.subtle?Array.from(new Uint8Array(await root.crypto.subtle.digest('SHA-256',bytes))).map(b=>b.toString(16).padStart(2,'0')).join(''):null;
   if(generation!==importGeneration||disposed)return;
   if(next.data.policy.sha256!==root.REPLAY_DATA.policy.sha256)throw new Error('守则哈希与内置'+root.REPLAY_DATA.policy.version+'基线不一致');
   replaceData(next,fingerprint);notice('已导入SIMULATED回放；'+(fingerprint?'已计算原始文件SHA-256，未改写原文件。':'此环境不提供SHA-256，未计算指纹。'));
 }catch(err){if(generation===importGeneration&&!disposed)notice('导入失败，保留原数据：'+(err instanceof SyntaxError?'JSON格式错误':err.message),true);}
 finally{if(generation===importGeneration)e['import-file'].value='';}});
 e.restore.addEventListener('click',()=>{if(experimentMode){notice('请使用重置实验，或返回演示。');return;}importGeneration++;replaceData(M.adapt(root.REPLAY_DATA));notice('已恢复独立虚构项目的28步模拟数据。');});
 e.export.addEventListener('click',async()=>{if(experimentMode){notice('请在实验面板选择导出范围。');return;}if(e.permission.value!=='owner'){notice('当前视角无导出权限。',true);return;}try{const message=await root.MemoryPlatform.save(M.encode(ds));notice(message);}catch(err){notice('导出失败，原始数据未修改。',true);}});
 root.MemoryWorkspace={get dataset(){return ds;},get index(){return clock.index;},get selected(){return selected;},get authorized(){return e.permission.value==='owner';},get viewName(){return view;},get filters(){return {category:e.category.value,state:e.state.value,source:e.source.value};},replace(next){importGeneration++;const incremental=!!(experimentMode&&next.data.experiment&&ds.role===next.role&&next.data.frames.length>ds.data.frames.length);experimentMode=true;replaceData(next,null,incremental);clock.jump(next.data.frames.length-1);render(false);},restore(next,index=0,choice=null,filters=null){importGeneration++;experimentMode=false;replaceData(next);clock.jump(index);selected=choice;if(filters)for(const k of ['category','state','source'])e[k].value=filters[k];render(false);},pause,view:setView,notice};
 function tick(now){const dt=Math.min(now-last,1000);last=now;if(!disposed){if(clock.playing&&!empty){if(tourState){tourState.elapsed+=dt;if(tourState.elapsed>=tourState.stops[tourState.index].seconds*1000){tourState.elapsed=0;tourState.index++;if(tourState.index>=tourState.stops.length){tourState.index=tourState.stops.length-1;pause();}else{const stop=tourState.stops[tourState.index];clock.jump(stop.index);setView(stop.view||'evolution');focusChange();e['tour-label'].textContent=`路演 ${tourState.index+1} / ${tourState.stops.length} · ${stop.title}`;}}}else if(clock.tick(dt)){const next=S.select(ds.data,clock.index-1,1,e.source.value);if(next!==clock.index)clock.jump(next);render(true);if(S.select(ds.data,clock.index,1,e.source.value)===clock.index){render(false);pause();}}else if(!clock.playing)pause();}animationFrame=requestAnimationFrame(tick);}}
 const onKey=event=>{if(event.defaultPrevented||event.metaKey||event.ctrlKey||event.altKey)return;
   if(event.key==='Escape'){for(const d of doc.querySelectorAll('.menu[open],.display-options[open],.play-options[open],.timeline-options[open],.graph-key[open]'))d.open=false;stopTour();pause();if((root.innerWidth||1440)<1150){inspectorChoice=false;updateInspector();e['toggle-inspector'].focus?.();}return;}
   if(event.target.closest('button,input,select,textarea,summary,[contenteditable]'))return;
   if(event.code==='Space'){event.preventDefault();e.play.click();}else if(event.key==='ArrowLeft'){event.preventDefault();e.prev.click();}else if(event.key==='ArrowRight'){event.preventDefault();e.next.click();}
 };doc.addEventListener('keydown',onKey);
 const onVisibility=()=>{last=performance.now();if(doc.hidden)pause();};doc.addEventListener('visibilitychange',onVisibility);
 function dispose(){disposed=true;importGeneration++;cancelAnimationFrame(animationFrame);doc.removeEventListener('visibilitychange',onVisibility);doc.removeEventListener('keydown',onKey);root.removeEventListener?.('resize',onResize);graphics?.dispose();}root.addEventListener('pagehide',dispose,{once:true});root.addEventListener('pageshow',event=>{if(event.persisted)root.location?.reload();});
 setView('graph');e.notice.hidden=true;animationFrame=requestAnimationFrame(tick);diagnostic('initialized');
 // 后台/被遮挡窗口可能暂不派发rAF；初始化不依赖动画回调。
 graphics?.drawInitial();
 root.__TAURI__?.core.invoke('frontend_ready',{frames:ds.data.frames.length,graphics:!!graphics,rendered:!!graphics?.renderedFrames}).catch(()=>{});
})(window);
