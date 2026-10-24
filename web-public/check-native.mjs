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
const pending={revision:2,prompt:{system:'rules',messages:[{role:'user',content:'test'}],extraction:'extract',allowed:[]}};
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
console.log('PASS：真实实验协调器：严格候选JSON、顺序保存、未知Token、重复请求、取消/过期结果及提取失败保护；非真实API/GUI验收。');

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
 append(...nodes){this.children.push(...nodes);}replaceChildren(...nodes){this.children=[...nodes];}
 addEventListener(k,fn){(this.events[k]??=[]).push(fn);}setAttribute(){}focus(){}showModal(){this.open=true;}close(){this.open=false;}
 querySelector(id){return elements.get(id.slice(1));}querySelectorAll(){return [...elements.values()];}
 async click(){if(this.onclick)await this.onclick();for(const f of this.events.click||[])await f();}
}
let currentProfiles=[];let requests=0,dispose=0;let holdOpen=null;let savedProfileKey;let failFinish=false,failOpen=false,loseDecideReply=false,imported=null;
const preferences=new Map(),windowEvents={};let sampleData=null;
const service=q=>JSON.parse(execFileSync(process.env.MEMORY_LAB_PYTHON||'python3',['-B','-m','tools.desktop_service',folder],{cwd:rootDir,input:JSON.stringify(q),encoding:'utf8'})).result;
const originalEntry=new El('button');originalEntry.hidden=true;const graphInstance={setData(m){this.model=m;},configure(){},resizeToHost(){},request(){},setPaused(){},select(id){this.selected=id;},focus(){},reset(){},dispose(){dispose++;}};
const win={document:{readyState:'loading',body:new El('body'),createElement:tag=>new El(tag),getElementById:id=>id==='native-open'?originalEntry:null},MemoryModel:globalThis.MemoryModel,REPLAY_DATA:demo,MemoryWorkspace:{restore:data=>sampleData=data,view(){}},localStorage:{getItem:k=>preferences.get(k),setItem:(k,v)=>preferences.set(k,v)},MemoryGraph:{GraphView:function(host,options){graphInstance.options=options;return graphInstance;}},crypto:globalThis.crypto,matchMedia:()=>({matches:true}),dispatchEvent(){},addEventListener:(type,handler)=>windowEvents[type]=handler,confirm:()=>true,__TAURI__:{core:{Channel:class{},invoke:async(command,args)=>{
 if(command==='default_rules')return '测试守则：候选隔离，明确确认后裁决。';
 if(command==='import_rules'){if(imported instanceof Error)throw imported;return imported;}
 if(command==='experiment_call'){if(args.request.op==='profiles')return currentProfiles;if(args.request.op==='open'&&holdOpen)await holdOpen;if(args.request.op==='finish'&&failFinish)throw Error('实验保存失败样本');if(args.request.op==='open'&&failOpen)throw Error('实验重读失败样本');const saved=service(args.request);if(args.request.op==='decide'&&loseDecideReply){loseDecideReply=false;throw Error('裁决已提交但回复丢失样本');}return saved;}
 if(command==='save_profile'){savedProfileKey=args.key;currentProfiles=[{id:args.id,...args.profile}];return;}
 if(command==='model_request'){requests++;if(args.stream){args.onDelta.onmessage('实际响应样本');return {text:'实际响应样本',usage:null};}return {text:JSON.stringify({candidates:[{op:'set',key:'preference',value:requests>2?'详细回答':'简洁回答'}]}),usage:null};}
 if(command==='cancel_model')return;
 throw Error('Unexpected command '+command);
 }}}};
try{
 vm.runInNewContext(nativeSource,{window:win,globalThis:win,TextEncoder,Option:class extends El{constructor(label,value){super();this.textContent=label;this.value=value;}},Event:class{}});
 assert.equal(originalEntry.hidden,false);await windowEvents.load();
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
 const candidate=e('conversation').children.find(x=>x.className==='native-candidate');assert(candidate);const confirm=candidate.children.find(x=>x.textContent==='本人确认并交由内核裁决');assert(confirm);loseDecideReply=true;await confirm.click();
 assert(e('status').textContent.includes('裁决已提交但回复丢失样本'),'keep the operation error while reloading the actual committed result');
 exp=service({op:'open',id:rows[0].id});assert.equal(exp.snapshot.current.preference.value,'简洁回答');assert.equal(e('memories').children.length,1);
 assert(e('conversation').children.some(x=>x.textContent==='模型建议 1 项 · 已记录裁决 1 项 · 待处理 0 项'),'saved governance decisions must update the visible round summary');
 e('filter').value='all';await e('graph-view').click();assert.equal(graphInstance.model.nodes[0].payload.value,'简洁回答');e('position').value='0';e('position').oninput();assert.equal(graphInstance.model.nodes[0].payload.value,'简洁回答');
 await e('memories').children[0].click();assert(e('details').children.length>0);
 // A current fact and isolated candidate of the same field must select different versions.
 e('input').value='也许我需要详细回答';await e('composer').onsubmit({preventDefault(){}});
 // Use the actual core to isolate the second proposal, then reopen via the real handler.
 let conflict=service({op:'open',id:rows[0].id});
 conflict=service({op:'decide',id:conflict.id,revision:conflict.revision,index:0,confirm:false});
 e('experiments').value=conflict.id;await e('experiments').onchange();
 const pendingNode=graphInstance.model.nodes.find(n=>n.part==='pending');
 assert(pendingNode,'the unconfirmed proposal must have a pending node');
 await e('memories').children.find(b=>b.textContent.includes('待核实')).click();
 assert.equal(graphInstance.selected,pendingNode.id,'select the candidate version, not the same-key current fact');
 e('rules').value='下一实验的新守则草稿';e('name').value='新的名称草稿';e('position').oninput();assert.equal(e('name').value,'新的名称草稿','view refresh must not discard an experiment-name draft');assert.equal(e('rules').value,'下一实验的新守则草稿','view refresh must not discard an unsaved rules draft');

 let historical=service({op:'open',id:rows[0].id});
 const hp=service({op:'prepare',id:historical.id,revision:historical.revision,input:'明确更正并保留历史',request_id:'history',model:{}});
 historical=service({op:'finish',id:hp.id,revision:hp.revision,request_id:'history',reply:'样本回复',candidates:[{op:'set',key:'preference',value:'新的长期偏好',archive_old:true,current_correction:true}]});
 historical=service({op:'decide',id:historical.id,revision:historical.revision,index:0,confirm:true});
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
 const experimentsBeforeSample=service({op:'list'}),callsBeforeSample=requests;
 await e('sample').click();assert.equal(sampleData.mode,'SIMULATED');assert.deepEqual(service({op:'list'}),experimentsBeforeSample);assert.equal(requests,callsBeforeSample);
 console.log('PASS：桌面入口、配置Key清空、两阶段真实内核提交、逐轮快照、图谱数据与详情、退出释放（最小DOM＋实际SQLite/Store；HTTP由夹具替代）。');
}finally{await rm(folder,{recursive:true,force:true});}

}else console.log('NOT_RUN：独立公开Web仓库不含桌面Python服务，仅执行上面的前端协调器检查。');
