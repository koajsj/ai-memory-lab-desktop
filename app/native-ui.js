/* Desktop model experiments. Static Pages remains a network-free simulation. */
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
function extracted(text){
 const value=root.MemoryModel.parseJSON?root.MemoryModel.parseJSON(text):JSON.parse(text);
 if(!value||Object.keys(value).some(k=>!['candidates','assessment'].includes(k))||!Array.isArray(value.candidates)||value.candidates.length>16)throw Error('模型未返回候选JSON数组');
 return value;
}
// One generation owns chat+extraction+save. A cancelled generation never calls finish.
function runner({call,model,cancel,onText}){
 let busy=false,cancelled=false,request=null;
 return {get busy(){return busy;},async stop(){cancelled=true;if(request)await cancel(request);},async send(exp,profile,input,memoryVersions=[]){
  if(busy)throw Error('已有请求进行中');busy=true;cancelled=false;request=root.crypto.randomUUID();let pending;
  try{
   pending=await call({op:'prepare',id:exp.id,revision:exp.revision,input,request_id:request,memory_versions:memoryVersions,model:{name:profile.name,protocol:profile.protocol,model:profile.model,base_url:profile.base_url}});
   if(cancelled)throw Error('请求已取消');
   const messages=[{role:'user',content:JSON.stringify({governance_config:pending.prompt.rules,memory_context:pending.prompt.allowed})},...pending.prompt.messages];
   const reply=await model(profile.id,request,pending.prompt.system,messages,profile.stream!==false,t=>{if(!cancelled)onText(t);});
   if(cancelled)throw Error('请求已取消');
   let candidates=[],assessment=null,extractionError=false,extractionUsage=null;
   try{
    const r=await model(profile.id,request,pending.prompt.extraction,[{role:'user',content:JSON.stringify({input,history:pending.prompt.messages.slice(0,-1),available:pending.prompt.allowed})}],false,()=>{});
    if(cancelled)throw Error('请求已取消');const parsed=extracted(r.text);candidates=await call({op:'validate_candidates',candidates:parsed.candidates,assessment:parsed.assessment});assessment=parsed.assessment??null;extractionUsage=r.usage;
   }catch(error){if(cancelled)throw error;extractionError=true;}
   if(cancelled)throw Error('请求已取消');
   const result=await call({op:'finish',id:exp.id,revision:pending.revision,request_id:request,reply:reply.text,usage:reply.usage,extraction_usage:extractionUsage,candidates,assessment,extraction_error:extractionError});
   return result;
  }catch(error){
   if(pending){try{await call({op:'abort',id:exp.id,revision:pending.revision,request_id:request,status:cancelled?'cancelled':'failed'});}catch{/* Reopen shows the real saved pending state for explicit recovery. */}}
   throw error;
  }finally{busy=false;request=null;}
 }};
}
if(typeof module!=='undefined')module.exports={runner,extracted,ruleDraft};
if(!root.__TAURI__?.core||!root.document)return;
const doc=root.document,invoke=(c,args={})=>root.__TAURI__.core.invoke(c,args),entry=doc.getElementById('native-open');
entry.hidden=false;
let dialog,ui={},exp=null,profiles=[],profileId=null,frameIndex=0,selected=null,graph=null,running=null,working=false;
let builtin=null,draft=null,preview=null,view='setup',guideStep=0,contextExperiment=null;
const guide=[
 ['连接模型','保存供应商、API 地址、Key 和模型名称。测试连接由你主动执行，可能计费。','打开模型配置'],
 ['选择守则','已内置完整记忆守则。也可预览、确认自定义版本；已有实验的守则不变。','查看所选守则'],
 ['开始对话','创建实验并发送消息。AI 回复与候选会分别保存，候选须经内核裁决。','准备第一条消息'],
 ['查看结果','在记忆演化中比较前后变化，在三维图谱中查看真实登记的关系。','查看记忆演化']
];
const call=request=>invoke('experiment_call',{request});
const button=(text,action)=>{const b=doc.createElement('button');b.textContent=text;b.type='button';b.setAttribute('data-idle','');b.onclick=()=>guard(action);return b;};
const text=(tag,value)=>{const el=doc.createElement(tag);el.textContent=value??'未记录';return el;};
const notice=message=>{ui.status.textContent=message;};
function clearPreview(){ui.live.replaceChildren();ui.live.hidden=true;}
async function guard(action){
 if(working)return;
 working=true;busy(true);
 try{await action();}catch(e){notice(String(e));}finally{working=false;busy(false);}
}
function busy(value){
 dialog.classList.toggle('is-busy',value);
 for(const el of dialog.querySelectorAll('[data-idle]'))el.disabled=value;
 for(const name of ['rename','remove','reset','export'])ui[name].disabled=value||!exp;
 ui.new.disabled=value||!draft;ui.rulesDefault.disabled=value||!builtin;ui.rulesAccept.disabled=value||!preview;
 const last=exp?.turns.at(-1),unresolved=last?.candidates.some((_,i)=>!Object.hasOwn(last.results,String(i)));
 ui.send.disabled=value||!exp||!!exp.pending||!!unresolved;
 ui.cancel.disabled=!running?.busy;
 ui.fit.disabled=value||!graph||graph.destroyed;
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
 view=next;ui.setup.hidden=view!=='setup';ui.workspace.hidden=view==='setup';ui.footer.hidden=view==='setup';
 ui.graph.hidden=view!=='graph';ui.conversation.hidden=view==='graph';ui.filter.hidden=view!=='graph';ui.fit.hidden=view!=='graph';ui.graphNote.hidden=view!=='graph';ui.composer.hidden=view!=='chat';
 for(const [name,mode]of [['startView','setup'],['chatView','chat'],['evolutionView','evolution'],['graphView','graph']])ui[name].setAttribute('aria-pressed',String(mode===view));
 render();graph?.setPaused(view!=='graph');
}
function showGuide(step=0){guideStep=step;ui.guide.hidden=false;const [title,description,action]=guide[guideStep];ui.guideTitle.textContent=title;ui.guideDescription.textContent=description;ui.guideAction.textContent=action;ui.guideProgress.textContent=`${guideStep+1} / ${guide.length}`;ui.guideNext.textContent=guideStep===guide.length-1?'完成':'下一步';}
function dismissGuide(){ui.guide.hidden=true;try{root.localStorage?.setItem('memory-lab.desktop-guide-seen','1');}catch{/* Optional help preference only; experiments stay in SQLite. */}}

