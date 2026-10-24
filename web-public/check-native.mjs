// Atomic coordinator checks; no browser, GUI, external API or credentials.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);globalThis.MemoryModel=require('./model.js');
const demo=require('./src/public-demo.json');
const withHash=structuredClone(demo);withHash.data.policy.sha256='a'+'1234567890123'+'b'.repeat(50);if(withHash.policy)withHash.policy.sha256=withHash.data.policy.sha256;assert.equal(globalThis.MemoryModel.adapt(withHash).data.policy.sha256,withHash.data.policy.sha256);
const secret=structuredClone(withHash);secret.data.frames[0].input='1234567890123';assert.throws(()=>globalThis.MemoryModel.adapt(secret),/敏感/);
const {runner,extracted,ruleDraft}=require('./native-ui.js');
if(existsSync(new URL('../tools/desktop_service.py',import.meta.url))){
 const builtinText=await readFile(new URL('../memory-rules.md',import.meta.url),'utf8');
 const policy=await ruleDraft(builtinText,'memory-rules.md','builtin');
 assert.equal(policy.sha256,(await import('node:crypto')).createHash('sha256').update(builtinText).digest('hex'));
 assert.equal(policy.text,builtinText);assert.equal(policy.source.kind,'builtin');
}
for(const text of ['', ' '.repeat(10),'a'.repeat(100001)])await assert.rejects(()=>ruleDraft(text,'bad.md','custom'),/守则/);
assert.throws(()=>extracted('{"candidates":[],"candidates":[{}]}'),/重复/);
assert.throws(()=>extracted('{"candidates":[],"__proto__":{}}'));
let ops=[],saved=[],text='';
const pending={revision:2,prompt:{system:'application boundary',rules:{text:'custom experiment rules',sha256:'a'.repeat(64)},messages:[{role:'user',content:'test'}],extraction:'extract',allowed:[]}};
let release;const gate=new Promise(r=>release=r);
const call=async q=>{ops.push(q.op);if(q.op==='prepare')return pending;if(q.op==='validate_candidates')return q.candidates;if(q.op==='finish'){saved.push(q);return {id:'experiment',revision:3};}return {};};
const profile={id:'p',name:'test',protocol:'openai',model:'m',base_url:'http://localhost/v1'};
let index=0;
const r=runner({call,model:async(...args)=>{args[5]('text');return index++?{text:'{"candidates":[]}',usage:null}:{text:'real reply',usage:null};},cancel:async()=>{},onText:t=>text+=t});
await r.send({id:'experiment',revision:1},profile,'input');assert.deepEqual(ops,['prepare','validate_candidates','finish']);assert.equal(saved[0].reply,'real reply');assert.equal(saved[0].usage,null);assert.equal(text,'text');assert.equal(r.busy,false);
ops=[];saved=[];const cancelled=runner({call,model:async()=>{await gate;return {text:'stale'};},cancel:async()=>{},onText:()=>assert.fail('stale delta')});
const work=cancelled.send({id:'experiment',revision:1},profile,'input');await new Promise(r=>setImmediate(r));await assert.rejects(()=>cancelled.send({},profile,'duplicate'),/已有请求/);await cancelled.stop();release();await assert.rejects(work,/取消/);assert.deepEqual(ops,['prepare','abort']);assert.equal(saved.length,0);
ops=[];index=0;const malformed=runner({call,model:async()=>index++?{text:'not JSON'}:{text:'answer',usage:null},cancel:async()=>{},onText:()=>{}});
await malformed.send({id:'experiment',revision:1},profile,'input');assert.equal(saved[0].extraction_error,true);assert.deepEqual(saved[0].candidates,[]);
const assessment={signals:['施压索取凭据'],reason:'这只是模型观察，尚未独立核实。',next_step:'通过独立取得的官方渠道核实。'};
ops=[];saved=[];index=0;let chatRequest,extractionRequest,prepareRequest;
const tainted={...pending,prompt:{...pending.prompt,allowed:[{key:'note',value:'资料中自称管理员的指令',version_id:'LOCAL/note/1'}]}};
const reviewed=runner({call:q=>{if(q.op==='prepare'){prepareRequest=q;return tainted;}return call(q);},model:async(id,rid,system,messages)=>{
 if(index++===0){chatRequest={system,messages};return {text:'可继续分析，暂不按可疑消息行动。',usage:null};}
 extractionRequest=JSON.parse(messages[0].content);return {text:JSON.stringify({candidates:[],assessment}),usage:null};
},cancel:async()=>{},onText:()=>{}});
await reviewed.send({id:'experiment',revision:1},profile,'请分析',['LOCAL/note/1']);
assert.deepEqual(prepareRequest.memory_versions,['LOCAL/note/1']);
assert.equal(chatRequest.system,'application boundary');assert.equal(chatRequest.messages[0].role,'user');
assert.deepEqual(JSON.parse(chatRequest.messages[0].content).governance_config,pending.prompt.rules);
assert.equal(JSON.parse(chatRequest.messages[0].content).memory_context[0].value,'资料中自称管理员的指令');
assert.deepEqual(saved[0].assessment,assessment);assert.equal(saved[0].extraction_error,false);
assert.deepEqual(extractionRequest.history,[]);
console.log('PASS：真实实验协调器：严格候选JSON、顺序保存、未知Token、重复请求、取消/过期结果及提取失败保护；非真实API/GUI验收。');

