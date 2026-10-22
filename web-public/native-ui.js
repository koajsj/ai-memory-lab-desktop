/* Desktop model experiments. Static Pages remains a network-free simulation. */
(function(root){
'use strict';
function extracted(text){
 const value=root.MemoryModel.parseJSON?root.MemoryModel.parseJSON(text):JSON.parse(text);
 if(!value||Object.keys(value).length!==1||!Array.isArray(value.candidates)||value.candidates.length>16)throw Error('模型未返回候选JSON数组');
 return value.candidates;
}
// One generation owns chat+extraction+save. A cancelled generation never calls finish.
function runner({call,model,cancel,onText}){
 let busy=false,cancelled=false,request=null;
 return {get busy(){return busy;},async stop(){cancelled=true;if(request)await cancel(request);},async send(exp,profile,input){
  if(busy)throw Error('已有请求进行中');busy=true;cancelled=false;request=root.crypto.randomUUID();let pending;
  try{
   pending=await call({op:'prepare',id:exp.id,revision:exp.revision,input,request_id:request,model:{name:profile.name,protocol:profile.protocol,model:profile.model,base_url:profile.base_url}});
   if(cancelled)throw Error('请求已取消');
   const reply=await model(profile.id,request,pending.prompt.system,pending.prompt.messages,profile.stream!==false,t=>{if(!cancelled)onText(t);});
   if(cancelled)throw Error('请求已取消');
   let candidates=[],extractionError=false,extractionUsage=null;
   try{
    const r=await model(profile.id,request,pending.prompt.extraction,[{role:'user',content:JSON.stringify({input,available:pending.prompt.allowed})}],false,()=>{});
    if(cancelled)throw Error('请求已取消');candidates=await call({op:'validate_candidates',candidates:extracted(r.text)});extractionUsage=r.usage;
   }catch(error){if(cancelled)throw error;extractionError=true;}
   if(cancelled)throw Error('请求已取消');
   const result=await call({op:'finish',id:exp.id,revision:pending.revision,request_id:request,reply:reply.text,usage:reply.usage,extraction_usage:extractionUsage,candidates,extraction_error:extractionError});
   return result;
  }catch(error){
   if(pending){try{await call({op:'abort',id:exp.id,revision:pending.revision,request_id:request,status:cancelled?'cancelled':'failed'});}catch{/* Reopen shows the real saved pending state for explicit recovery. */}}
   throw error;
  }finally{busy=false;request=null;}
 }};
}
if(typeof module!=='undefined')module.exports={runner,extracted};
if(!root.__TAURI__?.core||!root.document)return;
const doc=root.document,invoke=(c,args={})=>root.__TAURI__.core.invoke(c,args),entry=doc.getElementById('native-open');
entry.hidden=false;
let dialog,ui={},exp=null,profiles=[],profileId=null,frameIndex=0,selected=null,graph=null,running=null;
const call=request=>invoke('experiment_call',{request});
const button=(text,action)=>{const b=doc.createElement('button');b.textContent=text;b.type='button';b.onclick=()=>guard(action);return b;};
const text=(tag,value)=>{const el=doc.createElement(tag);el.textContent=value??'未记录';return el;};
const notice=message=>{ui.status.textContent=message;};
async function guard(action){try{await action();}catch(e){notice(String(e));}}
function busy(value){dialog.classList.toggle('is-busy',value);for(const el of dialog.querySelectorAll('[data-idle]'))el.disabled=value;ui.cancel.disabled=!value;}
function model(id,requestId,system,messages,stream,onText){const channel=new root.__TAURI__.core.Channel();channel.onmessage=onText;return invoke('model_request',{id,requestId,system,messages,stream,onDelta:channel});}
async function libraries(){
 const rows=await call({op:'list'});ui.experiments.replaceChildren(new Option('选择已保存实验',''),...rows.map(x=>new Option(x.name,x.id)));ui.experiments.value=exp?.id||'';
 profiles=await call({op:'profiles'});ui.models.replaceChildren(new Option('选择模型配置',''),...profiles.map(x=>new Option(x.name+' · '+x.model,x.id)));ui.models.value=profileId&&profiles.some(p=>p.id===profileId)?profileId:'';
}
async function open(id){exp=await call({op:'open',id});frameIndex=Math.max(0,exp.frames.length-1);selected=null;render();await libraries();}
async function mutate(op,extra={}){if(!exp)throw Error('请先新建实验');exp=await call({op,id:exp.id,revision:exp.revision,...extra});frameIndex=Math.max(0,exp.frames.length-1);render();await libraries();}
function render(){
 if(!exp){ui.conversation.replaceChildren(text('p','选择模型，导入或粘贴守则，然后新建实验。对话与记忆保存在本机。'));return;}
 ui.name.value=exp.name;ui.policy.textContent='MODEL_EXPERIMENT · Python 治理内核 · 守则 SHA-256 '+exp.rules.sha256;
 ui.recover.hidden=!exp.pending;ui.send.disabled=!!exp.pending;ui.rules.value=exp.rules.text;
 ui.position.max=String(Math.max(0,exp.frames.length-1));ui.position.value=String(frameIndex);ui.round.textContent=exp.frames.length?`${frameIndex+1} / ${exp.frames.length} 轮`:'尚无对话';
 ui.conversation.replaceChildren();const turn=exp.turns[frameIndex];
 if(turn){ui.conversation.append(text('h2','本轮对话'),text('small','你'),text('p',turn.input),text('small','AI 回复 · '+(turn.status==='complete'?'已收到':turn.status)),text('p',turn.reply||'未收到完整回复，未提交记忆'));
 const usage=turn.usage;ui.conversation.append(text('small',usage?'回复 Token：'+JSON.stringify(usage):'回复 Token 用量未知'));
 if(turn.extraction_error)ui.conversation.append(text('p','候选提取失败；回复已保存，没有提交记忆。'));
 ui.conversation.append(text('h2','模型建议与治理结果'));
 for(const [index,c]of turn.candidates.entries()){
  const row=doc.createElement('section');row.className='native-candidate';row.append(text('strong',`${c.key} · ${c.op}`),text('p',c.erased?'原值已清除':c.value||'不携带新值'));
  const result=turn.results[String(index)];if(result)for(const d of result.decisions)row.append(text('p',d.action+'：'+d.reason));
  else if(frameIndex===exp.turns.length-1){
   if(c.op==='set'&&!c.current_correction&&!c.reactivate&&c.state!=='completed')row.append(button('仅存入待核实区',()=>mutate('decide',{index,confirm:false})));
   row.append(button(c.op==='delete'?'授权删除':'本人确认并交由内核裁决',async()=>{if(root.confirm(c.op==='delete'?'删除本实验内该记忆及受影响派生，清除可控快照原值。原始对话与既有导出不会被删除。确认？':'仅当你已核实这项建议时确认。确认只提供本实验的来源依据，仍须接受内核校验。'))await mutate('decide',{index,confirm:true});}),button('忽略',()=>mutate('dismiss',{index})));
  }ui.conversation.append(row);
 }
 }
 const frame=exp.frames[frameIndex],snapshot=frame?.after||exp.snapshot;ui.memories.replaceChildren();
 if(frame){ui.conversation.append(text('h2','本轮实际变化'));for(const d of frame.decisions)ui.conversation.append(text('p',d.action+'：'+d.reason));for(const kind of ['added','changed','removed'])for(const path of frame.diff[kind]){const [part,key]=path.split('.');const old=frame.before[part]?.[key]?.value,next=frame.after[part]?.[key]?.value;ui.conversation.append(text('p',`${key}：${old??'未记录 / 已清除'} → ${next??'退出 / 已清除'}`));}}
 for(const [part,group]of Object.entries(snapshot))for(const [key,p]of Object.entries(group)){const b=button(`${key}：${p.value} · ${root.MemoryModel.states[part]?.name||part}`,()=>{selected=key;details(key,p);const n=currentModel()?.nodes.find(n=>n.key===key);if(n){graph?.select(n.id);graph?.focus(n.id);}});ui.memories.append(b);}
 if(!ui.memories.children.length)ui.memories.append(text('p','本轮没有已保存记忆。模型回复不代表写入成功。'));
 if(selected){let p;for(const group of Object.values(snapshot))p||=group[selected];if(p)details(selected,p);else{selected=null;ui.details.textContent='所选记忆已退出当前快照。';}}
 else ui.details.replaceChildren();
 graphData();
}
function currentModel(){if(!exp?.frames.length)return null;return root.MemoryModel.graph({role:exp.role,data:{frames:exp.frames}},frameIndex,{state:ui.filter.value});}
function details(key,p){const f=exp.frames[frameIndex],versions=f?.governance.versions.filter(r=>r.key===key)||[];ui.details.replaceChildren(text('h2',key),text('p',p.value),text('p','来源：'+p.source));const advanced=doc.createElement('details');advanced.append(text('summary','来源、版本与派生记录'),text('pre',JSON.stringify(versions,null,2)));for(const r of versions){const at=exp.frames.findIndex(f=>f.governance.versions.some(v=>v.version_id===r.version_id));if(at>=0)advanced.append(button('查看版本首次登记轮次 '+(at+1),()=>{frameIndex=at;render();}));}ui.details.append(advanced);}
function graphData(){if(ui.graph.hidden)return;const m=currentModel();if(!m){graph?.setData({nodes:[],edges:[],count:0},exp?.role||'LOCAL',{animate:false});graph?.select(null);ui.graphNote.textContent='尚无治理记录，二维记忆列表仍可使用。';return;}if(!graph){try{graph=new root.MemoryGraph.GraphView(ui.graph,{states:root.MemoryModel.states,onSelect:id=>{const n=currentModel()?.nodes.find(n=>n.id===id);if(n){selected=n.key;details(n.key,n.payload||{value:'原值已清除',source:'未记录'});graph?.select(id);}},onUnavailable:m=>{ui.graphNote.textContent=m;}});graph.configure({motion:!root.matchMedia('(prefers-reduced-motion: reduce)').matches,low:false});}catch{ui.graphNote.textContent='WebGL不可用，请使用记忆列表和时间轴。';return;}}
 ui.graphNote.textContent='';graph.setData(m,exp.role,{animate:false});graph.select(selected?m.nodes.find(n=>n.key===selected)?.id:null);graph.resizeToHost();graph.request();}
function createDialog(){
 dialog=doc.createElement('dialog');dialog.className='native-lab';dialog.setAttribute('aria-label','真实模型实验');
 // Static markup only. All model/user text uses textContent.
 dialog.innerHTML=`<header><div><strong>AI Memory Lab</strong><span>真实模型实验</span></div><button id="nl-close" data-idle>返回演示</button></header>
 <div class="native-tools"><select id="nl-experiments" aria-label="已保存实验" data-idle></select><input id="nl-name" aria-label="实验名称" placeholder="实验名称" maxlength="80" data-idle><button id="nl-new" data-idle>新建</button><button id="nl-rename" data-idle>重命名</button><button id="nl-remove" data-idle>删除实验</button><button id="nl-reset" data-idle>重置为新实验</button><details><summary>导出范围</summary><label><input id="nl-export-rules" type="checkbox" checked>守则</label><label><input id="nl-export-memory" type="checkbox" checked>记忆</label><label><input id="nl-export-turns" type="checkbox">对话与候选（可能含私人内容）</label><button id="nl-export" data-idle>导出所选数据</button></details></div>
 <div class="native-settings"><details id="nl-setup" open><summary>模型与实验守则</summary><p>先配置模型，再导入守则并新建实验。所选模型服务会接收本轮输入、守则、获准记忆和适用聊天上下文；默认模型建议不获信任。</p><div class="native-model-form"><label>模型配置<select id="nl-models" data-idle></select></label><label>名称<input id="nl-provider" value="OpenAI" data-idle></label><label>协议<select id="nl-protocol" data-idle><option value="openai">OpenAI / 兼容接口</option><option value="anthropic">Anthropic Claude</option><option value="gemini">Google Gemini</option></select></label><label>Base URL<input id="nl-base" value="https://api.openai.com/v1" data-idle></label><label>模型 ID<input id="nl-model" placeholder="输入供应商支持的模型 ID" data-idle></label><label>API Key<input id="nl-key" type="password" autocomplete="off" data-idle></label><label><input id="nl-save-key" type="checkbox" data-idle>保存到系统凭据库</label><button id="nl-profile-save" data-idle>保存配置</button><button id="nl-test" data-idle>测试连接（可能计费）</button><label><input id="nl-stream" type="checkbox" checked data-idle>流式回复</label><button id="nl-profile-delete" data-idle>删除配置</button><button id="nl-profile-new" data-idle>新配置</button></div><label>用于新实验的守则<textarea id="nl-rules" rows="5" data-idle></textarea></label><button id="nl-rules-import" data-idle>导入 Markdown</button><p>旧实验始终保留原守则。此处编辑只影响随后新建的实验；不会覆盖旧实验。尚未实现自然语言级全规则保证、多轮组合敏感性检测及平台身份认证。</p></details></div>
 <p id="nl-policy" class="native-policy"></p><div id="nl-status" role="status" aria-live="polite"></div><button id="nl-recover" data-idle hidden>结束上次中断请求并恢复</button>
 <div class="native-workspace"><section><div class="native-view"><button id="nl-chat-view">记忆演化</button><button id="nl-graph-view">三维图谱</button><select id="nl-filter" aria-label="记忆状态筛选"><option value="all">全部状态</option><option value="current">当前</option><option value="pending">待核实</option><option value="history">历史</option><option value="retired">已退出</option></select><button id="nl-fit">全景</button><span id="nl-graph-note"></span></div><div id="nl-conversation" class="native-conversation"></div><div id="nl-graph" class="native-graph" hidden></div></section><aside><h2>本轮记忆</h2><div id="nl-memories"></div><div id="nl-details"></div></aside></div>
 <footer><div class="native-round"><span id="nl-round"></span><input id="nl-position" type="range" min="0" max="0" value="0" aria-label="实验轮次"></div><form id="nl-composer"><textarea id="nl-input" rows="2" aria-label="发送给模型的消息" placeholder="输入消息；Enter 发送，Shift + Enter 换行" data-idle></textarea><button id="nl-send" data-idle>发送</button><button id="nl-cancel" type="button" disabled>取消请求</button></form><small>记忆操作先经本人确认或隔离，再由 Python 内核裁决。保存成功后才更新界面。删除记忆不等于删除原始聊天。</small></footer>`;
 doc.body.append(dialog);
 for(const id of ['close','experiments','name','new','rename','remove','reset','export','models','provider','protocol','base','model','key','save-key','profile-save','test','profile-delete','profile-new','rules','rules-import','setup','policy','status','recover','chat-view','graph-view','filter','fit','graph-note','conversation','graph','memories','details','position','round','composer','input','send','cancel','stream'])ui[id.replace(/-([a-z])/g,(_,c)=>c.toUpperCase())]=dialog.querySelector('#nl-'+id);
 dialog.addEventListener('keydown',e=>e.stopPropagation());dialog.addEventListener('cancel',e=>{e.preventDefault();if(!running?.busy)leave();});
 const bind=(name,fn)=>ui[name].addEventListener('click',()=>guard(fn));
 bind('close',leave);bind('new',async()=>{exp=await call({op:'create',name:ui.name.value||'未命名实验',rules:ui.rules.value});frameIndex=0;selected=null;render();await libraries();});
 bind('rename',()=>mutate('rename',{name:ui.name.value}));
 bind('remove',async()=>{if(exp&&root.confirm('永久删除本机这一实验及对话、记忆数据库？已有外部导出不会被删除。')){await call({op:'remove',id:exp.id});exp=null;selected=null;graph?.dispose();graph=null;ui.memories.replaceChildren();ui.details.replaceChildren();render();await libraries();}});
 bind('reset',async()=>{if(!exp||!root.confirm('保留原实验，新建同守则的空实验？'))return;exp=await call({op:'create',name:exp.name+' · 重置',rules:exp.rules.text});frameIndex=0;selected=null;render();await libraries();});
 ui.experiments.onchange=()=>guard(()=>open(ui.experiments.value));
 ui.protocol.onchange=()=>{ui.base.value={openai:'https://api.openai.com/v1',anthropic:'https://api.anthropic.com/v1',gemini:'https://generativelanguage.googleapis.com/v1beta'}[ui.protocol.value];};
 ui.models.onchange=()=>{profileId=ui.models.value;const p=profiles.find(x=>x.id===profileId);ui.key.value='';ui.saveKey.checked=false;if(p){ui.provider.value=p.name;ui.protocol.value=p.protocol;ui.base.value=p.base_url;ui.model.value=p.model;}};
 bind('profileNew',()=>{profileId=null;ui.models.value='';ui.key.value='';ui.saveKey.checked=false;notice('填写新配置并保存。');});
 bind('profileSave',async()=>{const id=profileId||root.crypto.randomUUID().replaceAll('-','');await invoke('save_profile',{id,profile:{name:ui.provider.value,protocol:ui.protocol.value,base_url:ui.base.value,model:ui.model.value},key:ui.key.value,persist:ui.saveKey.checked});profileId=id;ui.key.value='';await libraries();notice('配置已保存。临时 Key 仅在本次应用进程有效。');});
 bind('profileDelete',async()=>{if(!profileId)return;if(root.confirm('删除模型配置及系统中保存的对应 Key？')){await invoke('delete_profile',{id:profileId});profileId=null;await libraries();notice('配置已删除。');}});
 bind('test',async()=>{if(!profileId)throw Error('请先保存模型配置');busy(true);const rid=root.crypto.randomUUID();try{running={busy:true,stop:()=>invoke('cancel_model',{requestId:rid})};await model(profileId,rid,'Reply briefly.',[{role:'user',content:'Reply OK.'}],false,()=>{});notice('连接测试成功，供应商已返回文本。该测试可能计费。');}finally{running=null;busy(false);}});
 bind('rulesImport',async()=>{const value=await invoke('import_rules');if(value!==null)ui.rules.value=value;});
 bind('recover',()=>mutate('abort',{request_id:exp.pending.request_id,status:'interrupted'}));
 bind('export',async()=>{if(!exp)throw Error('请先打开实验');const sections=['rules','memory','turns'].filter(x=>dialog.querySelector('#nl-export-'+x).checked);if(!sections.length)throw Error('请选择导出范围');notice(await invoke('export_experiment',{id:exp.id,sections})?'已保存所选实验数据。':'已取消导出。');});
 bind('chatView',()=>{ui.graph.hidden=true;ui.conversation.hidden=false;graph?.setPaused(true);});bind('graphView',()=>{ui.conversation.hidden=true;ui.graph.hidden=false;graphData();graph?.setPaused(false);});bind('fit',()=>graph?.reset());ui.filter.onchange=graphData;
 ui.position.oninput=()=>{frameIndex=Number(ui.position.value);render();};
 ui.composer.onsubmit=e=>{e.preventDefault();guard(async()=>{if(!exp)throw Error('请新建实验');const profile=profiles.find(x=>x.id===profileId);if(!profile)throw Error('请选择模型配置');const input=ui.input.value;if(!input.trim())return;busy(true);let streamed='';running=runner({call,model,cancel:requestId=>invoke('cancel_model',{requestId}),onText:piece=>{streamed+=piece;ui.conversation.textContent=streamed;}});try{notice('正在请求模型；尚未提交记忆。');exp=await running.send(exp,{...profile,stream:ui.stream.checked},input);ui.input.value='';frameIndex=exp.frames.length-1;render();notice('对话已保存。请逐项确认、隔离或忽略模型建议，再开始下一轮。');}finally{running=null;busy(false);if(exp){exp=await call({op:'open',id:exp.id});frameIndex=exp.frames.length-1;render();}}});};
 ui.input.onkeydown=e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing){e.preventDefault();ui.composer.requestSubmit();}};
 bind('cancel',()=>running?.stop());
}
function leave(){if(running?.busy)throw Error('请先取消请求或等待结束');graph?.dispose();graph=null;dialog.close();entry.focus();}
root.addEventListener('pagehide',()=>{running?.stop();graph?.dispose();graph=null;});
entry.onclick=()=>guard(async()=>{if(!dialog)createDialog();root.dispatchEvent(new Event('memory-native-open'));dialog.showModal();if(!exp)ui.rules.value=await invoke('default_rules');await libraries();render();});
})(typeof window!=='undefined'?window:globalThis);