async function recoverSaved(id,error){
 try{exp=await call({op:'open',id});frameIndex=Math.max(0,exp.frames.length-1);render();}
 catch(recovery){exp=null;selected=null;graph?.dispose();graph=null;render();throw Error(`${error}；保存状态无法核对：${recovery}。请重新打开实验。`);}
 throw error;
}
async function mutate(op,extra={}){if(!exp)throw Error('请先新建实验');const id=exp.id;try{exp=await call({op,id,revision:exp.revision,...extra});}catch(error){await recoverSaved(id,error);}frameIndex=Math.max(0,exp.frames.length-1);render();if(op==='rename'){ui.renameName.value=exp.name;await libraries();}else{const last=exp.turns.at(-1),left=last?.candidates.filter((_,i)=>!Object.hasOwn(last.results,String(i))).length||0;notice(left?`已保存，尚有 ${left} 项模型建议待处理。`:'本轮操作已保存，可继续对话。');}}
function render(){
 const chosen=new Set(contextExperiment===exp?.id?Array.from(ui.context.selectedOptions,o=>o.value):[]);
 contextExperiment=exp?.id??null;
 const choices=(exp?.governance.versions||[]).filter(r=>r.payload&&['current','completed'].includes(r.lifecycle)&&exp.snapshot[r.part]?.[r.key]?.version===r.revision);
 ui.context.replaceChildren(...choices.map(r=>{const o=new Option(`${root.MemoryModel.label(r.key)}：${r.payload.value} · ${root.MemoryModel.states[r.part]?.name||r.part}`,r.version_id);o.selected=chosen.has(r.version_id);return o;}));
 ui.contextPanel.hidden=!choices.length;
 ui.title.textContent=view==='setup'?'开始实验':exp?.name||'尚未创建实验';
 ui.currentRules.hidden=!exp;ui.policyView.hidden=!exp;
 if(exp){ui.currentRulesText.textContent=exp.rules.text;ui.currentRulesHash.textContent=sourceName(exp.rules)+' · SHA-256 '+exp.rules.sha256;}
 if(!exp){
  ui.renameName.value='';ui.currentRulesText.textContent='';ui.currentRulesHash.textContent='';ui.policy.textContent='';ui.policy.title='';ui.recover.hidden=true;
  ui.position.max='0';ui.position.value='0';ui.round.textContent='尚无对话';ui.send.disabled=true;
  ui.memories.replaceChildren();ui.details.replaceChildren();clearPreview();
  ui.conversation.replaceChildren(text('h2','开始实验'),text('p','先在“开始实验”中选择模型与守则，再创建实验。无需 API 的体验可选择“离线示例”。'));
  busy(working);return;
 }
 ui.policy.textContent='本机自动保存 · '+sourceName(exp.rules)+' · '+exp.rules.sha256.slice(0,12);ui.policy.title='MODEL_EXPERIMENT · Python 治理内核 · SHA-256 '+exp.rules.sha256;
 ui.recover.hidden=!exp.pending;ui.send.disabled=!!exp.pending;
 ui.position.max=String(Math.max(0,exp.frames.length-1));ui.position.value=String(frameIndex);ui.round.textContent=exp.frames.length?`${frameIndex+1} / ${exp.frames.length} 轮`:'尚无对话';
 ui.conversation.replaceChildren();const turn=exp.turns[frameIndex],frame=exp.frames[frameIndex];
 if(exp.pending)ui.conversation.append(text('h2','尚未结束的请求'),text('p',exp.pending.input),text('small','输入已保存，完整回复尚未提交。确认其他窗口没有处理此请求后，可结束请求并恢复。'));
 if(turn){ui.conversation.append(text('h2',view==='evolution'?'本轮输入':'本轮对话'),text('small','你'),text('p',turn.input));
 const reply=[text('small','AI 回复 · '+(turn.status==='complete'?'已收到':({cancelled:'已取消',failed:'请求失败',interrupted:'上次中断'})[turn.status]||'未记录')),text('p',turn.reply||'本轮未保存完整回复，未提交记忆')];
 if(view==='evolution'){const d=doc.createElement('details');d.append(text('summary','查看本轮 AI 回复'),...reply);ui.conversation.append(d);}else ui.conversation.append(...reply);
 if(frame&&view==='evolution'){ui.conversation.append(text('h2','本轮实际变化'));if(!['added','changed','removed'].some(k=>frame.diff[k].length))ui.conversation.append(text('p','本轮记忆快照没有变化，原因以实际裁决记录为准。'));for(const d of frame.decisions)ui.conversation.append(text('p',operationName(d.action)+'：'+d.reason));for(const kind of ['added','changed','removed'])for(const path of frame.diff[kind]){const [part,key]=path.split('.');const old=frame.before[part]?.[key]?.value,next=frame.after[part]?.[key]?.value;ui.conversation.append(text('p',`${root.MemoryModel.label(key)}：${old??'未记录 / 已清除'} → ${next??'退出 / 已清除'}`));}}
 const usage=doc.createElement('details');usage.append(text('summary','模型与用量'),text('p',turn.model?.model?'本轮模型：'+(turn.model.name||'未记录')+' · '+turn.model.model:'本轮模型未记录'),text('small',turn.usage?'回复 Token：'+JSON.stringify(turn.usage):'回复 Token 用量未知'));ui.conversation.append(usage);
 if(!turn.assessment)usage.append(text('small','风险观察未记录，不代表已确认安全。'));
 if(turn.extraction_error)ui.conversation.append(text('p','候选提取失败；回复已保存，没有提交记忆。'));
 if(turn.assessment){const a=turn.assessment,d=doc.createElement('details');d.open=a.signals.length>0;d.append(text('summary','模型风险观察 · 未经独立核实'));if(a.signals.length)d.append(text('p',a.signals.join('、')));d.append(text('p',a.reason),text('p',a.next_step));ui.conversation.append(d);}
 const decided=Object.keys(turn.results).length,remaining=turn.candidates.length-decided;
 ui.conversation.append(text('h2','模型建议与治理结果'),text('p',`模型建议 ${turn.candidates.length} 项 · 已记录裁决 ${decided} 项 · 待处理 ${remaining} 项`));
 if(!turn.candidates.length)ui.conversation.append(text('p','本轮没有记忆候选，模型回复没有自动写入记忆。'));
 for(const [index,c]of turn.candidates.entries()){
  const row=doc.createElement('section');row.className='native-candidate';row.append(text('strong',`${root.MemoryModel.label(c.key)} · ${c.reactivate?'建议重新建立':c.current_correction?'建议更正':operationName(c.op)}`),text('p',c.erased?'原值已清除':c.value||'不携带新值'));
  const conditions=doc.createElement('details');conditions.append(text('summary','建议的完整条件'),text('pre',JSON.stringify(c,null,2)));row.append(conditions);
  const result=turn.results[String(index)];if(result)for(const d of result.decisions)row.append(text('p',operationName(d.action)+'：'+d.reason));
  else if(frameIndex===exp.turns.length-1){
   if(['external','inference'].includes(c.basis)&&!(c.op==='derive'&&c.basis==='inference')){
    row.append(text('p','外部主张或推断不能充当操作授权，也不因重复或确认按钮变成已核实事实。'),button(c.op==='set'&&!c.current_correction&&!c.reactivate&&c.state!=='completed'?'保留为待核实线索':'核验操作依据',()=>mutate('decide',{index,confirm:false})),button('忽略',()=>mutate('dismiss',{index})));
   }else{
   if(c.op==='set'&&!c.current_correction&&!c.reactivate&&c.state!=='completed')row.append(button('仅存入待核实区',()=>mutate('decide',{index,confirm:false})));
   row.append(button(c.op==='delete'?'授权删除':c.reactivate?'确认新依据并重新建立':'本人确认并交由内核裁决',async()=>{if(root.confirm(c.op==='delete'?'删除本实验内该记忆及受影响派生，清除可控快照原值。原始对话与既有导出不会被删除。确认？':c.reactivate?'仅在你现在提供了独立、明确的新依据时重新建立；不能以旧记录或旧摘要恢复已删除内容。确认？':'仅当你已核实这项建议及其完整条件时确认。确认只提供本实验的来源依据，仍须接受内核校验。'))await mutate('decide',{index,confirm:true});}),button('忽略',()=>mutate('dismiss',{index})));
   }
  }ui.conversation.append(row);
 }
 }
 const snapshot=frame?.after||exp.snapshot,graphModel=currentModel(),nodes=new Map((graphModel?.nodes||[]).map(n=>[n.id,n]));ui.memories.replaceChildren();
 for(const [part,group]of Object.entries(snapshot))for(const [key,p]of Object.entries(group)){const id=`${exp.role}/${part}/${key}/${p.version}`;const n=nodes.get(id);if(frame&&!n)continue;const b=button(`${root.MemoryModel.label(key)}：${p.value??'原值已清除'} · ${root.MemoryModel.states[part]?.name||part}`,()=>{if(n){selected=n.id;details(n.key,n.payload);graph?.select(n.id);graph?.focus(n.id);}});ui.memories.append(b);}
 if(!ui.memories.children.length)ui.memories.append(text('p','本轮没有已保存记忆。模型回复不代表写入成功。'));
 if(selected){const n=nodes.get(selected);if(n)details(n.key,n.payload||{value:'原值已清除',source:'未记录'});else{selected=null;ui.details.textContent='所选记忆已退出当前快照或筛选范围。';}}
 else ui.details.replaceChildren();
 if(!exp.frames.length&&ui.graph.hidden)graph?.setData({nodes:[],edges:[],count:0},exp.role,{animate:false});
 graphData(graphModel);busy(working);
}
function operationName(value){return ({set:'建议保存',derive:'建议派生',retire:'建议失效',delete:'建议删除',review:'建议复核',ADD:'新增',UPDATE:'更正',MERGE:'合并',REJECT:'拒绝',NO_CHANGE:'无写入',RETIRE:'退出当前状态',DELETE:'删除',PENDING:'隔离待核实'})[value]||value;}
function currentModel(){if(!exp?.frames.length)return null;return root.MemoryModel.graph({role:exp.role,data:{frames:exp.frames}},frameIndex,{state:ui.filter.value||'all'});}
function details(key,p){const f=exp.frames[frameIndex],versions=f?.governance.versions.filter(r=>r.key===key.replace(/__previous$/,''))||[];ui.details.replaceChildren(text('h2',root.MemoryModel.label(key)),text('p',p.value),text('p','来源：'+(root.MemoryModel.sourceNames[p.source]||p.source||'未记录')));const advanced=doc.createElement('details');advanced.append(text('summary','来源、版本与派生记录'),text('pre',JSON.stringify(versions,null,2)));for(const r of versions){const at=exp.frames.findIndex(f=>f.governance.versions.some(v=>v.version_id===r.version_id));if(at>=0)advanced.append(button('查看版本首次登记轮次 '+(at+1),()=>{frameIndex=at;render();}));}ui.details.append(advanced);}
function graphData(m=currentModel()){if(ui.graph.hidden||graph?.destroyed)return;if(!m){graph?.setData({nodes:[],edges:[],count:0},exp?.role||'LOCAL',{animate:false});graph?.select(null);ui.graphNote.textContent='尚无治理记录，二维记忆列表仍可使用。';return;}if(!graph){try{graph=new root.MemoryGraph.GraphView(ui.graph,{states:root.MemoryModel.states,onSelect:id=>{const n=currentModel()?.nodes.find(n=>n.id===id);if(n){selected=n.id;details(n.key,n.payload||{value:'原值已清除',source:'未记录'});graph?.select(id);}},onUnavailable:m=>{ui.graphNote.textContent=m;ui.fit.disabled=true;}});graph.configure({motion:!root.matchMedia('(prefers-reduced-motion: reduce)').matches,low:false});}catch{ui.graphNote.textContent='WebGL不可用，请使用记忆列表和时间轴。';return;}}
 ui.graphNote.textContent='';graph.setData(m,exp.role,{animate:false});graph.select(m.nodes.some(n=>n.id===selected)?selected:null);graph.resizeToHost();graph.request();}
