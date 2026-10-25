/* Windows model experiments with a separate offline simulation. */
(function(root){
'use strict';
async function ruleDraft(text,name,kind){
 if(typeof name!=='string'||!name.trim()||Array.from(name).length>255)throw Error('守则文件名无效或过长');
 if(typeof text!=='string'||!text.trim()||Array.from(text).length>100000)throw Error('守则不能为空或超过十万字');
 const bytes=new TextEncoder().encode(text);
 if(bytes.length>400000)throw Error('守则超过400KB');
 const digest=await root.crypto.subtle.digest('SHA-256',bytes);
 return {text,sha256:Array.from(new Uint8Array(digest),x=>x.toString(16).padStart(2,'0')).join(''),source:{kind,name}};
}
async function scriptDraft(text,name){
 const checked=await ruleDraft(text,name,'script');
 if(checked.sha256!=='6f2bb014c6b614dca33221da0f106cd0bd57d2b82a48309bc72ea88492579f87')throw Error('与已核验的官方对话脚本不一致，未替换当前脚本。请导入原始对话流脚本.md；背景卡不能用作输入。');
 const sections=[...text.matchAll(/^## 第(\d+)轮\s*$/gm)];
 const rows=sections.map((m,i)=>({round:Number(m[1]),input:text.slice(m.index+m[0].length,sections[i+1]?.index??text.length).split(/\n(?:——对话流结束——|## 说明)/)[0].trim()}));
 if(rows.length!==28||rows.some((r,i)=>r.round!==i+1||!r.input))throw Error('脚本轮次缺失或顺序不完整');
 return {sha256:checked.sha256,name,rows};
}
function answerComparison(turns,index){
 const current=turns[index];if(current?.status!=='complete'||!current.admission||!Array.isArray(current.history_rounds))return null;
 const signature=t=>JSON.stringify({memories:(t.admission?.memories||[]).map(m=>m.version_id),history:t.history_rounds||[]});
 for(let i=index-1;i>=0;i--)if(turns[i].status==='complete'&&turns[i].admission&&Array.isArray(turns[i].history_rounds)&&turns[i].input===current.input&&signature(turns[i])!==signature(current))return {round:i+1,turn:turns[i]};
 return null;
}
function extracted(text){
 const value=root.MemoryModel.parseJSON?root.MemoryModel.parseJSON(text):JSON.parse(text);
 if(!value||Object.keys(value).some(k=>!['candidates','assessment'].includes(k))||!Array.isArray(value.candidates)||value.candidates.length>16)throw Error('模型未返回候选JSON数组');
 return value;
}
// One generation owns chat+extraction+save. A cancelled generation never calls finish.
function runner({call,model,cancel,onText}){
 let busy=false,cancelled=false,request=null;
 return {get busy(){return busy;},async stop(){cancelled=true;if(request)await cancel(request);},async send(exp,profile,input,memoryVersions=[],temporary=false,includeHistory=true){
  if(busy)throw Error('已有请求进行中');busy=true;cancelled=false;request=root.crypto.randomUUID();let pending;
  try{
   pending=await call({op:temporary?'temporary':'prepare',allow_transfer:temporary,id:exp.id,revision:exp.revision,input,request_id:request,memory_versions:memoryVersions,include_history:includeHistory,model:{name:profile.name,protocol:profile.protocol,model:profile.model,base_url:profile.base_url}});
   if(cancelled)throw Error('请求已取消');
   const messages=[{role:'user',content:JSON.stringify({governance_config:pending.prompt.rules,memory_context:pending.prompt.allowed})},...pending.prompt.messages];
   const reply=await model(profile.id,request,pending.prompt.system,messages,profile.stream!==false,t=>{if(!cancelled)onText(t);});
   if(cancelled)throw Error('请求已取消');
   if(temporary)return {temporary:true,reply:reply.text,state:pending.state};
   let candidates=[],assessment=null,extractionError=false,extractionUsage=null;
   try{
    const r=await model(profile.id,request,pending.prompt.extraction,[{role:'user',content:JSON.stringify({input,history:pending.prompt.messages.slice(0,-1),history_sources:pending.prompt.history_sources||[],available:pending.prompt.allowed})}],false,()=>{});
    if(cancelled)throw Error('请求已取消');const parsed=extracted(r.text);candidates=await call({op:'validate_candidates',candidates:parsed.candidates,assessment:parsed.assessment});assessment=parsed.assessment??null;extractionUsage=r.usage;
   }catch(error){if(cancelled)throw error;extractionError=true;}
   if(cancelled)throw Error('请求已取消');
   const result=await call({op:'finish',id:exp.id,revision:pending.revision,request_id:request,reply:reply.text,usage:reply.usage,extraction_usage:extractionUsage,candidates,assessment,extraction_error:extractionError});
   return result;
  }catch(error){
   if(pending&&!temporary){try{await call({op:'abort',id:exp.id,revision:pending.revision,request_id:request,status:cancelled?'cancelled':'failed'});}catch{/* Reopen shows the real saved pending state for explicit recovery. */}}
   throw error;
  }finally{busy=false;request=null;}
 }};
}
if(typeof module!=='undefined')module.exports={runner,extracted,ruleDraft,scriptDraft,answerComparison};
if(!root.__TAURI__?.core||!root.document)return;
const doc=root.document,invoke=(c,args={})=>root.__TAURI__.core.invoke(c,args),entry=doc.getElementById('native-open');
entry.hidden=false;
let dialog,ui={},exp=null,profiles=[],profileId=null,frameIndex=0,selected=null,graph=null,running=null,working=false;
let temporaryTimer=null,graphExperiment=null;
let builtin=null,draft=null,preview=null,view='setup',guideStep=0,contextExperiment=null,script=null,archive=null,archivePreview=null,archiveIndex=0,archiveGraphMode=false;
const guide=[
 ['连接模型','保存供应商、API 地址、Key 和模型名称。测试连接由你主动执行，可能计费。','打开模型配置'],
 ['选择守则','已内置完整记忆守则。也可预览、确认自定义版本；已有实验的守则不变。','查看所选守则'],
 ['开始对话','创建实验并发送消息。AI 回复与候选会分别保存，候选须经内核裁决。','准备第一条消息'],
 ['查看结果','在记忆演化中比较前后变化，在三维图谱中查看真实登记的关系。','查看记忆演化']
];
const call=request=>invoke('experiment_call',{request,...(['prepare','temporary'].includes(request.op)?{profileId}: {})});
const button=(text,action)=>{const b=doc.createElement('button');b.textContent=text;b.type='button';b.setAttribute('data-idle','');b.onclick=()=>guard(action);return b;};
const text=(tag,value)=>{const el=doc.createElement(tag);el.textContent=value??'未记录';return el;};
const notice=message=>{ui.status.textContent=message;};
function clearPreview(){if(temporaryTimer)root.clearTimeout(temporaryTimer);temporaryTimer=null;ui.live.replaceChildren();ui.live.hidden=true;}
function contextSummary(){
 const count=ui.context.selectedOptions.length,turn=exp?.turns[frameIndex];
 const actual=turn?.admission?`本轮${turn.status==='complete'?'请求附带':'准备'} ${turn.admission.memories.length} 条记忆${turn.status==='complete'?'':'（发送完成未确认）'}；`:'';
 ui.contextSummary.textContent=actual+(count?`下次选择 ${count} 条，发送前重新校验。`:'下次发送不附带长期记忆。')+(ui.history.checked?'聊天按治理边界裁剪。':'不附带历史聊天。');
}
async function guard(action){
 if(working)return;
 working=true;busy(true);
 try{await action();}catch(e){notice(String(e));}finally{working=false;busy(false);}
}
function busy(value){
 dialog.classList.toggle('is-busy',value);ui.workspace.setAttribute('aria-busy',String(value));
 for(const el of dialog.querySelectorAll('[data-idle]'))el.disabled=value;
 for(const name of ['rename','remove','reset','export'])ui[name].disabled=value||!exp;
 ui.new.disabled=value||!draft;ui.rulesDefault.disabled=value||!builtin;ui.rulesAccept.disabled=value||!preview;
 ui.send.disabled=value||!exp||!!exp.pending;
 ui.cancel.disabled=!running?.busy;
 ui.fit.disabled=value||!graph||graph.destroyed;archiveControls(value);if(script)renderScript();
}
function model(id,requestId,system,messages,stream,onText){const channel=new root.__TAURI__.core.Channel();channel.onmessage=onText;return invoke('model_request',{id,requestId,system,messages,stream,onDelta:channel});}
async function libraries(){
 const rows=await call({op:'list'});ui.experiments.replaceChildren(new Option('选择已保存实验',''),...rows.map(x=>new Option(x.name,x.id)));ui.experiments.value=exp?.id||'';
 profiles=await call({op:'profiles'});ui.models.replaceChildren(new Option('选择模型配置',''),...profiles.map(x=>new Option(x.name+' · '+x.model,x.id)));ui.models.value=profileId&&profiles.some(p=>p.id===profileId)?profileId:'';updateSetup();
}
async function open(id){if(!id)return;const loaded=await call({op:'open',id});clearPreview();exp=loaded;contextExperiment=null;frameIndex=Math.max(0,exp.frames.length-1);selected=null;ui.renameName.value=exp.name;ui.records.open=false;setView(view==='setup'?'chat':view);notice('已打开本机实验，继续使用创建时保存的守则。');}
function updateSetup(){const p=profiles.find(x=>x.id===profileId);ui.modelSummary.textContent=p?'下一请求：'+p.name+' · '+p.model:'尚未选择模型，请在“开始实验”中配置或选择。';ui.createSummary.textContent=(p?'模型：'+p.name+' · '+p.model:'尚未选择模型')+' · 守则：'+(draft?sourceName(draft):'未加载');}
function sourceName(policy){return policy.source?`${policy.source.kind==='builtin'?'应用内置':'自定义'} · ${policy.source.name}`:'来源未记录';}
function useRules(policy){draft=policy;preview=null;ui.rules.value=policy.text;ui.rulesPreview.hidden=true;ui.rulesSelected.textContent=sourceName(policy)+' · SHA-256 '+policy.sha256;updateSetup();}
async function previewRules(value,name){preview=null;ui.rulesPreview.hidden=true;const checked=await ruleDraft(value,name,'custom');preview=checked;ui.rulesPreviewText.textContent=checked.text;ui.rulesPreviewHash.textContent=sourceName(checked)+' · SHA-256 '+checked.sha256;ui.rulesPreview.hidden=false;}
function setView(next){
 view=next;ui.setup.hidden=view!=='setup';ui.archivePanel.hidden=view!=='archive';ui.workspace.hidden=['setup','archive'].includes(view);ui.footer.hidden=['setup','archive'].includes(view);
 for(const name of ['graphType','graphRole','graphEvent'])ui[name].hidden=view!=='graph';ui.graph.hidden=view!=='graph';ui.relation.hidden=view!=='graph';ui.graphHelp.hidden=view!=='graph';ui.conversation.hidden=view==='graph';ui.filter.hidden=view!=='graph';ui.fit.hidden=view!=='graph';ui.graphNote.hidden=view!=='graph';ui.composer.hidden=!['chat','answer'].includes(view);ui.sendOptions.hidden=ui.composer.hidden;ui.queryOptions.hidden=ui.composer.hidden;
 for(const [name,mode]of [['startView','setup'],['archiveView','archive'],['chatView','chat'],['evolutionView','evolution'],['graphView','graph'],['answerView','answer']])ui[name].setAttribute('aria-pressed',String(mode===view));
 render();if(view==='archive')renderArchive();graph?.setPaused(view!=='graph');
}
function showGuide(step=0){guideStep=step;ui.guide.hidden=false;const [title,description,action]=guide[guideStep];ui.guideTitle.textContent=title;ui.guideDescription.textContent=description;ui.guideAction.textContent=action;ui.guideProgress.textContent=`${guideStep+1} / ${guide.length}`;ui.guideNext.textContent=guideStep===guide.length-1?'完成':'下一步';}
function dismissGuide(){ui.guide.hidden=true;try{root.localStorage?.setItem('memory-lab.desktop-guide-seen','1');}catch{/* Optional help preference only; experiments stay in SQLite. */}}

async function recoverSaved(id,error){
 try{exp=await call({op:'open',id});frameIndex=Math.max(0,exp.frames.length-1);render();}
 catch(recovery){exp=null;selected=null;graph?.dispose();graph=null;graphExperiment=null;render();throw Error(`${error}；保存状态无法核对：${recovery}。请重新打开实验。`);}
 throw error;
}
async function mutate(op,extra={}){if(!exp)throw Error('请先新建实验');const id=exp.id;try{exp=await call({op,id,revision:exp.revision,...extra});}catch(error){await recoverSaved(id,error);}frameIndex=Math.max(0,exp.frames.length-1);render();if(op==='rename'){ui.renameName.value=exp.name;await libraries();}else{const last=exp.turns.at(-1),left=last?.candidates.filter((_,i)=>!Object.hasOwn(last.results,String(i))).length||0;notice(left?`已保存，尚有 ${left} 项模型建议待处理。`:'本轮操作已保存，可继续对话。');}}
function render(){
 if(view==='graph'&&archiveGraphMode&&archive){renderArchiveGraph();return;}
 ui.memoryHeading.textContent='处理后的记忆';ui.memoryFile.hidden=false;const hasReplay=!!exp?.turns.some(t=>t.replay_source?.message_id);ui.graphType.hidden=ui.graphRole.hidden=ui.graphEvent.hidden=view!=='graph'||!hasReplay;
 const sameContext=contextExperiment===exp?.id;
 const chosen=new Set(sameContext?Array.from(ui.context.selectedOptions,o=>o.value):[]);
 contextExperiment=exp?.id??null;
 const choices=(exp?.governance.versions||[]).filter(r=>r.payload&&!r.payload.retention&&['current','completed'].includes(r.lifecycle)&&exp.snapshot[r.part]?.[r.key]?.version===r.revision);
 choices.sort((a,b)=>Number(b.part==='current'&&b.payload.kind==='task')-Number(a.part==='current'&&a.payload.kind==='task'));
 if(!sameContext){ui.contextKeep.checked=false;ui.history.checked=true;}
 ui.context.replaceChildren(...choices.map(r=>{const o=new Option(`${r.part==='current'&&r.payload.kind==='task'?'待办 · ':''}${root.MemoryModel.label(r.key)}：${r.payload.value} · ${root.MemoryModel.states[r.part]?.name||r.part}`,r.version_id);o.selected=chosen.has(r.version_id);return o;}));
 contextSummary();
 ui.contextPanel.hidden=!choices.length;
 ui.title.textContent=view==='setup'?'开始实验':exp?.name||'尚未创建实验';
 ui.currentRules.hidden=!exp;ui.policyView.hidden=!exp;
 if(exp){ui.currentRulesText.textContent=exp.rules.text;ui.currentRulesHash.textContent=sourceName(exp.rules)+' · SHA-256 '+exp.rules.sha256;}
 if(!exp){
  graph?.setData({nodes:[],edges:[],count:0},'LOCAL',{animate:false});graph?.select(null);
  ui.renameName.value='';ui.currentRulesText.textContent='';ui.currentRulesHash.textContent='';ui.policy.textContent='';ui.policy.title='';ui.recover.hidden=true;
  ui.position.max='0';ui.position.value='0';ui.round.textContent='尚无对话';ui.send.disabled=true;
  ui.memories.replaceChildren();ui.details.replaceChildren();ui.memoryPrivacy.textContent='';ui.memoryText.textContent='';ui.memoryPath.textContent='';ui.memoryDigest.textContent='';ui.memoryVerification.textContent='';clearPreview();
  renderScript();ui.conversation.replaceChildren(text('h2','开始实验'),text('p','先在“开始实验”中选择模型与守则，再创建实验。无需 API 的体验可选择“离线示例”。'));
  busy(working);return;
 }
 ui.policy.textContent='本机自动保存 · '+sourceName(exp.rules)+' · '+exp.rules.sha256.slice(0,12);ui.policy.title='MODEL_EXPERIMENT · Python 治理内核 · SHA-256 '+exp.rules.sha256;
 ui.recover.hidden=!exp.pending;ui.send.disabled=!!exp.pending;
 ui.position.max=String(Math.max(0,exp.frames.length-1));ui.position.value=String(frameIndex);ui.round.textContent=exp.frames.length?`第 ${frameIndex+1} 轮 · 已保存 ${exp.frames.length} 轮`:'尚无对话';
 ui.memoryPrivacy.textContent=Object.values(exp.snapshot.current).some(p=>p.retention)?'敏感个人信息已核验保存至 '+(exp.memory_file?.path||'未记录位置')+'。本机有权限者可读取，请谨慎共享；不会自动发送模型。':'';
 ui.memoryPath.textContent=exp.memory_file?.path||'文件尚未核验';ui.memoryDigest.textContent=exp.memory_file?.sha256||'';ui.memoryText.textContent='';
 const savedDigest=exp.frames[frameIndex]?.markdown_sha256;ui.memoryVerification.textContent=savedDigest?(frameIndex===exp.frames.length-1&&savedDigest===exp.memory_file?.sha256?'本轮 Markdown 已读回核验':'历史轮次已登记 Markdown 摘要；当前文件为最新状态'):'本轮 Markdown 核验未记录';
 renderScript();
 ui.conversation.replaceChildren();const turn=exp.turns[frameIndex],frame=exp.frames[frameIndex];
 if(exp.pending)ui.conversation.append(text('h2','尚未结束的请求'),text('p',exp.pending.input),text('small','输入已保存，完整回复尚未提交。确认其他窗口没有处理此请求后，可结束请求并恢复。'));
 if(turn){ui.conversation.append(text('small',`实验第 ${frameIndex+1} 轮 · 角色 ${exp.role} · ${turn.processing|| (turn.status==='local'?'LOCAL_OPERATION':'MODEL_EXPERIMENT')}`));ui.conversation.append(text('h2',view==='evolution'?'本轮输入':'本轮对话'),text('small','你'),text('p',turn.input));
 const reply=[text('small',turn.status==='local'?'本地操作 · 未调用模型':'AI 回复 · '+(turn.status==='complete'?'已收到':({cancelled:'已取消',failed:'请求失败',interrupted:'上次中断'})[turn.status]||'未记录')),text('p',turn.status==='local'?'本轮由本地内核处理，没有请求模型。':turn.reply||'本轮未保存完整回复，未提交记忆')];
 if(view==='evolution'){const d=doc.createElement('details');d.append(text('summary','查看本轮 AI 回复'),...reply);ui.conversation.append(d);}else ui.conversation.append(...reply);
 if(frame&&(view==='evolution'||turn.status==='local')){ui.conversation.append(text('h2','本轮实际变化'));if(!['added','changed','removed'].some(k=>frame.diff[k].length))ui.conversation.append(text('p','本轮记忆快照没有变化，原因以实际裁决记录为准。'));for(const d of frame.decisions)ui.conversation.append(text('p',operationName(d.action)+'：'+d.reason));for(const kind of ['added','changed','removed'])for(const path of frame.diff[kind]){const [part,key]=path.split('.');const old=frame.before[part]?.[key]?.value,next=frame.after[part]?.[key]?.value;ui.conversation.append(text('p',`${root.MemoryModel.label(key)}：${old??'未记录 / 已清除'} → ${next??'退出 / 已清除'}`));}}
 const usage=doc.createElement('details');usage.append(text('summary','模型与用量'),text('p',turn.model?.model?'本轮模型：'+(turn.model.name||'未记录')+' · '+turn.model.model:'本轮模型未记录'),text('small',turn.usage?'回复 Token：'+JSON.stringify(turn.usage):'回复 Token 用量未知'));
 const admission=turn.admission;
 const context=doc.createElement('details');context.open=view==='answer';context.append(text('summary','本次请求的上下文与回答依据'));
 if(admission){
  context.append(text('p',`${admission.memories.length} 条记忆实际附带；这是发送记录，不证明模型在回答中采用了每一条。`));
  for(const m of admission.memories)context.append(text('p',`${root.MemoryModel.label(m.key)}：${m.payload?.value??'原值已清除'} · ${m.version_id}`));
  const reasons={future:'尚未生效',expired:'已失效',contradiction:'存在未解冲突',lineage:'根依据不可用',permission:'用途或权限不允许',privacy:'隐私限制',not_selected:'用户未选入本次请求',context_budget:'上下文预算不足',user_excluded:'用户关闭聊天上下文',governance_reset:'治理变更后停止续用',incomplete:'该轮未完成'};
  for(const d of admission.denied||[])context.append(text('p','内核排除：'+(reasons[d.reason]||d.reason)));
  for(const d of [...(admission.unselected||[]),...(admission.omitted||[])])context.append(text('p',`${d.version_id}：${reasons[d.reason]||d.reason}`));
 }else context.append(text('p','本轮准入未记录，不能补推发送内容。'));
 context.append(text('p','实际附带聊天轮次：'+(turn.history_rounds?.join('、')??'未记录')));
 for(const n of turn.history_rounds||[]){const t=exp.turns[n-1],d=doc.createElement('details');d.append(text('summary',`聊天第 ${n} 轮`),text('p',t?.input),text('p',t?.reply));context.append(d);}
 if(turn.history_rounds?.length===0)context.append(text('p','未附带历史聊天。'));
 for(const d of turn.history_omitted||[])context.append(text('small',`第 ${d.round} 轮未发送：${({user_excluded:'用户关闭聊天上下文',governance_reset:'治理变更后停止续用',incomplete:'该轮未完成',context_budget:'上下文预算不足'})[d.reason]||d.reason}；`));
 context.append(text('small','准入会重新检查当前状态；待核实、历史及已删除内容不作为当前事实。守则全文见“查看实验守则”。'));if(view==='answer')ui.conversation.append(context);
 if(view==='answer'){
  const previous=answerComparison(exp.turns,frameIndex);
  if(previous){const d=doc.createElement('details');d.open=true;d.append(text('summary',`同一问题的先前回答 · 第 ${previous.round} 轮`),text('p',previous.turn.reply),text('small',`当时附带 ${previous.turn.admission?.memories.length??'未记录'} 条记忆、${previous.turn.history_rounds?.length??'未记录'} 轮聊天。两次上下文不同；模型、随机性或时间也可能影响结果，不预判优劣。`));ui.conversation.append(d);}
  else ui.conversation.append(text('p','尚无同一问题、不同上下文的已保存回答。可主动发送无记忆无历史的对照，再选择获准记忆发送同一问题；不会自动请求模型。'));
 }

 if(!turn.assessment)usage.append(text('small','风险观察未记录，不代表已确认安全。'));
 if(turn.extraction_error)ui.conversation.append(text('p','候选提取失败；回复已保存，没有提交记忆。'));
 if(turn.assessment){const a=turn.assessment,d=doc.createElement('details');d.open=a.signals.length>0;d.append(text('summary','模型风险观察 · 未经独立核实'));if(a.signals.length)d.append(text('p',a.signals.join('、')));d.append(text('p',a.reason),text('p',a.next_step));ui.conversation.append(d);}
 if(turn.status!=='local'){
 const decided=Object.keys(turn.results).length,remaining=turn.candidates.length-decided;
 ui.conversation.append(text('h2','模型建议与治理结果'),text('p',`模型建议 ${turn.candidates.length} 项 · 已记录裁决 ${decided} 项 · 待处理 ${remaining} 项`));
 if(!turn.candidates.length)ui.conversation.append(text('p','本轮没有记忆候选，模型回复没有自动写入记忆。'));
 for(const [index,c]of turn.candidates.entries()){
  const row=doc.createElement('section');row.className='native-candidate';row.append(text('strong',`${root.MemoryModel.label(c.key)} · ${c.reactivate?'建议重新建立':c.current_correction?'建议更正':operationName(c.op)}`),text('p',c.erased?'原值已清除':c.value||'不携带新值'));
  const proof=c.evidence,checked=turn.evidence_checks?.[String(index)];
  row.append(text('small','模型分类：'+(({self_report:'本人陈述',external:'外部主张',inference:'模型推断'})[c.basis]||'未记录')));
  if(proof&&typeof proof.quote==='string'){
   row.append(text('small',({current_input:'本轮用户输入',history_user:`第 ${proof.round} 轮用户输入`,memory:`获准记忆 ${proof.version_id}`})[proof.source]||'来源未核实'),text('blockquote',proof.quote));
  }
  if(checked)row.append(text('small',checked.reason));
  row.append(text('small','所属角色：'+exp.role));const ruleLink=button('查看本实验治理守则',()=>{setView('setup');ui.rulesPanel.open=true;ui.currentRules.open=true;ui.currentRules.scrollIntoView?.({block:'nearest'});});row.append(ruleLink);
  const conditions=doc.createElement('details');conditions.append(text('summary','建议的完整条件'),text('pre',JSON.stringify(c,null,2)));row.append(conditions);
  const result=turn.results[String(index)];if(result){if(result.admission?.startsWith('auto_'))row.append(text('small',({auto_save:'内核自动保存 · 已随本轮保存',auto_update:'内核自动更新 · 已随本轮保存',auto_merge:'同值合并 · 没有新增版本'})[result.admission]));for(const d of result.decisions)row.append(text('p',operationName(d.action)+'：'+d.reason));}
  else if(frameIndex===exp.turns.length-1){
   if(!['self_report','external','inference'].includes(c.basis)||!proof||checked?.status!=='verified'){
    row.append(text('p','此建议缺少可核验的来源记录，不能直接裁决。请忽略后明确重新提出。'),button('忽略',()=>mutate('dismiss',{index})));
   }else if(['external','inference'].includes(c.basis)&&!(c.op==='derive'&&c.basis==='inference'&&!c.current_correction&&!c.reactivate&&c.state!=='completed')){
    row.append(text('p','外部主张或推断不能充当操作授权，也不因重复或确认按钮变成已核实事实。'),button(c.op==='set'&&!c.current_correction&&!c.reactivate&&c.state!=='completed'?'保留为待核实线索':'核验操作依据',()=>mutate('decide',{index,confirm:false})),button('忽略',()=>mutate('dismiss',{index})));
   }else{
   if(c.op==='set'&&!c.current_correction&&!c.reactivate&&c.state!=='completed')row.append(button('仅存入待核实区',()=>mutate('decide',{index,confirm:false})));
   row.append(button(c.basis==='self_report'?'确认这是本人直接陈述或本人意图':'确认派生并交由内核裁决',async()=>{
    const prompt=c.basis==='self_report'
     ?`请核对上方候选及原文：${proof.quote}。仅当这是你本人直接陈述或本人当前意图才确认；引用、转述、第三方主张和模型推断不能冒充本人陈述。此确认不证明外部事实真实。${c.op==='delete'?'将删除本实验内该记忆及受影响派生，原对话和既有导出不受影响。':c.reactivate?'重新建立须有独立于已删材料的新依据。':''}仍须通过内核权限、时间与冲突检查。确认？`
     :'仅使用本轮获准的根依据派生，继承其限制，不新增来源权威。确认？';
    if(root.confirm(prompt))await mutate('decide',{index,confirm:true,...(c.basis==='self_report'?{source_confirmation:{round:frameIndex+1,index,evidence:proof,candidate:c}}:{})});
   }),button('忽略',()=>mutate('dismiss',{index})));

   }
  }ui.conversation.append(row);
 }
 }
 if(view!=='answer')ui.conversation.append(context);ui.conversation.append(usage);
 }
 const snapshot=frame?.after||exp.snapshot,graphModel=currentModel(),nodes=new Map((graphModel?.nodes||[]).map(n=>[n.id,n]));ui.memories.replaceChildren();
 const listed=view==='graph'?(graphModel?.nodes||[]):Object.entries(snapshot).flatMap(([part,group])=>Object.entries(group).map(([key,p])=>nodes.get(`${exp.role}/${part}/${key}/${p.version}`)).filter(Boolean));
 for(const n of listed){const b=button(`${n.label}：${n.payload?.value??'原值已清除'} · ${root.MemoryModel.states[n.state]?.name||n.state}`,()=>selectNode(n));b.value=n.id;b.setAttribute('aria-pressed',String(n.id===selected));ui.memories.append(b);}
 if(!ui.memories.children.length)ui.memories.append(text('p','本轮没有已保存记忆。模型回复不代表写入成功。'));
 if(selected){const n=nodes.get(selected);if(n)details(n.key,n.payload||{value:'原值已清除',source:'未记录'},n);else{selected=null;ui.details.textContent='所选记忆已退出当前快照或筛选范围。';}}
 else ui.details.replaceChildren();
 if(!exp.frames.length&&ui.graph.hidden)graph?.setData({nodes:[],edges:[],count:0},exp.role,{animate:false});
 graphData(graphModel);busy(working);
}
function clearScript(){script=null;if(ui.scriptPanel){ui.scriptPanel.hidden=true;ui.scriptPreview.textContent='';ui.scriptHash.textContent='';ui.scriptState.textContent='';ui.scriptRound.replaceChildren();ui.scriptGrid.replaceChildren();}}
function clearArchive(){archive=null;archivePreview=null;archiveGraphMode=false;archiveIndex=0;invoke('forget_chat_archive').catch(()=>notice('浏览内容已清空，但原生来源句柄清理失败；请重开应用。'));if(ui.archiveList){ui.archiveList.replaceChildren();ui.archiveDetail.replaceChildren();ui.archiveMeta.textContent='尚未导入本机会话。';}}
function archiveMatch(message){
 const query=ui.archiveSearch.value.toLocaleLowerCase(),role=ui.archiveRole.value||'all';
 return (!query||[message.id,message.text].some(v=>v?.toLocaleLowerCase().includes(query)))&&
  (role==='all'||message.role===role||role==='tool'&&message.parts?.tool||role==='empty'&&!message.text);
}
function archiveIndexes(){return (archivePreview||archive)?.batches.flatMap((b,i)=>[b.user,...b.assistant].some(archiveMatch)?[i]:[])||[];}
function archiveControls(value=working){
 const indexes=archiveIndexes(),at=indexes.indexOf(archiveIndex);
 ui.archiveReplay.disabled=value||!archive||!!archivePreview||!exp||!!exp.pending;
 ui.archiveReplay.title=exp?'在独立实验中重新执行本地治理，不调用模型':'请先创建或打开本地角色实验';
 ui.archiveGraph.disabled=value||!archive||!!archivePreview;
 ui.archivePrevious.disabled=value||at<=0;ui.archiveNext.disabled=value||at<0||at===indexes.length-1;
 ui.archiveClear.disabled=value||!archive&&!archivePreview;
}
function archiveStep(direction){const indexes=archiveIndexes(),at=indexes.indexOf(archiveIndex);if(at>=0)archiveIndex=indexes[Math.max(0,Math.min(indexes.length-1,at+direction))];renderArchive();}
function renderArchive(){
 if(!ui.archivePanel)return;
 ui.title.textContent='会话原始记录';ui.policy.textContent='本机只读 · 不保存、不发送模型';
 ui.archiveList.replaceChildren();ui.archiveDetail.replaceChildren();
 const shown=archivePreview||archive;
 ui.archiveAccept.hidden=ui.archiveReject.hidden=!archivePreview;
 archiveControls();
 if(!shown){ui.archiveMeta.textContent='选择本机 ZIP，预览后确认导入。';ui.archiveDetail.append(text('p','原始记录不会自动进入长期记忆。'));return;}
 const {counts}=shown;
 ui.archiveMeta.textContent=`${archivePreview?'待确认 · ':''}${shown.name} · ${counts.sessions||1} 个会话 · ${counts.messages} 条原始消息 · ${counts.user} 条用户消息 / ${counts.assistant} 条助手消息 · ${counts.assistant_with_text} 条助手有文字 · 可展示 ${counts.visible_text_chars??'未记录'} 字 · 工具 ${counts.tool||0} / 内部 ${counts.reasoning||0} / 异常 ${counts.anomalies||0}`;
 const indexes=archiveIndexes();if(indexes.length&&!indexes.includes(archiveIndex))archiveIndex=indexes[0];archiveControls();
 for(const [i,batch]of shown.batches.entries()){
  if(!indexes.includes(i))continue;
  const control=button(`批次 ${batch.number} · ${batch.assistant.length} 条助手记录`,()=>{archiveIndex=i;renderArchive();});
  control.setAttribute('aria-pressed',String(i===archiveIndex));ui.archiveList.append(control);
 }
 if(!indexes.length){ui.archiveDetail.append(text('p','没有匹配的消息。'));return;}
 const batch=shown.batches[archiveIndex];
 ui.archiveDetail.append(text('h2',`批次 ${batch.number} / ${counts.batches}`));
 for(const message of [batch.user,...batch.assistant].filter(archiveMatch)){
  const item=doc.createElement('section');item.className='native-archive-message';
  item.append(text('small',`${message.role==='user'?'用户原始输入':'助手记录'} · ${message.time}`),text('p',message.text||'本条没有可展示文字；未补造回答。'));
  const metadata=doc.createElement('details');metadata.append(text('summary','原始来源与片段'),text('pre',JSON.stringify({id:message.id,parent:message.parent_id,sequence:message.sequence,parts:message.parts},null,2)));
  item.append(metadata);if(message.masked)item.append(text('small','高敏内容已遮蔽；原始 ZIP 未修改。'));
  if(message.parts?.tool||message.parts?.reasoning)item.append(text('small',`工具 ${message.parts.tool||0} / 内部 ${message.parts.reasoning||0}；仅记录类型数量，正文未导入。`));
  // Keep the user paragraph directly discoverable as before; metadata remains on demand.
  if(message===batch.user)ui.archiveDetail.append(...item.children);else ui.archiveDetail.append(item);
 }
 if(shown.anomalies?.length){const issues=doc.createElement('details');issues.append(text('summary','解析异常 '+shown.anomalies.length),text('pre',JSON.stringify(shown.anomalies,null,2)));ui.archiveDetail.append(issues);}
 const provenance=doc.createElement('details');provenance.append(text('summary','归档来源'),text('p',shown.sha256),text('p','会话 '+(shown.session_id||'未记录')+'；不据此授予角色权限。'));ui.archiveDetail.append(provenance);
}
function renderArchiveGraph(){
 ui.memoryHeading.textContent='原始消息';ui.filter.hidden=ui.graphType.hidden=ui.graphEvent.hidden=true;ui.title.textContent='原始消息关系';ui.policy.textContent='只读历史记录 · 非记忆快照';ui.currentRules.hidden=true;ui.policyView.hidden=true;
 ui.round.textContent=`原始批次 ${archiveIndex+1} / ${archive.batches.length}`;ui.position.max=String(archive.batches.length-1);ui.position.value=String(archiveIndex);
 const m=currentModel();ui.memories.replaceChildren();for(const n of m.nodes){const b=button(n.label,()=>selectNode(n));b.value=n.id;ui.memories.append(b);}
 ui.details.replaceChildren();if(selected){const n=m.nodes.find(n=>n.id===selected);if(n)details(n.key,n.payload,n);else selected=null;}
 ui.memoryPrivacy.textContent='高敏值默认遮蔽；原始 ZIP 仍保留原内容。';ui.memoryFile.hidden=true;graphData(m);
}
function jumpToOrigin(origin){
 if(!archive||archive.sha256!==origin.sha256||archive.session_id!==origin.session_id){notice('请重新导入相同 SHA-256 的 ZIP 后查看原始消息；不会补造来源正文。');return;}
 archiveGraphMode=false;archiveIndex=origin.batch-1;ui.archiveSearch.value='';ui.archiveRole.value='all';setView('archive');
}
function renderScript(){
 ui.scriptPanel.hidden=!script;if(!script)return;
 const row=script.rows[Number(ui.scriptRound.value)||0];
 ui.scriptGrid.replaceChildren(...script.rows.map((r,i)=>{const matches=exp?.turns.some(t=>t.input===r.input);const b=button(String(r.round),()=>{ui.scriptRound.value=String(i);renderScript();});b.setAttribute('aria-label',`第 ${r.round} 轮 · ${matches?'已有相同输入记录':'未记录执行'}`);b.setAttribute('aria-pressed',String(r===row));b.title=`第 ${r.round} 轮 · ${matches?'已有相同输入记录':'未记录执行'}`;return b;}));
 const recorded=script.rows.filter(r=>exp?.turns.some(t=>t.input===r.input)).length;
 ui.scriptHash.textContent=`官方脚本第 ${row.round} / 28 轮 · 本实验已有相同输入 ${recorded} / 28（不代表已裁决） · 原件 SHA-256 `+script.sha256+'；仅驻留当前窗口，不导入背景卡或日志。';
 const restricted=root.MemoryModel.isSensitive(row.input)||root.MemoryModel.personalKind(row.input);
 ui.scriptPreview.textContent=restricted?'本轮包含个人信息或禁存格式，原值不进入预览、输入框或实验记录。请自行最小化后按现有授权流程实验；内置示例不代表此原件已处理。':row.input;
 const matches=exp?.turns.map((t,i)=>t.input===row.input?i+1:null).filter(Boolean)||[];
 ui.scriptState.textContent=!exp?'先创建实验，再逐条放入输入框。':matches.length?'本实验已有相同原文输入：第 '+matches.join('、')+' 轮。请查看各轮实际候选和裁决，不以匹配证明处理正确。':'本实验未记录此轮原文输入。脚本中的人物或系统标签不授予应用权限。';
 ui.scriptUse.disabled=working||!exp||!!restricted;
}
function operationName(value){return ({set:'建议保存',derive:'建议派生',retire:'建议失效',delete:'建议删除',review:'建议复核',ADD:'新增',UPDATE:'更正',MERGE:'合并',REJECT:'拒绝',NO_CHANGE:'无写入',RETIRE:'退出当前状态',DELETE:'删除',PENDING:'隔离待核实'})[value]||value;}
function currentModel(){if(view==='graph'&&archiveGraphMode&&archive){const m=root.MemoryModel.archiveGraph(archive,archiveIndex,{messageRole:ui.graphRole.value||'all'});if(ui.relation.value&&ui.relation.value!=='all')m.edges=m.edges.filter(e=>e.type===ui.relation.value);return m;}if(!exp?.frames.length)return null;const options={state:view==='graph'?(ui.filter.value||'all'):'all',includeVersions:view==='graph',nodeType:ui.graphType.value||'all',messageRole:ui.graphRole.value||'all',event:ui.graphEvent.value||'all'};const m=view==='graph'&&exp.turns.some(t=>t.replay_source?.message_id)?root.MemoryModel.reexecutionGraph(exp,frameIndex,options):root.MemoryModel.graph({role:exp.role,data:{frames:exp.frames}},frameIndex,options);if(view==='graph'&&ui.relation.value&&ui.relation.value!=='all')m.edges=m.edges.filter(e=>e.type===ui.relation.value);return m;}
function selectNode(n){selected=n.id;details(n.key,n.payload||{value:'原值已清除',source:'未记录'},n);graph?.select(n.id);if(view==='graph')graph?.focus(n.id);for(const b of ui.memories.children)b.setAttribute('aria-pressed',String(b.value===n.id));}
const relationName=value=>({SUPERSEDE:'更正',DERIVE:'派生',CONTRADICT:'冲突',SOURCE:'来源消息',PARENT:'父消息',GOVERNANCE:'本轮治理',AFFECTS:'操作目标'})[value]||value;
function details(key,p,node){
 if(node?.nodeType&&node.nodeType!=='memory'){ui.details.replaceChildren(text('h2',node.label),text('p',p.value),text('pre',JSON.stringify(node.audit||node.message||{},null,2)));if(node.frameDecisions)ui.details.append(text('small','同轮裁决记录；未推断单条审计事件的原因'),text('pre',JSON.stringify(node.frameDecisions,null,2)));if(node.origin)ui.details.append(button('定位原始消息',()=>jumpToOrigin(node.origin)));return;}
 const base=key.replace(/__previous$/,''),f=exp.frames[frameIndex];
 const versions=f?.governance.versions.filter(r=>r.key===base)||[];
 ui.details.replaceChildren(text('h2',root.MemoryModel.label(key)),text('p',p.value),text('p','来源：'+(root.MemoryModel.sourceNames[p.source]||p.source||'未记录')));
 const advanced=doc.createElement('details');advanced.append(text('summary','来源、版本与派生记录'),text('pre',JSON.stringify(versions,null,2)));
 for(const r of versions){const at=exp.frames.findIndex(f=>f.governance.versions.some(v=>v.version_id===r.version_id));if(at>=0)advanced.append(button('查看版本首次登记轮次 '+(at+1),()=>{frameIndex=at;render();}));}
 ui.details.append(advanced);
 const record=node?.evidence||versions.find(r=>r.revision===p.version),relations=new Map();
 if(record){
  ui.details.append(text('h2','关系'));
  for(const r of versions)for(const rel of r.relations)if(rel.parent===record.version_id||rel.child===record.version_id)relations.set(JSON.stringify(rel),rel);
  for(const rel of record.relations||[])relations.set(JSON.stringify(rel),rel);
  const all=f.governance.versions;
  for(const rel of relations.values()){
   const other=all.find(r=>r.version_id===(rel.parent===record.version_id?rel.child:rel.parent));
   if(!other)continue;
   const title=`${rel.parent===record.version_id?'→':'←'} ${relationName(rel.relation)} · ${root.MemoryModel.label(other.key)} · v${other.revision}${rel.unresolved?' · 未解决':''}`;
   ui.details.append(button(title,()=>{setView('graph');ui.filter.value='all';ui.relation.value='all';render();const target=currentModel()?.nodes.find(n=>n.evidence?.version_id===other.version_id);if(target)selectNode(target);}));
  }
  if(!relations.size)ui.details.append(text('p','未登记版本间关系。'));
  const sources=record.source||[];
  for(const source of sources){const origin=exp.turns[source.source_turn-1]?.replay_source;if(origin?.message_id)ui.details.append(button('定位来源批次 '+origin.batch,()=>jumpToOrigin(origin)));ui.details.append(text('small',`来源：${source.source_kind} · ${source.source_turn===null?'轮次未记录':'第 '+source.source_turn+' 轮'}`));}
 }
 const current=exp.snapshot.current?.[base];
 if(p.retention){ui.details.append(text('p','本地保存用途：'+p.retention.purpose+'。不附带到模型或用作派生依据。'));if(frameIndex===exp.frames.length-1&&current?.version===p.version)ui.details.append(button('删除这条私人记忆',async()=>{await mutate('privacy_delete',{key:base,version:p.version,confirmed:true});}));return;}
 const version=versions.find(r=>r.part==='current'&&r.revision===p.version&&r.lifecycle==='current');
 if(frameIndex!==exp.frames.length-1||!current||current.version!==p.version||!version)return;
 ui.details.append(button('更正记忆',()=>{setView('chat');ui.input.value='请更正我在本实验保存的「'+root.MemoryModel.label(base)+'」：';ui.input.focus();}),
   button('删除记忆',async()=>{await mutate('memory_delete',{key:base,version_id:version.version_id,confirmed:true});}));
}
function graphData(m=currentModel()){if(ui.graph.hidden||graph?.destroyed)return;if(!m){graph?.setData({nodes:[],edges:[],count:0},exp?.role||'LOCAL',{animate:false});graph?.select(null);ui.graphNote.textContent='尚无治理记录，二维记忆列表仍可使用。';return;}if(!graph){try{graph=new root.MemoryGraph.GraphView(ui.graph,{states:root.MemoryModel.states,onSelect:id=>{const n=currentModel()?.nodes.find(n=>n.id===id);if(n){selectNode(n);}},onUnavailable:m=>{ui.graphNote.textContent=m;ui.fit.disabled=true;}});graph.configure({motion:!root.matchMedia('(prefers-reduced-motion: reduce)').matches,low:false});}catch{ui.graphNote.textContent='WebGL不可用，请使用记忆列表和时间轴。';return;}}
 const catalogKey=archiveGraphMode?'archive:'+archive.sha256:exp.id+':'+exp.revision;
 if(graphExperiment!==catalogKey){graph.setCatalog(m.nodes);graphExperiment=catalogKey;}
 ui.graphNote.textContent=m.nodes.length?'':'本轮没有符合筛选条件的记忆。';graph.setData(m,archiveGraphMode?'ARCHIVE':exp.role,{animate:false});graph.select(m.nodes.some(n=>n.id===selected)?selected:null);graph.resizeToHost();graph.request();}
function createDialog(){
 dialog=doc.createElement('dialog');dialog.className='native-lab';dialog.setAttribute('aria-label','AI Memory Lab 工作区');
 // Static markup only. All model/user text uses textContent.
 dialog.innerHTML=`<header class="native-header"><div><strong>AI Memory Lab</strong><span>本机会话与记忆实验</span></div><div><button id="nl-help" data-idle>使用帮助</button><button id="nl-sample" data-idle>独立 28 步演示 · SIMULATED</button><button id="nl-close" data-idle>返回演示</button></div></header>
 <nav class="native-nav" aria-label="实验工作区"><button id="nl-start-view" aria-pressed="true" data-idle>开始实验</button><button id="nl-archive-view" aria-pressed="false" data-idle>会话 ZIP</button><button id="nl-chat-view" aria-pressed="false" data-idle>对话</button><button id="nl-evolution-view" aria-pressed="false" data-idle>记忆演化</button><button id="nl-graph-view" aria-pressed="false" data-idle>三维图谱</button><button id="nl-answer-view" aria-pressed="false" data-idle>回答验证</button>
 <details id="nl-records" class="native-records"><summary>实验记录</summary><div class="native-record-actions"><label>打开实验<select id="nl-experiments" data-idle></select></label><label>当前实验名称<input id="nl-rename-name" maxlength="80" data-idle></label><div><button id="nl-rename" data-idle>重命名</button><button id="nl-reset" data-idle>重置为新实验</button><button id="nl-remove" data-idle>删除实验</button></div><details><summary>导出范围</summary><label><input id="nl-export-rules" type="checkbox" checked>守则</label><label><input id="nl-export-memory" type="checkbox" checked>记忆</label><label><input id="nl-export-turns" type="checkbox">对话与候选（可能含私人内容）</label><button id="nl-export" data-idle>导出所选数据</button></details></div></details></nav>
 <section id="nl-guide" class="native-guide" aria-label="快速上手" hidden><div><span id="nl-guide-progress"></span><strong id="nl-guide-title"></strong><p id="nl-guide-description"></p></div><button id="nl-guide-action" data-idle></button><button id="nl-guide-next" data-idle>下一步</button><button id="nl-guide-skip" data-idle>跳过</button></section>
 <div class="native-heading"><h1 id="nl-title">开始实验</h1><p id="nl-policy" class="native-policy"></p><button id="nl-policy-view" data-idle hidden>查看实验守则</button></div><div id="nl-status" role="status" aria-live="polite"></div><button id="nl-recover" data-idle hidden>结束上次中断请求并恢复</button>
 <section id="nl-setup" class="native-setup" aria-label="模型与守则设置">
 <p>选择模型与守则，创建实验后开始对话。没有 API？可先打开离线示例。</p>
 <div class="native-setup-columns"><details id="nl-model-panel" open><summary>连接模型</summary><p>所选模型服务会接收本轮输入、守则、获准记忆及适用聊天上下文。</p>
 <div class="native-model-form"><label>已保存配置<select id="nl-models" data-idle></select></label><button id="nl-profile-new" data-idle>新配置</button><label>配置名称<input id="nl-provider" value="OpenAI" data-idle></label><label>接口协议<select id="nl-protocol" data-idle><option value="openai">OpenAI / 兼容接口</option><option value="anthropic">Anthropic Claude</option><option value="gemini">Google Gemini</option></select></label><label class="native-wide">Base URL<input id="nl-base" value="https://api.openai.com/v1" data-idle></label><label>模型名称<input id="nl-model" placeholder="填写模型 ID" data-idle></label><label>API Key<input id="nl-key" type="password" autocomplete="off" placeholder="编辑时留空保留原 Key" data-idle></label></div>
 <div class="native-setting-options"><label><input id="nl-save-key" type="checkbox" data-idle>将新 Key 保存到系统凭据库</label><label><input id="nl-stream" type="checkbox" checked data-idle>流式回复</label></div><div class="native-actions"><button id="nl-profile-save" data-idle>保存配置</button><button id="nl-test" data-idle>测试连接（可能计费）</button><button id="nl-profile-delete" data-idle>删除配置</button></div></details>
 <details id="nl-rules-panel" open><summary>选择记忆守则</summary><p id="nl-rules-selected" class="native-digest"></p><div class="native-actions"><button id="nl-rules-default" data-idle>使用内置守则</button><button id="nl-rules-import" data-idle>导入 Markdown</button></div><label>新实验守则草稿<textarea id="nl-rules" rows="5" data-idle></textarea></label><div class="native-actions"><button id="nl-rules-review" data-idle>预览粘贴内容</button><button id="nl-rules-undo" data-idle>还原已选内容</button></div>
 <section id="nl-rules-preview" class="native-rule-preview" aria-label="待确认守则" hidden><h2>确认自定义守则</h2><p id="nl-rules-preview-hash" class="native-digest"></p><pre id="nl-rules-preview-text"></pre><button id="nl-rules-accept" data-idle>确认用于新实验</button><button id="nl-rules-cancel" data-idle>取消</button></section>
 <p>选择或编辑守则只影响新实验。守则仅作为本实验的治理配置，不能扩大应用权限；实际写入由内核裁决。</p><details id="nl-current-rules" hidden><summary>当前实验的固定守则</summary><p id="nl-current-rules-hash" class="native-digest"></p><pre id="nl-current-rules-text"></pre></details></details></div>
 <div class="native-create"><label>新实验名称<input id="nl-name" placeholder="例如：偏好更正实验" maxlength="80" data-idle></label><label>本地角色标识<input id="nl-role" value="LOCAL" pattern="[A-Z][A-Z0-9_]{0,39}" maxlength="40" data-idle></label><button id="nl-new" data-idle>创建实验</button><span id="nl-create-summary"></span></div></section>
 <details class="native-script"><summary>官方 28 轮脚本</summary><div class="native-actions"><button id="nl-script-import" data-idle>导入官方原件</button><input id="nl-script-file" type="file" accept=".md,text/markdown" hidden><button id="nl-script-replay" data-idle>查看独立模拟演示 · SIMULATED</button><button id="nl-script-clear" data-idle>清除本次导入</button></div><section id="nl-script-panel" hidden><small id="nl-script-hash" class="native-digest"></small><div class="native-script-browse"><div class="native-script-reader"><label>当前脚本轮次<select id="nl-script-round" data-idle></select></label><pre id="nl-script-preview"></pre><p id="nl-script-state"></p><button id="nl-script-use" data-idle>放入输入框，不自动发送</button></div><div id="nl-script-grid" class="native-script-grid" role="group" aria-label="完整28轮目录"></div></div></section></details>
 <section id="nl-archive-panel" class="native-archive" aria-label="本机会话 ZIP 浏览" hidden><div class="native-archive-bar"><div><small id="nl-archive-meta"></small></div><div><button id="nl-archive-import" data-idle>选择 ZIP</button><button id="nl-archive-accept" data-idle hidden>确认导入</button><button id="nl-archive-reject" data-idle hidden>取消预览</button><button id="nl-archive-graph" data-idle>原始消息关系</button><button id="nl-archive-replay" data-idle>在新实验逐批重新治理</button><button id="nl-archive-clear" data-idle>清除浏览</button></div></div><details class="native-archive-boundary"><summary>导入与隐私说明</summary><p>这里只读展示导出中的用户与助手文字。高敏值默认遮蔽。工具和内部片段只计数，不作为回答；没有记忆操作记录时，不推断历史记忆演化。只读浏览不创建实验。主动重新治理另建本地实验，不调用模型，不把历史回答冒充本次结果；私人内容不进入发布包。</p></details><div class="native-archive-tools"><input id="nl-archive-search" type="search" aria-label="搜索消息文字或原始 ID" placeholder="搜索文字或消息 ID" data-idle><select id="nl-archive-role" aria-label="原始消息筛选" data-idle><option value="all">全部消息</option><option value="user">用户</option><option value="assistant">助手</option><option value="tool">含工具记录</option><option value="empty">无文字</option></select><button id="nl-archive-previous" data-idle>上一批</button><button id="nl-archive-next" data-idle>下一批</button></div><div class="native-archive-columns"><nav id="nl-archive-list" aria-label="会话批次"></nav><article id="nl-archive-detail"></article></div></section>
 <div id="nl-workspace" class="native-workspace" hidden><section><div class="native-view"><select id="nl-filter" aria-label="记忆状态筛选" data-idle><option value="all">全部状态</option><option value="current">当前</option><option value="task">未完成任务</option><option value="completed">已完成</option><option value="pending">待核实</option><option value="history">历史</option><option value="retired">已退出</option></select><select id="nl-relation" aria-label="关系筛选" data-idle><option value="all">全部关系</option><option value="主体归属">角色归属</option><option value="SUPERSEDE">更正</option><option value="DERIVE">派生</option><option value="SOURCE">来源消息</option><option value="PARENT">父消息</option><option value="GOVERNANCE">触发治理</option><option value="AFFECTS">操作目标</option><option value="CONTRADICT">冲突</option></select><select id="nl-graph-type" aria-label="图谱节点类型" data-idle><option value="all">全部节点</option><option value="memory">记忆版本</option><option value="message">来源消息</option><option value="event">治理事件</option></select><select id="nl-graph-role" aria-label="消息角色" data-idle><option value="all">全部消息角色</option><option value="user">用户消息</option><option value="assistant">助手消息</option></select><select id="nl-graph-event" aria-label="审计事件筛选" data-idle><option value="all">全部事件</option><option value="ADD">新增</option><option value="UPDATE">更新</option><option value="DELETE">删除</option><option value="REJECT">拒绝</option><option value="RETIRE">失效</option></select><button id="nl-fit" data-idle>重置视角</button><span id="nl-graph-note"></span></div><section id="nl-live" class="native-live" aria-label="当前模型响应（尚未保存）" hidden></section><div id="nl-conversation" class="native-conversation"></div><div id="nl-graph" class="native-graph" role="img" aria-label="本轮已登记的记忆版本与关系；也可用右侧列表查看" hidden></div><small id="nl-graph-help" class="native-graph-help" hidden>左键拖动旋转 · 滚轮缩放 · 右键平移 · 点选节点聚焦；键盘可通过右侧记忆列表查看关系。</small></section><aside><h2 id="nl-memory-heading">处理后的记忆</h2><div id="nl-memories"></div><div id="nl-details"></div><p id="nl-memory-privacy" role="status" aria-live="polite"></p><details id="nl-memory-file"><summary>角色记忆文件</summary><p id="nl-memory-path" class="native-digest"></p><small id="nl-memory-verification" role="status"></small><small id="nl-memory-digest" class="native-digest"></small><div class="native-actions"><button id="nl-memory-read" data-idle>读取 Markdown</button><button id="nl-memory-reveal" data-idle>打开所在文件夹</button><button id="nl-memory-export" data-idle>导出 Markdown</button></div><pre id="nl-memory-text"></pre></details></aside></div>
 <footer id="nl-footer" hidden><div class="native-round"><span id="nl-round"></span><input id="nl-position" type="range" min="0" max="0" value="0" aria-label="实验轮次" data-idle></div><details id="nl-send-options" class="native-send-options"><summary>发送设置与上下文</summary><small id="nl-model-summary"></small><small id="nl-context-summary" role="status"></small><details id="nl-context-panel" hidden><summary>本轮附带的记忆</summary><label>仅发送所选记忆，仍须通过内核准入；默认不附带。可用 Ctrl / Command 多选。<select id="nl-context" multiple size="3" data-idle></select></label><label><input id="nl-context-keep" type="checkbox" data-idle>保持本实验的选择（每轮重新校验）</label><small>待办优先列出；历史记忆检索暂不支持。最近聊天仍按时效与容量裁剪。</small></details><div id="nl-query-options"><label><input id="nl-history" type="checkbox" checked data-idle>附带适用的历史聊天</label><button id="nl-followup" type="button" data-idle>填入证据回顾问题</button><button id="nl-baseline" type="button" data-idle>本次对照：不附带记忆和聊天</button></div><label><input id="nl-temporary" type="checkbox" data-idle>仅本轮临时处理：允许发送模型，不保存对话或记忆</label></details><form id="nl-composer"><textarea id="nl-input" rows="2" aria-label="发送给模型的消息" placeholder="输入消息；Enter 发送，Shift + Enter 换行" data-idle></textarea><button id="nl-send" data-idle>发送</button><button id="nl-cancel" type="button" disabled>取消请求</button></form><small>模型建议 → 内核自动准入或按需确认 → 本机保存。删除记忆不等于删除原始聊天。</small></footer>`;
 doc.body.append(dialog);
 for(const id of ['memory-heading','archive-accept','archive-reject','archive-search','archive-role','archive-previous','archive-next','archive-graph','graph-type','graph-role','graph-event','relation','graph-help','memory-verification','archive-panel','archive-meta','archive-import','archive-clear','archive-list','archive-detail','archive-view','send-options','script-grid','script-import','script-file','script-replay','script-clear','script-panel','script-hash','script-round','script-preview','script-state','script-use','answer-view','followup','history','query-options','baseline','temporary','memory-privacy','memory-file','memory-path','memory-digest','memory-read','memory-reveal','memory-export','memory-text','role','archive-replay','context', 'context-panel', 'context-summary', 'context-keep', 'help', 'sample', 'close', 'start-view', 'chat-view', 'evolution-view', 'graph-view', 'records', 'experiments', 'rename-name', 'rename', 'reset', 'remove', 'export-rules', 'export-memory', 'export-turns', 'export', 'guide', 'guide-progress', 'guide-title', 'guide-description', 'guide-action', 'guide-next', 'guide-skip', 'title', 'policy', 'policy-view', 'status', 'recover', 'setup', 'model-panel', 'models', 'profile-new', 'provider', 'protocol', 'base', 'model', 'key', 'save-key', 'stream', 'profile-save', 'test', 'profile-delete', 'rules-panel', 'rules-selected', 'rules-default', 'rules-import', 'rules', 'rules-review', 'rules-undo', 'rules-preview', 'rules-preview-hash', 'rules-preview-text', 'rules-accept', 'rules-cancel', 'current-rules', 'current-rules-hash', 'current-rules-text', 'name', 'new', 'create-summary', 'workspace', 'filter', 'fit', 'graph-note', 'live', 'conversation', 'graph', 'memories', 'details', 'footer', 'round', 'position', 'model-summary', 'composer', 'input', 'send', 'cancel'])ui[id.replace(/-([a-z])/g,(_,c)=>c.toUpperCase())]=dialog.querySelector('#nl-'+id);
 dialog.addEventListener('keydown',e=>e.stopPropagation());dialog.addEventListener('cancel',e=>{e.preventDefault();if(!working)leave();});
 const bind=(name,fn)=>ui[name].addEventListener('click',()=>guard(fn));
 bind('close',leave);
 bind('new',async()=>{
  if(!draft||ui.rules.value!==draft.text||preview)throw Error('请先预览并确认守则，或还原已选内容。');
  exp=await call({op:'create',name:ui.name.value||'未命名实验',role:ui.role.value||'LOCAL',rules:draft.text,rules_source:draft.source});clearPreview();frameIndex=0;selected=null;ui.renameName.value=exp.name;await libraries();setView('chat');notice('实验已创建并保存。守则快照已固定，请选择模型后发送消息。');
 });
 bind('rename',()=>mutate('rename',{name:ui.renameName.value}));
 bind('remove',async()=>{if(exp&&root.confirm('永久删除本机这一实验及对话、记忆数据库？已有外部导出不会被删除。')){await call({op:'remove',id:exp.id,revision:exp.revision});exp=null;selected=null;graph?.dispose();graph=null;graphExperiment=null;ui.memories.replaceChildren();ui.details.replaceChildren();render();await libraries();}});
 bind('reset',async()=>{if(!exp||!root.confirm('保留原实验，新建同守则的空实验？'))return;exp=await call({op:'create',name:exp.name+' · 重置',role:exp.role,rules:exp.rules.text,...(exp.rules.source?{rules_source:exp.rules.source}:{})});clearPreview();frameIndex=0;selected=null;ui.renameName.value=exp.name;await libraries();setView('chat');});
 ui.experiments.onchange=()=>guard(async()=>{try{await open(ui.experiments.value);}catch(error){ui.experiments.value=exp?.id||'';throw error;}});
 ui.protocol.onchange=()=>{ui.base.value={openai:'https://api.openai.com/v1',anthropic:'https://api.anthropic.com/v1',gemini:'https://generativelanguage.googleapis.com/v1beta'}[ui.protocol.value];};
 ui.models.onchange=()=>{profileId=ui.models.value;const p=profiles.find(x=>x.id===profileId);ui.key.value='';ui.saveKey.checked=false;if(p){ui.provider.value=p.name;ui.protocol.value=p.protocol;ui.base.value=p.base_url;ui.model.value=p.model;}updateSetup();};
 bind('profileNew',()=>{profileId=null;ui.models.value='';ui.key.value='';ui.saveKey.checked=false;updateSetup();notice('填写新配置并保存。');});
 bind('profileSave',async()=>{const id=profileId||root.crypto.randomUUID().replaceAll('-',''),key=ui.key.value||(profileId?null:''),persist=ui.saveKey.checked;await invoke('save_profile',{id,profile:{name:ui.provider.value,protocol:ui.protocol.value,base_url:ui.base.value,model:ui.model.value},key,persist});profileId=id;ui.key.value='';await libraries();notice(key===null?'配置已保存，原 Key 保持不变。':persist?'配置与新 Key 已保存到本机系统凭据库。':'配置已保存；临时 Key 仅在本次应用进程有效。');});
 bind('profileDelete',async()=>{if(!profileId)return;if(root.confirm('删除模型配置及系统中保存的对应 Key？')){await invoke('delete_profile',{id:profileId});profileId=null;await libraries();notice('配置已删除。');}});
 bind('test',async()=>{if(!profileId)throw Error('请先保存模型配置');busy(true);const rid=root.crypto.randomUUID();try{running={busy:true,stop:()=>invoke('cancel_model',{requestId:rid})};busy(true);await model(profileId,rid,'Reply briefly.',[{role:'user',content:'Reply OK.'}],false,()=>{});notice('连接测试成功，供应商已返回文本。该测试可能计费。');}finally{running=null;}});
 bind('rulesImport',async()=>{const value=await invoke('import_rules');if(value!==null)await previewRules(value.text,value.name);});
 bind('rulesReview',()=>previewRules(ui.rules.value,'粘贴文本'));
 bind('rulesAccept',()=>{if(!preview)throw Error('请先预览守则');useRules(preview);render();notice('已选择新实验守则；当前实验快照保持不变。');});
 bind('rulesCancel',()=>{preview=null;ui.rulesPreview.hidden=true;});
 bind('rulesUndo',()=>{if(!draft)throw Error('尚未加载有效守则');useRules(draft);});bind('rulesDefault',()=>{if(!builtin)throw Error('内置守则未能加载，请重新打开实验工作区。');useRules(builtin);render();notice('新实验将使用应用内置守则。');});
 bind('policyView',()=>{setView('setup');ui.rulesPanel.open=true;ui.currentRules.open=true;ui.currentRules.scrollIntoView?.({block:'nearest'});});
 bind('help',()=>showGuide());bind('guideSkip',dismissGuide);
 bind('guideNext',()=>guideStep===guide.length-1?dismissGuide():showGuide(guideStep+1));
 bind('guideAction',()=>{if(guideStep<2){setView('setup');ui[guideStep===0?'modelPanel':'rulesPanel'].open=true;ui[guideStep===0?'models':'rulesDefault'].focus();}else if(guideStep===2){setView(exp?'chat':'setup');ui[exp?'input':'name'].focus();}else setView(exp?'evolution':'setup');});
 const sample=()=>{dismissGuide();leave();root.dispatchEvent(new Event('memory-native-sample'));root.MemoryWorkspace?.restore(root.MemoryModel.adapt(root.REPLAY_DATA));root.MemoryWorkspace?.view('graph');const a=doc.getElementById('context-admission');if(a)a.open=true;root.MemoryWorkspace?.notice('SIMULATED · 结构化内核回放。候选操作由人工标注，不含模型提取或最终回答；可按轮查看实际差异和准入。');};bind('sample',sample);
 bind('scriptImport',()=>ui.scriptFile.click());
 bind('archiveImport',async()=>{const result=await invoke('import_chat_archive');if(!result){notice('已取消导入；当前浏览内容保持不变。');return;}if(result.format!=='memory-lab.chat-archive.v1'||!Array.isArray(result.batches))throw Error('会话解析结果无效');if(archivePreview?.archive_token&&archivePreview.archive_token!==archive?.archive_token&&archivePreview.archive_token!==result.archive_token)await invoke('forget_chat_archive',{archiveToken:archivePreview.archive_token});if(archive?.sha256===result.sha256){if(result.archive_token&&result.archive_token!==archive.archive_token)await invoke('forget_chat_archive',{archiveToken:result.archive_token});archivePreview=null;renderArchive();notice('这份 ZIP 已导入，没有重复记录。');return;}archivePreview=result;archiveIndex=0;setView('archive');notice('解析完成，请查看消息数量和异常后确认导入；尚未创建实验。');});
 bind('archiveAccept',async()=>{if(!archivePreview)return;if(archive?.archive_token&&archive.archive_token!==archivePreview.archive_token)await invoke('forget_chat_archive',{archiveToken:archive.archive_token});archive=archivePreview;archivePreview=null;archiveIndex=0;archiveGraphMode=false;renderArchive();notice('已导入本窗口；高敏值已遮蔽，未核验历史记忆状态。');});
 bind('archiveReject',async()=>{if(archivePreview?.archive_token&&archivePreview.archive_token!==archive?.archive_token)await invoke('forget_chat_archive',{archiveToken:archivePreview.archive_token});archivePreview=null;archiveIndex=0;renderArchive();notice('已取消预览，原浏览记录未被替换。');});
 bind('archivePrevious',()=>archiveStep(-1));bind('archiveNext',()=>archiveStep(1));
 ui.archiveSearch.oninput=renderArchive;ui.archiveRole.onchange=renderArchive;
 bind('archiveGraph',()=>{if(!archive||archivePreview)return;archiveGraphMode=true;ui.relation.value=ui.graphRole.value='all';setView('graph');});
 bind('archiveClear',()=>{clearArchive();renderArchive();notice('会话浏览内容已从当前窗口清除；原始 ZIP 未改动。');});
 ui.scriptFile.onchange=()=>guard(async()=>{const file=ui.scriptFile.files[0];ui.scriptFile.value='';if(!file)return;if(file.size>400000)throw Error('脚本超过400KB');const parsed=await scriptDraft(new TextDecoder('utf-8',{fatal:true}).decode(await file.arrayBuffer()),file.name);script=parsed;ui.scriptRound.replaceChildren(...script.rows.map(r=>new Option('第 '+r.round+' 轮',String(r.round-1))));renderScript();notice('已核验原件哈希和连续28轮；没有保存或发送脚本文本。');});
 ui.scriptRound.onchange=renderScript;
 bind('scriptClear',()=>{clearScript();notice('本次导入已清除；已保存的实验不变。');});
 bind('scriptUse',()=>{if(!script||!exp)throw Error('请先导入原件并创建实验');const row=script.rows[Number(ui.scriptRound.value)];if(root.MemoryModel.forbiddenPersonal(row.input))throw Error('本轮含禁存信息，请先脱敏');setView(exp?'chat':'setup');ui.input.value=row.input;notice('仅填入原文，未发送；人物标签不是认证或保存授权。');ui.input.focus();});
 bind('scriptReplay',sample);
 bind('followup',()=>{setView(exp?'answer':'setup');if(!exp)throw Error('请先创建实验');ui.input.value='请依据本次实际提供的上下文，列出当前有效事实、未完成任务和仍不能确定的事项；没有依据请明确说明。';ui.input.focus();notice('问题已填入，未请求模型。可先运行无记忆无历史对照，再选择获准记忆发送同一问题。');});
 bind('baseline',()=>{for(const option of ui.context.options)option.selected=false;ui.contextKeep.checked=false;ui.history.checked=false;contextSummary();notice('下次请求仍使用实验守则，但不附带记忆或历史。请自行输入并发送对照问题。');});
 bind('recover',()=>mutate('abort',{request_id:exp.pending.request_id,status:'interrupted'}));
 bind('export',async()=>{if(!exp)throw Error('请先打开实验');const sections=['rules','memory','turns'].filter(x=>dialog.querySelector('#nl-export-'+x).checked);if(!sections.length)throw Error('请选择导出范围');notice(await invoke('export_experiment',{id:exp.id,sections})?'已保存所选实验数据。':'已取消导出。');});
 bind('startView',()=>setView('setup'));bind('archiveView',()=>setView('archive'));bind('chatView',()=>setView('chat'));bind('evolutionView',()=>setView('evolution'));bind('graphView',()=>{archiveGraphMode=false;setView('graph');});bind('answerView',()=>setView('answer'));bind('fit',()=>graph?.reset());ui.filter.onchange=render;ui.relation.onchange=render;ui.graphType.onchange=render;ui.graphRole.onchange=render;ui.graphEvent.onchange=render;ui.context.onchange=contextSummary;ui.history.onchange=contextSummary;
 ui.position.oninput=()=>{if(archiveGraphMode&&view==='graph')archiveIndex=Number(ui.position.value);else frameIndex=Number(ui.position.value);render();};
 bind('memoryRead',async()=>{if(!exp)throw Error('请先打开实验');const record=await call({op:'role_memory',id:exp.id});ui.memoryText.textContent=record.text;ui.memoryPath.textContent=record.path;ui.memoryDigest.textContent=record.sha256;});
 bind('memoryReveal',async()=>{if(!exp)throw Error('请先打开实验');notice(await invoke('reveal_role_memory',{id:exp.id}));});
 bind('memoryExport',async()=>{if(!exp)throw Error('请先打开实验');notice(await invoke('export_role_markdown',{id:exp.id})?'已导出角色私人记忆，请谨慎共享。':'已取消导出。');});
 bind('archiveReplay',async()=>{
  if(!archive||!exp||archivePreview)throw Error('请先创建目标角色实验，并打开本地 ZIP');
  if(!root.confirm(`将 ZIP 中用户消息作为角色 ${exp.role} 的待审核自述，在新实验逐批重新治理？ZIP 标签不会授予权限；不会调用模型或复用历史助手回答。仅本地能可靠识别的陈述会生效，其余记录为无变化。`))return;
  const source=archive;archiveGraphMode=false;exp=await call({op:'create',name:exp.name+' · ZIP重新治理',role:exp.role,rules:exp.rules.text,...(exp.rules.source?{rules_source:exp.rules.source}:{})});
  let stopped=false;running={busy:true,stop:async()=>{stopped=true;}};ui.cancel.disabled=false;
  try{for(const batch of source.batches){if(stopped)break;notice(`本地重新治理 ${batch.number} / ${source.batches.length} 批；未调用模型。`);
   exp=await invoke('replay_archive_batch',{id:exp.id,revision:exp.revision,archiveToken:source.archive_token,batch:batch.number,sha256:source.sha256,adoptUserMessages:true});
   frameIndex=exp.frames.length-1;setView('evolution');
  }await libraries();notice((stopped?'已停止；已完成批次保留。':'本地逐批重新治理完成。')+(exp.privacy_notice?exp.privacy_notice.message+' '+exp.privacy_notice.path:'')+' 请按轮查看实际变化；未提取内容不等于历史平台未保存。');}
  catch(error){await recoverSaved(exp.id,error);}finally{running=null;}
 });
 ui.composer.onsubmit=e=>{e.preventDefault();return guard(async()=>{
  if(!exp)throw Error('请新建实验');

  const input=ui.input.value;if(!input.trim())return;
  if(!ui.temporary.checked&&(root.MemoryModel.isSensitive(input)||root.MemoryModel.personalKind(input)||/^(?:请)?(?:删除|忘记)(?:我的?)?(?:健康(?:信息|记忆)?|诊断|住址|地址|联系方式|手机号|家庭(?:信息|记忆)?|personal_(?:health|address|contact|family)|preference)$/.test(input.trim()))){
   try{await mutate('ingest',{input,request_id:root.crypto.randomUUID()});ui.input.value='';notice(exp.privacy_notice?exp.privacy_notice.message+' '+exp.privacy_notice.path:'本地处理已核验；请查看实际变化。没有发送给模型，未满足准入的信息未保存。');}catch(error){ui.input.value='';throw error;}return;
  }
  const profile=profiles.find(x=>x.id===profileId);if(!profile)throw Error('请选择模型配置');
  clearPreview();
  const phase=text('small','AI 回复 · 接收中，尚未保存'),preview=text('p','等待响应…');
  ui.live.replaceChildren(text('small','本轮输入'),text('p',input),phase,preview);ui.live.hidden=false;
  let saved=false;
  running=runner({call,model,cancel:requestId=>invoke('cancel_model',{requestId}),onText:piece=>{preview.textContent=preview.textContent==='等待响应…'?piece:preview.textContent+piece;}});
  ui.cancel.disabled=false;
  try{
   notice('正在请求模型；尚未提交记忆。');
   const result=await running.send(exp,{...profile,stream:ui.stream.checked},input,Array.from(ui.context.selectedOptions,o=>o.value),ui.temporary.checked,ui.history.checked);
   if(result.temporary){exp=result.state;ui.input.value='';ui.temporary.checked=false;phase.textContent='本次临时回复 · 未保存对话或记忆';preview.textContent=result.reply;temporaryTimer=root.setTimeout(clearPreview,120000);notice('仅本轮发送模型，没有提取候选或保存实验；提供商副本不由本应用控制。');return;}
   exp=result;saved=true;
   if(!ui.contextKeep.checked)for(const option of Array.from(ui.context.selectedOptions))option.selected=false;
   ui.input.value='';frameIndex=exp.frames.length-1;render();
   const last=exp.turns.at(-1),automatic=Object.values(last.results).filter(r=>r.admission?.startsWith('auto_')).length;
   const unresolved=last.candidates.length-Object.keys(last.results).length;
   notice(`对话已保存；内核自动处理 ${automatic} 项${unresolved?`，另有 ${unresolved} 项需按需查看，继续对话时不会自动写入`:''}。`);
  }catch(error){
   if(ui.temporary.checked||root.MemoryModel.isSensitive(preview.textContent)||root.MemoryModel.personalKind(preview.textContent)){clearPreview();ui.input.value='';ui.temporary.checked=false;}
   else{phase.textContent='AI 回复 · 未确认保存，请以已保存轮次为准';if(preview.textContent==='等待响应…')preview.textContent='本轮未收到完整回复。';temporaryTimer=root.setTimeout(clearPreview,120000);}
   await recoverSaved(exp.id,error);
  }finally{running=null;ui.live.hidden=saved;}
 });};
 ui.input.onkeydown=e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing){e.preventDefault();ui.composer.requestSubmit();}};
 ui.cancel.addEventListener('click',async()=>{try{await running?.stop();notice('已请求取消，正在核对保存状态。');}catch(e){notice(String(e));}});
}
function leave(){clearScript();clearArchive();if(running?.busy)throw Error('请先取消请求或等待结束');graph?.dispose();graph=null;graphExperiment=null;clearPreview();ui.input.value='';dialog.close();entry.focus();}
root.addEventListener('pagehide',()=>{clearScript();clearArchive();if(ui.input){ui.input.value='';clearPreview();}running?.stop();graph?.dispose();graph=null;graphExperiment=null;});
entry.onclick=()=>{if(!dialog)createDialog();return guard(async()=>{
  root.dispatchEvent(new Event('memory-native-open'));const welcome=doc.getElementById('welcome');if(welcome)welcome.hidden=true;dialog.showModal();
  if(!builtin){builtin=await ruleDraft(await invoke('default_rules'),'memory-rules.md','builtin');useRules(builtin);}
  await libraries();setView(view);
  let seen=false;try{seen=root.localStorage?.getItem('memory-lab.desktop-guide-seen')==='1';}catch{}
  if(!seen&&!ui.experiments.value&&ui.experiments.children.length===1)showGuide();
 });};
// Windows launches directly into its local experiment workspace.
if(doc.readyState)root.addEventListener('load',()=>entry.click(),{once:true});
})(typeof window!=='undefined'?window:globalThis);