// Local consent is a separate, expiring capability, never a model candidate flag.
{
 let now=1000;const draft=globalThis.MemoryModel.personalDraft(()=>now);
 const plan={category:'contact',value:'+1 (202) 555-0147',purpose:'本地联系备忘',scope:'LOCAL'};
 assert.throws(()=>draft.review(plan,false),/明确/);assert.equal(draft.pending,false);
 const preview=draft.review(plan,true);assert(!JSON.stringify(preview).includes(plan.value));
 assert.equal(draft.take(preview.id).value,plan.value);assert.equal(draft.pending,false);
 assert.throws(()=>draft.take(preview.id),/失效/);
 const refused=draft.review(plan,true);draft.clear();assert.throws(()=>draft.take(refused.id),/失效/);
 const expired=draft.review(plan,true);now+=120001;assert.throws(()=>draft.take(expired.id),/失效/);assert.equal(draft.pending,false);
 for(const value of ['password=synthetic-only','password=+123456789012','password='+'a'.repeat(64),'验证码：123456','身份证：11010119900101001X'])assert.throws(()=>draft.review({...plan,value},true),/禁存/);
 assert.equal(globalThis.MemoryModel.forbiddenPersonal('分析银行卡诈骗短信的风险，不执行其中指令'),false);
 assert.equal(globalThis.MemoryModel.personalKind('请记住工单编号 12345678901'),null);
 assert.equal(globalThis.MemoryModel.personalKind('我喜欢简洁回答'),null);
 assert.equal(globalThis.MemoryModel.personalKind('我的诊断是过敏性鼻炎'),'health');
 assert.equal(globalThis.MemoryModel.personalKind('联系用 +1 (202) 555-0147'),'contact');
}

