// Atomic coordinator checks; no browser, GUI, external API or credentials.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);globalThis.MemoryModel=require('./model.js');
const demo=require('./src/public-demo.json');
const withHash=structuredClone(demo);withHash.data.policy.sha256='a'+'1234567890123'+'b'.repeat(50);if(withHash.policy)withHash.policy.sha256=withHash.data.policy.sha256;assert.equal(globalThis.MemoryModel.adapt(withHash).data.policy.sha256,withHash.data.policy.sha256);
const secret=structuredClone(withHash);secret.data.frames[0].input='1234567890123';assert.throws(()=>globalThis.MemoryModel.adapt(secret),/敏感/);
const {runner,extracted}=require('./native-ui.js');
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
let currentProfiles=[];let requests=0,dispose=0;
const service=q=>JSON.parse(execFileSync(process.env.MEMORY_LAB_PYTHON||'python3',['-B','-m','tools.desktop_service',folder],{cwd:rootDir,input:JSON.stringify(q),encoding:'utf8'})).result;
const originalEntry=new El('button');originalEntry.hidden=true;const graphInstance={setData(m){this.model=m;},configure(){},resizeToHost(){},request(){},setPaused(){},select(){},focus(){},reset(){},dispose(){dispose++;}};
const win={document:{body:new El('body'),createElement:tag=>new El(tag),getElementById:()=>originalEntry},MemoryModel:globalThis.MemoryModel,MemoryGraph:{GraphView:function(){return graphInstance;}},crypto:globalThis.crypto,matchMedia:()=>({matches:true}),dispatchEvent(){},addEventListener(){},confirm:()=>true,__TAURI__:{core:{Channel:class{},invoke:async(command,args)=>{
 if(command==='default_rules')return '测试守则：候选隔离，明确确认后裁决。';
 if(command==='experiment_call'){if(args.request.op==='profiles')return currentProfiles;return service(args.request);}
 if(command==='save_profile'){currentProfiles=[{id:args.id,...args.profile}];return;}
 if(command==='model_request'){requests++;if(args.stream){args.onDelta.onmessage('实际响应样本');return {text:'实际响应样本',usage:null};}return {text:'{"candidates":[{"op":"set","key":"preference","value":"简洁回答"}]}',usage:null};}
 if(command==='cancel_model')return;
 throw Error('Unexpected command '+command);
 }}}};
try{
 vm.runInNewContext(nativeSource,{window:win,globalThis:win,Option:class extends El{constructor(label,value){super();this.textContent=label;this.value=value;}},Event:class{}});
 assert.equal(originalEntry.hidden,false);await originalEntry.click();
 const e=name=>elements.get('nl-'+name);
 e('name').value='最小DOM实验';await e('new').click();assert.equal(service({op:'list'}).length,1);
 e('provider').value='Mock';e('protocol').value='openai';e('base').value='http://localhost/v1';e('model').value='test';e('key').value='TEMP_KEY';await e('profile-save').click();assert.equal(e('key').value,'');
 e('input').value='请记住我喜欢简洁回答';e('stream').checked=true;
 await e('composer').onsubmit({preventDefault(){}}); // handler starts its async guard
 for(let n=0;n<50&&requests<2;n++)await new Promise(r=>setTimeout(r,5));
 for(let n=0;n<50&&!service({op:'open',id:service({op:'list'})[0].id}).turns.length;n++)await new Promise(r=>setTimeout(r,5));
 await new Promise(r=>setTimeout(r,20));
 const rows=service({op:'list'});let exp=service({op:'open',id:rows[0].id});assert.equal(exp.turns.length,1);assert.equal(exp.turns[0].reply,'实际响应样本');assert.equal(exp.frames.length,1);assert.equal(exp.snapshot.current.preference,undefined);
 const candidate=e('conversation').children.find(x=>x.className==='native-candidate');assert(candidate);const confirm=candidate.children.find(x=>x.textContent==='本人确认并交由内核裁决');assert(confirm);await confirm.click();
 exp=service({op:'open',id:rows[0].id});assert.equal(exp.snapshot.current.preference.value,'简洁回答');assert.equal(e('memories').children.length,1);
 e('filter').value='all';await e('graph-view').click();assert.equal(graphInstance.model.nodes[0].payload.value,'简洁回答');e('position').value='0';e('position').oninput();assert.equal(graphInstance.model.nodes[0].payload.value,'简洁回答');
 await e('memories').children[0].click();assert(e('details').children.length>0);
 e('name').value='新的空实验';await e('new').click();assert.equal(graphInstance.model.nodes.length,0,'切到空实验必须清除旧图谱');assert.equal(e('details').children.length,0,'空实验不能保留旧实验详情');
 await e('close').click();assert.equal(dispose,1);assert.equal(service({op:'open',id:rows[0].id}).rules.text,'测试守则：候选隔离，明确确认后裁决。');
 console.log('PASS：桌面入口、配置Key清空、两阶段真实内核提交、逐轮快照、图谱数据与详情、退出释放（最小DOM＋实际SQLite/Store；HTTP由夹具替代）。');
}finally{await rm(folder,{recursive:true,force:true});}

}else console.log('NOT_RUN：独立公开Web仓库不含桌面Python服务，仅执行上面的前端协调器检查。');
