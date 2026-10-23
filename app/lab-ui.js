(function(root){
'use strict';
const W=root.MemoryWorkspace,S=root.MemorySandbox,P=root.MemoryPlatform,D=root.document;
if(!W||!S||!P)return;
const $=id=>D.getElementById(id),panel=$('experiment-panel');let session=null,saved=null;
const value=id=>$('lab-'+id).value;
function replace(){W.replace(session.dataset(value('actor')));$('lab-date').value=session.date;}
function reset(){for(const [id,v]of Object.entries({actor:'RESEARCHER_A',owner:'RESEARCHER_A',action:'ADD',project:'default',key:'preference',value:'',parents:'',source:'owner_direct',kind:'fact',privacy:'private',effective:'',expires:'',due:''}))$('lab-'+id).value=v;$('lab-confirmed').checked=false;$('lab-export-history').checked=false;session=S.create(root.REPLAY_DATA.policy);replace();$('lab-result').textContent='空白实验已就绪；新增内容只影响本次内存。';}
$('enter-experiment').addEventListener('click',()=>{if(session)return;W.pause();saved={dataset:W.dataset,index:W.index,view:W.viewName,selected:W.selected,filters:W.filters};panel.hidden=false;$('enter-experiment').setAttribute('aria-pressed','true');reset();W.view('graph');$('lab-value').focus?.();});
$('reset-experiment').addEventListener('click',()=>{if(session){for(const id of ['value','parents'])$('lab-'+id).value='';$('lab-confirmed').checked=false;reset();}});
$('leave-experiment').addEventListener('click',()=>{if(!session)return;W.pause();session=null;panel.hidden=true;$('enter-experiment').setAttribute('aria-pressed','false');const old=saved;saved=null;W.restore(old.dataset,old.index,old.selected,old.filters);W.view(old.view);$('lab-value').value='';$('lab-parents').value='';$('lab-confirmed').checked=false;$('enter-experiment').focus?.();});
$('lab-use-selected').addEventListener('click',()=>{if(!session||!W.authorized)return;const n=root.MemoryModel.graph(W.dataset,W.index).nodes.find(n=>n.id===W.selected);if(!n?.evidence||!n.payload){$('lab-result').textContent='请先选择一条仍有载荷的记忆；派生准入会在执行时重新核验。';return;}$('lab-parents').value=n.evidence.version_id;$('lab-result').textContent='已设置依据；请给派生记忆使用一个新字段，并填写其内容。';});
$('lab-action').addEventListener('change',()=>{if(['DERIVE','ADVANCE','REBUILD'].includes(value('action')))$('lab-action').closest?.('form')?.querySelector?.('.lab-advanced')?.setAttribute('open','');});
$('lab-actor').addEventListener('change',()=>{if(session){W.pause();for(const id of ['value','parents','effective','expires','due'])$('lab-'+id).value='';$('lab-confirmed').checked=false;$('lab-export-history').checked=false;replace();$('lab-result').textContent='已切换当前角色；上一角色输入已清空，不自动共享记忆。';}});
$('experiment-form').addEventListener('submit',event=>{event.preventDefault();if(!session)return;if(!W.authorized){$('lab-result').textContent='当前展示视角无操作权限；请选择授权视角再实验。';return;}try{
 const r=session.apply({action:value('action'),actor:value('actor'),owner:value('owner'),key:value('key'),project:value('project'),value:value('value'),source:value('source'),kind:value('kind'),privacy:value('privacy'),effective:value('effective'),expires:value('expires'),due:value('due'),date:value('date'),parents:value('parents').split(',').map(v=>v.trim()).filter(Boolean),confirmed:$('lab-confirmed').checked});
 W.replace(r.dataset);$('lab-result').textContent=r.action+' · '+r.reason+(r.result?' 准入 '+r.result.allowed_ids.length+' 项；限制 '+r.result.denied.length+' 项。':'');$('lab-date').value=r.date;$('lab-confirmed').checked=false;
 }catch(err){$('lab-result').textContent='操作未执行，状态保留：'+err.message;}});
$('permission').addEventListener('change',()=>{if(session&&!W.authorized){$('lab-value').value='';$('lab-parents').value='';$('lab-result').textContent='当前展示视角不披露实验内容、准入数量或导出数据。';}});
$('lab-export').addEventListener('click',async()=>{if(!session)return;if(!W.authorized){$('lab-result').textContent='当前展示视角无导出权限。';return;}try{const bytes=session.exportSelected(value('actor'),{history:$('lab-export-history').checked});$('lab-result').textContent=await P.save(bytes,'memory-lab-experiment.json');}catch(err){$('lab-result').textContent='导出失败，实验状态保留。';}});
// 仅保存是否看过一句介绍；从不保存实验内容。
let seen=false;try{seen=root.localStorage?.getItem('memory-lab.intro-seen')==='1';}catch{}
$('welcome').hidden=seen;
$('welcome-start').addEventListener('click',()=>{$('welcome').hidden=true;try{root.localStorage?.setItem('memory-lab.intro-seen','1');}catch{} $('play').focus?.();});
const leave=()=>{if(session)W.restore(root.MemoryModel.adapt(root.REPLAY_DATA));session=null;saved=null;panel.hidden=true;$('enter-experiment').setAttribute('aria-pressed','false');$('lab-value').value='';$('lab-parents').value='';};root.addEventListener('memory-native-sample',leave);root.addEventListener('pagehide',leave,{once:true});
})(window);