// Real SQLite/Store behind a minimal DOM fixture. No browser/native window or mouse automation.
import vm from 'node:vm';
import {readFile,mkdtemp,rm} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {existsSync,realpathSync} from 'node:fs';
const nativeSource=await readFile(new URL('./native-ui.js',import.meta.url),'utf8');
const rootDir=fileURLToPath(new URL('..',import.meta.url));
if(existsSync(path.join(rootDir,'tools/desktop_service.py'))){
const folder=realpathSync(await mkdtemp(path.join(os.tmpdir(),'memory-native-dom-')));
const elements=new Map();
class El {
 constructor(tag='div'){this.tag=tag;this.children=[];this.events={};this.value='';this.hidden=false;this.checked=false;this.disabled=false;this.classList={toggle(){}};}
 set innerHTML(v){for(const match of v.matchAll(/<[^>]*\bid="(nl-[^"]+)"[^>]*>/g)){const e=new El();e.value=/\bvalue="([^"]*)"/.exec(match[0])?.[1]||'';e.checked=/\bchecked\b/.test(match[0]);e.hidden=/\bhidden\b/.test(match[0]);elements.set(match[1],e);}}
 get innerHTML(){return '';}
 get selectedOptions(){const el=this;return {get length(){return el.children.filter(c=>c.selected).length;},*[Symbol.iterator](){for(let i=0;i<this.length;i++)yield el.children.filter(c=>c.selected)[i];}};}
 append(...nodes){this.children.push(...nodes);}replaceChildren(...nodes){this.children=[...nodes];}
 addEventListener(k,fn){(this.events[k]??=[]).push(fn);}setAttribute(){}focus(){}showModal(){this.open=true;}close(){this.open=false;}
 querySelector(id){return elements.get(id.slice(1));}querySelectorAll(){return [...elements.values()];}
 async click(){if(this.onclick)await this.onclick();for(const f of this.events.click||[])await f();}
}
let currentProfiles=[];let requests=0,dispose=0;let holdOpen=null;let savedProfileKey;let failFinish=false,failOpen=false,loseDecideReply=false,imported=null;
const preferences=new Map(),windowEvents={};let sampleData=null;
let lastPrepared;
const service=q=>{const value=JSON.parse(execFileSync(process.env.MEMORY_LAB_PYTHON||'python3',['-B','-m','tools.desktop_service',folder],{cwd:rootDir,input:JSON.stringify(q),encoding:'utf8'})).result;if(q.op==='prepare')lastPrepared=value;return value;};
const originalEntry=new El('button');originalEntry.hidden=true;const graphInstance={setData(m){this.model=m;},configure(){},resizeToHost(){},request(){},setPaused(){},select(id){this.selected=id;},focus(){},reset(){},dispose(){dispose++;}};
const timers=new Map();let timerId=0;
const win={setTimeout:fn=>{timers.set(++timerId,fn);return timerId;},clearTimeout:id=>timers.delete(id),document:{readyState:'loading',body:new El('body'),createElement:tag=>new El(tag),getElementById:id=>id==='native-open'?originalEntry:null},MemoryModel:globalThis.MemoryModel,REPLAY_DATA:demo,MemoryWorkspace:{restore:data=>sampleData=data,view(){}},localStorage:{getItem:k=>preferences.get(k),setItem:(k,v)=>preferences.set(k,v)},MemoryGraph:{GraphView:function(host,options){graphInstance.options=options;return graphInstance;}},crypto:globalThis.crypto,matchMedia:()=>({matches:true}),dispatchEvent(){},addEventListener:(type,handler)=>windowEvents[type]=handler,confirm:()=>true,__TAURI__:{core:{Channel:class{},invoke:async(command,args)=>{
 if(command==='default_rules')return '测试守则：候选隔离，明确确认后裁决。';
 if(command==='import_rules'){if(imported instanceof Error)throw imported;return imported;}
 if(command==='experiment_call'){if(args.request.op==='profiles')return currentProfiles;if(args.request.op==='open'&&holdOpen)await holdOpen;if(args.request.op==='finish'&&failFinish)throw Error('实验保存失败样本');if(args.request.op==='open'&&failOpen)throw Error('实验重读失败样本');const saved=service(args.request);if(args.request.op==='decide'&&loseDecideReply){loseDecideReply=false;throw Error('裁决已提交但回复丢失样本');}return saved;}
 if(command==='save_profile'){savedProfileKey=args.key;currentProfiles=[{id:args.id,...args.profile}];return;}
 if(command==='model_request'){requests++;if(args.stream){args.onDelta.onmessage('实际响应样本');return {text:'实际响应样本',usage:null};}return {text:JSON.stringify({candidates:[{op:'set',key:'preference',value:requests>2?'详细回答':'简洁回答',basis:'self_report',evidence:{source:'current_input',quote:JSON.parse(args.messages[0].content).input}}],assessment}),usage:null};}
 if(command==='cancel_model')return;
 throw Error('Unexpected command '+command);
 }}}};
try{
 vm.runInNewContext(nativeSource,{window:win,globalThis:win,TextEncoder,Option:class extends El{constructor(label,value){super();this.textContent=label;this.value=value;}},Event:class{}});
 assert.equal(originalEntry.hidden,false);assert.doesNotThrow(()=>windowEvents.pagehide());await windowEvents.load();
 const e=name=>elements.get('nl-'+name);
 assert(e('rules-selected').textContent.includes(await ruleDraft('测试守则：候选隔离，明确确认后裁决。','memory-rules.md','builtin').then(p=>p.sha256)));
 assert.equal(e('setup').hidden,false);assert.equal(e('workspace').hidden,true);
 assert.equal(e('remove').disabled,true);
 assert.equal(e('guide').hidden,false);await e('guide-skip').click();assert.equal(e('guide').hidden,true);
 await e('help').click();for(let i=0;i<4;i++){await e('guide-action').click();await e('guide-next').click();}assert.equal(e('guide').hidden,true);
 assert.equal(requests,0,'help must never call a model');assert.equal(service({op:'list'}).length,0,'help must not create experiments');
 e('name').value='最小DOM实验';await e('new').click();assert.equal(service({op:'list'}).length,1);
 assert.equal(e('setup').hidden,true);assert.equal(e('workspace').hidden,false);
 e('provider').value='Mock';e('protocol').value='openai';e('base').value='http://localhost/v1';e('model').value='test';e('key').value='TEMP_KEY';await e('profile-save').click();assert.equal(e('key').value,'');
 e('model').value='edited-model';await e('profile-save').click();assert.equal(savedProfileKey,null,'editing metadata with blank key must preserve the existing credential');
 e('input').value='请记住我喜欢简洁回答';e('stream').checked=true;
 await e('composer').onsubmit({preventDefault(){}}); // handler starts its async guard
 const rows=service({op:'list'});let exp=service({op:'open',id:rows[0].id});assert.equal(exp.turns.length,1);assert.equal(exp.turns[0].reply,'实际响应样本');assert.equal(exp.frames.length,1);assert.equal(exp.snapshot.current.preference,undefined);assert.equal(e('send').disabled,true);e('position').oninput();assert.equal(e('send').disabled,true,'timeline refresh must not bypass unresolved candidates');
 assert(e('conversation').children.some(x=>x.textContent==='模型建议 1 项 · 已记录裁决 0 项 · 待处理 1 项'),'the round summary must separate proposals from saved decisions');
 assert.deepEqual(exp.turns[0].assessment,assessment);
 const riskPanel=e('conversation').children.find(x=>x.children?.some(c=>c.textContent==='模型风险观察 · 未经独立核实'));
 assert(riskPanel?.open);assert(riskPanel.children.some(c=>c.textContent===assessment.reason));
 const candidate=e('conversation').children.find(x=>x.className==='native-candidate');assert(candidate);const confirm=candidate.children.find(x=>x.textContent==='确认这是本人直接陈述或本人意图');assert(confirm);assert(candidate.children.some(n=>n.textContent==='请记住我喜欢简洁回答'),'show the actual source quotation');assert(candidate.children.some(n=>n.textContent?.includes('模型分类：本人陈述')));loseDecideReply=true;await confirm.click();
 assert(e('status').textContent.includes('裁决已提交但回复丢失样本'),'keep the operation error while reloading the actual committed result');
 exp=service({op:'open',id:rows[0].id});assert.equal(exp.snapshot.current.preference.value,'简洁回答');assert.equal(e('memories').children.length,1);
 assert.equal(e('context').children.length,1);assert.equal(e('context').selectedOptions.length,0,'model context must be opt-in');
 assert(e('context-summary').textContent.includes('下次发送不附带长期记忆。'));
 e('context').children[0].selected=true;
 e('context').onchange();assert(e('context-summary').textContent.includes('1 条'));
 assert(e('conversation').children.some(x=>x.textContent==='模型建议 1 项 · 已记录裁决 1 项 · 待处理 0 项'),'saved governance decisions must update the visible round summary');
 e('filter').value='all';await e('graph-view').click();assert.equal(graphInstance.model.nodes[0].payload.value,'简洁回答');e('position').value='0';e('position').oninput();assert.equal(graphInstance.model.nodes[0].payload.value,'简洁回答');
 await e('memories').children[0].click();assert(e('details').children.length>0);
 // A current fact and isolated candidate of the same field must select different versions.
 e('input').value='也许我需要详细回答';await e('composer').onsubmit({preventDefault(){}});
 assert.equal(lastPrepared.pending.admission.memories.length,1,'send the explicitly selected version through core admission');
 assert(e('context-summary').textContent.includes('本轮请求附带 1 条记忆'));
 assert(e('context-summary').textContent.includes('下次发送不附带长期记忆。'));
 assert.equal(e('context').selectedOptions.length,0,'memory authorization is per request, not silently reused');
 // Use the actual core to isolate the second proposal, then reopen via the real handler.
 let conflict=service({op:'open',id:rows[0].id});
 conflict=service({op:'decide',id:conflict.id,revision:conflict.revision,index:0,confirm:false});
 e('experiments').value=conflict.id;await e('experiments').onchange();
 const pendingNode=graphInstance.model.nodes.find(n=>n.part==='pending');
 assert(pendingNode,'the unconfirmed proposal must have a pending node');
 await e('memories').children.find(b=>b.textContent.includes('待核实')).click();
 assert.equal(graphInstance.selected,pendingNode.id,'select the candidate version, not the same-key current fact');
 e('filter').value='pending';e('filter').onchange();
 assert.equal(e('memories').children.length,1,'graph filter must apply to the graph workspace');
 await e('evolution-view').click();
 assert.equal(e('memories').children.length,2,'a hidden graph filter must not remove current facts from the evolution snapshot');
 await e('chat-view').click();assert.equal(e('memories').children.length,2);
 await e('graph-view').click();assert.equal(e('filter').value,'pending');assert.equal(e('memories').children.length,1);
 e('filter').value='all';e('filter').onchange();
 e('rules').value='下一实验的新守则草稿';e('name').value='新的名称草稿';e('position').oninput();assert.equal(e('name').value,'新的名称草稿','view refresh must not discard an experiment-name draft');assert.equal(e('rules').value,'下一实验的新守则草稿','view refresh must not discard an unsaved rules draft');

 let historical=service({op:'open',id:rows[0].id});
 const hp=service({op:'prepare',id:historical.id,revision:historical.revision,input:'明确更正并保留历史',request_id:'history',model:{}});
 historical=service({op:'finish',id:hp.id,revision:hp.revision,request_id:'history',reply:'样本回复',candidates:[{op:'set',key:'preference',value:'新的长期偏好',archive_old:true,current_correction:true,basis:'self_report',evidence:{source:'current_input',quote:'明确更正并保留历史'}}]});
 historical=service({op:'decide',id:historical.id,revision:historical.revision,index:0,confirm:true,source_confirmation:{round:historical.turns.length,index:0,evidence:historical.turns.at(-1).candidates[0].evidence,candidate:historical.turns.at(-1).candidates[0]}});
 e('experiments').value=historical.id;await e('experiments').onchange();
 assert(Object.keys(historical.snapshot.history).length,'fixture must contain a stored history alias: '+JSON.stringify(historical.snapshot));
 assert(e('memories').children.some(b=>b.textContent.includes('旧版本')),'history list missing: '+e('memories').children.map(b=>b.textContent).join('|'));
 await e('memories').children.find(b=>b.textContent.includes('旧版本')).click();
 const evidence=e('details').children.find(x=>x.tag==='details').children.find(x=>x.tag==='pre').textContent;
 assert(evidence.includes('version_id'),'history aliases must resolve their actual registered evidence');
 let releaseOpen;holdOpen=new Promise(resolve=>releaseOpen=resolve);
 e('experiments').value=rows[0].id;const opening=e('experiments').onchange();
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(e('new').disabled,true,'opening an experiment must lock competing mutations');
 releaseOpen();await opening;holdOpen=null;
 // Reopening a prepared request must show its actual input, not only the last saved turn.
 let interrupted=service({op:'open',id:rows[0].id});
 interrupted=service({op:'prepare',id:interrupted.id,revision:interrupted.revision,input:'重启前尚未完成的输入',request_id:'interrupted-preview',model:{}});
 e('experiments').value=interrupted.id;await e('experiments').onchange();
 assert.equal(e('recover').hidden,false);
 assert(e('conversation').children.some(n=>n.textContent==='重启前尚未完成的输入'),'show the real pending input before offering recovery');
 await e('recover').click();
 assert.equal(service({op:'open',id:interrupted.id}).pending,null);
 assert.equal(e('recover').hidden,true);
 e('name').value='新的空实验';const beforeDraft=service({op:'list'});await e('new').click();
 assert.deepEqual(service({op:'list'}),beforeDraft,'unconfirmed edited rules must not silently become an experiment policy');
 assert(e('status').textContent.includes('预览并确认'));
 await e('rules-undo').click();await e('new').click();assert.equal(graphInstance.model.nodes.length,0,'切到空实验必须清除旧图谱');assert.equal(e('details').children.length,0,'空实验不能保留旧实验详情');
 assert.equal(e('context').children.length,0,'another experiment must not inherit selected memory versions');
 // A complete provider reply must remain visible as unsaved when the catalog fails.
 failFinish=true;e('input').value='保存失败时保留输入';
 await e('composer').onsubmit({preventDefault(){}});
 assert.equal(e('live').hidden,false,'do not discard the received reply when persistence fails');
 assert(e('live').children.some(n=>n.textContent.includes('未确认保存')),'failed replies must never look like saved results');
 assert.equal(e('input').value,'保存失败时保留输入');
 assert(e('status').textContent.includes('实验保存失败样本'));
 failOpen=true;await e('composer').onsubmit({preventDefault(){}});
 // The submit handler returns the guard so state/error checks need no timing guess.
 assert(e('status').textContent.includes('实验保存失败样本'),'recovery failure must not hide the original save error');
 assert(e('status').textContent.includes('实验重读失败样本'));
 assert.equal(e('send').disabled,true,'an unknown saved revision must not remain actionable');
 assert.equal(e('details').children.length,0,'failed recovery must not retain stale memory details');
 assert.equal(e('memories').children.length,0,'failed recovery must not retain an unverified snapshot');
 failFinish=false;failOpen=false;
 e('name').value='失败后独立新实验';await e('new').click();
 assert.equal(e('live').hidden,true,'a new experiment must not display another experiment’s transient reply');
 assert.equal(e('live').children.length,0,'remove the old transient preview, not only its visibility');
 graphInstance.destroyed=true;graphInstance.options.onUnavailable('WebGL运行失败，请使用二维记忆列表。');
 e('filter').onchange();
 assert.equal(e('graph-note').textContent,'WebGL运行失败，请使用二维记忆列表。','rerender must retain the runtime WebGL fallback explanation');
 assert.equal(e('fit').disabled,true,'camera controls must remain disabled after the renderer is disposed');
 await e('remove').click();assert.equal(e('policy').textContent,'');assert.equal(e('round').textContent,'尚无对话');assert.equal(e('send').disabled,true);assert.equal(e('details').children.length,0);assert.equal(e('current-rules-text').textContent,'');assert.equal(e('current-rules-hash').textContent,'');
 await e('close').click();assert.equal(dispose,1);assert.equal(service({op:'open',id:rows[0].id}).rules.text,'测试守则：候选隔离，明确确认后裁决。');
 await originalEntry.click();assert.equal(e('guide').hidden,true,'dismissed help must stay dismissed');
 e('experiments').value=rows[0].id;await e('experiments').onchange();const fixed=service({op:'open',id:rows[0].id}).rules;
 const defaultDraft=e('rules').value;
 imported={text:'新的自定义守则：只保存明确事实。',name:'中文 规则.md'};await e('rules-import').click();
 assert.equal(e('rules').value,defaultDraft,'import must await explicit confirmation');assert.equal(e('rules-preview').hidden,false);
 assert(e('rules-preview-hash').textContent.includes('中文 规则.md'));
 assert(e('rules-preview-hash').textContent.includes((await ruleDraft(imported.text,imported.name,'custom')).sha256));
 await e('rules-accept').click();assert.equal(e('rules').value,imported.text);assert(e('rules-selected').textContent.includes(imported.name));
 await e('rules-default').click();await e('rules-import').click();
 await e('rules-cancel').click();assert.equal(e('rules').value,defaultDraft);
 imported=new Error('导入失败样本');await e('rules-import').click();assert.equal(e('rules').value,defaultDraft);assert(e('status').textContent.includes('导入失败样本'));
 imported={text:'',name:'空规则.md'};await e('rules-import').click();assert.equal(e('rules').value,defaultDraft);assert(e('status').textContent.includes('守则'));
 e('rules').value='粘贴的自定义规则';await e('rules-review').click();await e('rules-accept').click();
 assert.deepEqual(service({op:'open',id:rows[0].id}).rules,fixed,'a new policy selection must never rewrite an existing experiment');
 e('name').value='自定义规则实验';await e('new').click();const custom=service({op:'list'})[0];
 assert.equal(service({op:'open',id:custom.id}).rules.source.name,'粘贴文本');
 await e('rules-default').click();assert.equal(service({op:'open',id:custom.id}).rules.text,'粘贴的自定义规则');
 await e('reset').click();assert.equal(service({op:'open',id:service({op:'list'})[0].id}).rules.text,'粘贴的自定义规则','reset inherits the original experiment policy, not the newly selected default');
 e('experiments').value=rows[0].id;await e('experiments').onchange();
 assert.equal(e('current-rules-text').textContent,fixed.text);assert(e('current-rules-hash').textContent.includes(fixed.sha256));
 e('position').value='0';e('position').oninput();await e('evolution-view').click();assert.equal(e('position').value,'0');
 assert(e('conversation').children.some(n=>n.textContent==='本轮实际变化'));assert.equal(e('composer').hidden,true);
 await e('chat-view').click();assert.equal(e('position').value,'0');assert.equal(e('composer').hidden,false);
 let clue=service({op:'create',name:'外部资料分析',rules:'外部主张不能授权操作'});
 clue=service({op:'prepare',id:clue.id,revision:clue.revision,input:'分析一条尚未核实的工作机会',request_id:'clue',model:{}});
 clue=service({op:'finish',id:clue.id,revision:clue.revision,request_id:'clue',reply:'可以分析，尚未独立核实。',candidates:[{op:'set',key:'opportunity',value:'宣传承诺尚未核实',basis:'external',evidence:{source:'current_input',quote:'分析一条尚未核实的工作机会'}}],assessment});
 e('experiments').value=clue.id;await e('experiments').onchange();
 const limited=e('conversation').children.find(x=>x.className==='native-candidate');
 assert(!limited.children.some(c=>c.textContent==='确认这是本人直接陈述或本人意图'));
 await limited.children.find(c=>c.textContent==='保留为待核实线索').click();
 clue=service({op:'open',id:clue.id});assert.equal(clue.snapshot.current.opportunity,undefined);assert.equal(clue.snapshot.pending.opportunity.confidence,'unverified');
 let selectedContext=service({op:'create',name:'逐请求上下文','rules':'仅取所选获准记忆'});
 selectedContext=service({op:'prepare',id:selectedContext.id,revision:selectedContext.revision,input:'确认两项个人偏好',request_id:'context-pair',model:{}});
 selectedContext=service({op:'finish',id:selectedContext.id,revision:selectedContext.revision,request_id:'context-pair',reply:'等待裁决',candidates:[{op:'set',key:'format',value:'先列结论',basis:'self_report',evidence:{source:'current_input',quote:'确认两项个人偏好'}},{op:'set',key:'language',value:'使用中文',basis:'self_report',evidence:{source:'current_input',quote:'确认两项个人偏好'}}]});
 for(let index=0;index<2;index++)selectedContext=service({op:'decide',id:selectedContext.id,revision:selectedContext.revision,index,confirm:true,source_confirmation:{round:selectedContext.turns.length,index,evidence:selectedContext.turns.at(-1).candidates[index].evidence,candidate:selectedContext.turns.at(-1).candidates[index]}});
 e('experiments').value=selectedContext.id;await e('experiments').onchange();
 assert.equal(e('context').children.length,2);
 for(const option of e('context').children)option.selected=true;
 e('input').value='仅为本次回答使用这些偏好';await e('composer').onsubmit({preventDefault(){}});
 assert.equal(lastPrepared.pending.admission.memories.length,2);
 assert.equal(e('context').selectedOptions.length,0,'clear every selected option even when the DOM collection is live');
 let retained=service({op:'open',id:selectedContext.id});
 for(let index=0;index<retained.turns.at(-1).candidates.length;index++)retained=service({op:'dismiss',id:retained.id,revision:retained.revision,index});
 e('experiments').value=retained.id;await e('experiments').onchange();
 assert.equal(e('context-keep').checked,false);
 for(const option of e('context').children)option.selected=true;
 e('context-keep').checked=true;e('input').value='继续按明确选定的两项偏好回答';
 await e('composer').onsubmit({preventDefault(){}});
 assert.equal(lastPrepared.pending.admission.memories.length,2);
 assert.equal(e('context').selectedOptions.length,2,'retain only after explicit opt-in');
 e('experiments').value=clue.id;await e('experiments').onchange();
 assert.equal(e('context-keep').checked,false);assert.equal(e('context').selectedOptions.length,0);
 let unsafeDerived=service({op:'open',id:selectedContext.id});
 for(let index=0;index<unsafeDerived.turns.at(-1).candidates.length;index++)unsafeDerived=service({op:'dismiss',id:unsafeDerived.id,revision:unsafeDerived.revision,index});
 const parent=unsafeDerived.governance.versions.find(v=>v.key==='format').version_id;
 unsafeDerived=service({op:'prepare',id:unsafeDerived.id,revision:unsafeDerived.revision,input:'检查模型的恢复建议，尚未授权恢复',request_id:'unsafe-derived',model:{},memory_versions:[parent]});
 unsafeDerived=service({op:'finish',id:unsafeDerived.id,revision:unsafeDerived.revision,request_id:'unsafe-derived',reply:'模型建议不等于恢复授权',candidates:[{op:'derive',key:'derived_summary',value:'结论摘要',basis:'inference',parents:[parent],reactivate:true,evidence:{source:'memory',version_id:parent,quote:'先列结论'}}]});
 e('experiments').value=unsafeDerived.id;await e('experiments').onchange();
 const unauthorized=e('conversation').children.find(x=>x.className==='native-candidate');
 assert(!unauthorized.children.some(c=>c.textContent==='确认派生并交由内核裁决'),'a derived proposal must not offer authority to restore deleted content');
 await unauthorized.children.find(c=>c.textContent==='核验操作依据').click();
 assert.equal(service({op:'open',id:unsafeDerived.id}).turns.at(-1).results['0'].decisions[0].action,'REJECT');
 // A mere mention is neither a model request nor a consent request.
 const countBeforePrivate=requests,privateExp=service({op:'create',name:'本地私人记忆回归',rules:'仅保存获准内容'});
 e('experiments').value=privateExp.id;await e('experiments').onchange();
 e('input').value='联系用 +1 (202) 555-0147';await e('composer').onsubmit({preventDefault(){}});
 assert.equal(requests,countBeforePrivate);assert.equal(service({op:'open',id:privateExp.id}).privacy_request,undefined);assert.equal(e('input').value,'');
 const reviewPrivate=async()=>{e('personal-category').value='contact';e('personal-value').value='+1 (202) 555-0147';e('personal-purpose').value='本地联系备忘';await e('personal-form').onsubmit({preventDefault(){}});};
 await reviewPrivate();assert.equal(e('personal-value').value,'');assert.equal(e('personal-preview').hidden,false);assert.equal(requests,countBeforePrivate);
 assert(!JSON.stringify(service({op:'open',id:privateExp.id})).includes('+1 (202) 555-0147'));
 await e('personal-preview').children.find(n=>n.textContent==='不保存并清空').click();assert.equal(e('personal-preview').hidden,true);
 await reviewPrivate();for(const fn of [...timers.values()])fn();assert.equal(e('personal-preview').hidden,true);
 await reviewPrivate();await e('personal-preview').children.find(n=>n.textContent==='确认保存此方案').click();
 assert.equal(service({op:'open',id:privateExp.id}).snapshot.current.personal_contact.value,'+1 (202) 555-0147');assert.equal(e('context').children.length,0);assert.equal(requests,countBeforePrivate);
 await e('memories').children[0].click();await e('details').children.find(n=>n.textContent==='删除这条私人记忆').click();
 assert(!JSON.stringify(service({op:'export',id:privateExp.id,sections:['turns','memory']})).includes('+1 (202) 555-0147'));
 await reviewPrivate();await e('close').click();assert.equal(e('personal-preview').hidden,true);await originalEntry.click();
 e('experiments').value=privateExp.id;await e('experiments').onchange();
 const roundsBeforeTemporary=service({op:'open',id:privateExp.id}).turns.length;
 e('temporary').checked=true;e('input').value='我的诊断是过敏性鼻炎';
 await e('composer').onsubmit({preventDefault(){}});
 assert.equal(requests,countBeforePrivate+1,'temporary processing calls only the reply model, not extraction');
 assert.equal(service({op:'open',id:privateExp.id}).turns.length,roundsBeforeTemporary);
 assert(!JSON.stringify(service({op:'export',id:privateExp.id,sections:['turns','memory']})).includes('过敏性鼻炎'));
 assert(e('status').textContent.includes('没有提取候选或保存实验'));assert.equal(e('input').value,'');
 e('input').value='我的健康自述仅在输入框';windowEvents.pagehide();
 assert.equal(e('input').value,'');assert.equal(e('live').children.length,0);assert.equal(e('live').hidden,true);
 const experimentsBeforeSample=service({op:'list'}),callsBeforeSample=requests;
 await e('sample').click();assert.equal(sampleData.mode,'SIMULATED');assert.deepEqual(service({op:'list'}),experimentsBeforeSample);assert.equal(requests,callsBeforeSample);
 console.log('PASS：桌面入口、配置Key清空、两阶段真实内核提交、逐轮快照、图谱数据与详情、退出释放（最小DOM＋实际SQLite/Store；HTTP由夹具替代）。');
}finally{await rm(folder,{recursive:true,force:true});}

}else console.log('NOT_RUN：独立公开Web仓库不含桌面Python服务，仅执行上面的前端协调器检查。');