function createDialog(){
 dialog=doc.createElement('dialog');dialog.className='native-lab';dialog.setAttribute('aria-label','真实模型实验');
 // Static markup only. All model/user text uses textContent.
 dialog.innerHTML=`<header class="native-header"><div><strong>AI Memory Lab</strong><span>真实模型实验 · 本机保存</span></div><div><button id="nl-help" data-idle>使用帮助</button><button id="nl-sample" data-idle>离线示例 · SIMULATED</button><button id="nl-close" data-idle>返回演示</button></div></header>
 <nav class="native-nav" aria-label="实验工作区"><button id="nl-start-view" aria-pressed="true" data-idle>开始实验</button><button id="nl-chat-view" aria-pressed="false" data-idle>对话</button><button id="nl-evolution-view" aria-pressed="false" data-idle>记忆演化</button><button id="nl-graph-view" aria-pressed="false" data-idle>三维图谱</button>
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
 <div class="native-create"><label>新实验名称<input id="nl-name" placeholder="例如：偏好更正实验" maxlength="80" data-idle></label><button id="nl-new" data-idle>创建实验</button><span id="nl-create-summary"></span></div></section>
 <div id="nl-workspace" class="native-workspace" hidden><section><div class="native-view"><select id="nl-filter" aria-label="记忆状态筛选" data-idle><option value="all">全部状态</option><option value="current">当前</option><option value="task">未完成任务</option><option value="completed">已完成</option><option value="pending">待核实</option><option value="history">历史</option><option value="retired">已退出</option></select><button id="nl-fit" data-idle>全景</button><span id="nl-graph-note"></span></div><section id="nl-live" class="native-live" aria-label="当前模型响应（尚未保存）" hidden></section><div id="nl-conversation" class="native-conversation"></div><div id="nl-graph" class="native-graph" hidden></div></section><aside><h2>处理后的记忆</h2><div id="nl-memories"></div><div id="nl-details"></div></aside></div>
 <footer id="nl-footer" hidden><div class="native-round"><span id="nl-round"></span><input id="nl-position" type="range" min="0" max="0" value="0" aria-label="实验轮次" data-idle></div><small id="nl-model-summary"></small><details id="nl-context-panel" hidden><summary>本轮附带的记忆</summary><label>仅发送所选记忆，仍须通过内核准入；默认不附带。可用 Ctrl / Command 多选。<select id="nl-context" multiple size="3" data-idle></select></label></details><form id="nl-composer"><textarea id="nl-input" rows="2" aria-label="发送给模型的消息" placeholder="输入消息；Enter 发送，Shift + Enter 换行" data-idle></textarea><button id="nl-send" data-idle>发送</button><button id="nl-cancel" type="button" disabled>取消请求</button></form><small>模型建议 → 本人确认或隔离 → 内核裁决 → 本机保存。删除记忆不等于删除原始聊天。</small></footer>`;
 doc.body.append(dialog);
 for(const id of ['context', 'context-panel', 'help', 'sample', 'close', 'start-view', 'chat-view', 'evolution-view', 'graph-view', 'records', 'experiments', 'rename-name', 'rename', 'reset', 'remove', 'export-rules', 'export-memory', 'export-turns', 'export', 'guide', 'guide-progress', 'guide-title', 'guide-description', 'guide-action', 'guide-next', 'guide-skip', 'title', 'policy', 'policy-view', 'status', 'recover', 'setup', 'model-panel', 'models', 'profile-new', 'provider', 'protocol', 'base', 'model', 'key', 'save-key', 'stream', 'profile-save', 'test', 'profile-delete', 'rules-panel', 'rules-selected', 'rules-default', 'rules-import', 'rules', 'rules-review', 'rules-undo', 'rules-preview', 'rules-preview-hash', 'rules-preview-text', 'rules-accept', 'rules-cancel', 'current-rules', 'current-rules-hash', 'current-rules-text', 'name', 'new', 'create-summary', 'workspace', 'filter', 'fit', 'graph-note', 'live', 'conversation', 'graph', 'memories', 'details', 'footer', 'round', 'position', 'model-summary', 'composer', 'input', 'send', 'cancel'])ui[id.replace(/-([a-z])/g,(_,c)=>c.toUpperCase())]=dialog.querySelector('#nl-'+id);
 dialog.addEventListener('keydown',e=>e.stopPropagation());dialog.addEventListener('cancel',e=>{e.preventDefault();if(!working)leave();});
 const bind=(name,fn)=>ui[name].addEventListener('click',()=>guard(fn));
 bind('close',leave);
 bind('new',async()=>{
  if(!draft||ui.rules.value!==draft.text||preview)throw Error('请先预览并确认守则，或还原已选内容。');
  exp=await call({op:'create',name:ui.name.value||'未命名实验',rules:draft.text,rules_source:draft.source});clearPreview();frameIndex=0;selected=null;ui.renameName.value=exp.name;await libraries();setView('chat');notice('实验已创建并保存。守则快照已固定，请选择模型后发送消息。');
 });
 bind('rename',()=>mutate('rename',{name:ui.renameName.value}));
 bind('remove',async()=>{if(exp&&root.confirm('永久删除本机这一实验及对话、记忆数据库？已有外部导出不会被删除。')){await call({op:'remove',id:exp.id,revision:exp.revision});exp=null;selected=null;graph?.dispose();graph=null;ui.memories.replaceChildren();ui.details.replaceChildren();render();await libraries();}});
 bind('reset',async()=>{if(!exp||!root.confirm('保留原实验，新建同守则的空实验？'))return;exp=await call({op:'create',name:exp.name+' · 重置',rules:exp.rules.text,...(exp.rules.source?{rules_source:exp.rules.source}:{})});clearPreview();frameIndex=0;selected=null;ui.renameName.value=exp.name;await libraries();setView('chat');});
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
 bind('sample',()=>{dismissGuide();leave();root.dispatchEvent(new Event('memory-native-sample'));root.MemoryWorkspace?.restore(root.MemoryModel.adapt(root.REPLAY_DATA));root.MemoryWorkspace?.view('graph');});
 bind('recover',()=>mutate('abort',{request_id:exp.pending.request_id,status:'interrupted'}));
 bind('export',async()=>{if(!exp)throw Error('请先打开实验');const sections=['rules','memory','turns'].filter(x=>dialog.querySelector('#nl-export-'+x).checked);if(!sections.length)throw Error('请选择导出范围');notice(await invoke('export_experiment',{id:exp.id,sections})?'已保存所选实验数据。':'已取消导出。');});
 bind('startView',()=>setView('setup'));bind('chatView',()=>setView('chat'));bind('evolutionView',()=>setView('evolution'));bind('graphView',()=>setView('graph'));bind('fit',()=>graph?.reset());ui.filter.onchange=render;
 ui.position.oninput=()=>{frameIndex=Number(ui.position.value);render();};
 ui.composer.onsubmit=e=>{e.preventDefault();return guard(async()=>{
  if(!exp)throw Error('请新建实验');
  const profile=profiles.find(x=>x.id===profileId);if(!profile)throw Error('请选择模型配置');
  const input=ui.input.value;if(!input.trim())return;
  const phase=text('small','AI 回复 · 接收中，尚未保存'),preview=text('p','等待响应…');
  ui.live.replaceChildren(text('small','本轮输入'),text('p',input),phase,preview);ui.live.hidden=false;
  let streamed='',saved=false;
  running=runner({call,model,cancel:requestId=>invoke('cancel_model',{requestId}),onText:piece=>{streamed+=piece;preview.textContent=streamed;}});
  ui.cancel.disabled=false;
  try{
   notice('正在请求模型；尚未提交记忆。');
   exp=await running.send(exp,{...profile,stream:ui.stream.checked},input,Array.from(ui.context.selectedOptions,o=>o.value));saved=true;
   for(const option of Array.from(ui.context.selectedOptions))option.selected=false;
   ui.input.value='';frameIndex=exp.frames.length-1;render();
   notice(exp.turns.at(-1).candidates.length?'对话已保存。请逐项确认、隔离或忽略模型建议，再开始下一轮。':'对话已保存，本轮没有待处理建议。');
  }catch(error){
   phase.textContent='AI 回复 · 未确认保存，请以已保存轮次为准';
   if(!streamed)preview.textContent='本轮未收到完整回复。';
   await recoverSaved(exp.id,error);
  }finally{running=null;ui.live.hidden=saved;}
 });};
 ui.input.onkeydown=e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing){e.preventDefault();ui.composer.requestSubmit();}};
 ui.cancel.addEventListener('click',async()=>{try{await running?.stop();notice('已请求取消，正在核对保存状态。');}catch(e){notice(String(e));}});
}
function leave(){if(running?.busy)throw Error('请先取消请求或等待结束');graph?.dispose();graph=null;clearPreview();dialog.close();entry.focus();}
root.addEventListener('pagehide',()=>{running?.stop();graph?.dispose();graph=null;});
entry.onclick=()=>{if(!dialog)createDialog();return guard(async()=>{
  root.dispatchEvent(new Event('memory-native-open'));const welcome=doc.getElementById('welcome');if(welcome)welcome.hidden=true;dialog.showModal();
  if(!builtin){builtin=await ruleDraft(await invoke('default_rules'),'memory-rules.md','builtin');useRules(builtin);}
  await libraries();setView(view);
  let seen=false;try{seen=root.localStorage?.getItem('memory-lab.desktop-guide-seen')==='1';}catch{}
  if(!seen&&!ui.experiments.value&&ui.experiments.children.length===1)showGuide();
 });};
// A desktop launch goes straight to setup; public Pages never enters this branch.
if(doc.readyState)root.addEventListener('load',()=>entry.click(),{once:true});
})(typeof window!=='undefined'?window:globalThis);
