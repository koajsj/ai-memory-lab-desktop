// 独立公开演示检查；只使用本仓库虚构数据，不驱动浏览器。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import {webcrypto} from 'node:crypto';
const root=fileURLToPath(new URL('./',import.meta.url)),require=createRequire(import.meta.url);
const runtime=process.env.MEMORY_LAB_RUNTIME_DIR?process.env.MEMORY_LAB_RUNTIME_DIR.replace(/\/$/,'')+'/':root;
const M=require('./model.js'),raw=JSON.parse(fs.readFileSync(root+'src/public-demo.json','utf8')),ds=M.adapt(raw);
assert.equal(ds.role,'ATLAS_DEMO');assert.equal(ds.mode,'SIMULATED');assert.equal(ds.data.frames.length,28);
const report=JSON.parse(fs.readFileSync(root+'evaluation.json','utf8'));
assert.equal(report.format,'memory-lab.public-eval.v1');assert.equal(report.summary.turns,28);assert.equal(report.results.length,1);
assert.deepEqual(report.results[0].turns.map(t=>t.actions),ds.data.frames.map(f=>f.decisions.map(d=>d.action)));
assert.equal(M.label('default__preference'),'回答偏好');assert.equal(M.label('fieldwork__preference'),'回答偏好 · 项目 fieldwork');
const encoded=M.encode(ds);assert.deepEqual(M.parse(encoded),ds);
for(const [name,mutate]of [
 ['envelope policy',x=>{x.policy={...x.data.policy,sha256:'a'.repeat(64)};}],
 ['invalid experiment tag',x=>{x.data.experiment={engine:'unknown',temporary:true};}],
 ['audit role',x=>{x.data.frames[0].governance.audit[0].role='OTHER';}],
 ['audit shape',x=>{x.data.frames[0].governance.audit[0].operation={bad:true};}],
 ['admission shape',x=>{x.data.frames[0].admission.allowed_ids='all';}],
 ['admission foreign ID',x=>{x.data.frames[0].admission.allowed_ids=['OTHER/project/1'];}],
 ['admission duplicate ID',x=>{x.data.frames[0].admission.allowed_ids.push(x.data.frames[0].admission.allowed_ids[0]);}],
 ['admission reason',x=>{x.data.frames[0].admission.denied=[{reason:42}];}]
]){const x=JSON.parse(encoded);mutate(x);assert.throws(()=>M.adapt(x),undefined,name);}
for(const mutate of [
 x=>{x.format='memory-lab.replay.v99';},
 x=>{x.data.frames[0].governance.versions.push(structuredClone(x.data.frames[0].governance.versions[0]));},
 x=>{x.data.frames[0].governance.versions[0].owner='OTHER';},
 x=>{const f=x.data.frames[0],r=f.governance.versions[0];r.key=['project'];r.payload=null;r.lifecycle='forgotten';delete f.after.current.project;},
 x=>{x.data.frames[0].after.current.project.privacy='high';},
 x=>{x.data.frames[0].governance.versions[0].parents=['OTHER/missing/1'];},
 x=>{x.data.frames[0].governance.audit[0].version_id='ATLAS_DEMO/missing/1';},
 x=>{x.data.frames[0].after.current.project.value='6228480012345678';}
]){const x=JSON.parse(encoded);mutate(x);assert.throws(()=>M.adapt(x));}
const independent=M.parse(encoded.replaceAll('ATLAS_DEMO','NOVA_ROLE'));
assert.equal(independent.role,'NOVA_ROLE');assert(M.graph(independent,27).nodes.every(n=>n.id.includes('NOVA_ROLE')));
const noAdmission=JSON.parse(encoded);for(const f of noAdmission.data.frames)delete f.admission;assert.equal(M.adapt(noAdmission).data.frames.length,28);
assert.throws(()=>M.parse(encoded.replace('"role": "ATLAS_DEMO"','"role": "ATLAS_DEMO", "r\\u006fle": "OTHER"')),/重复/);
const stops=M.tour(ds);assert.equal(new Set(stops.map(s=>s.index)).size,stops.length);
const derivation=M.graph(ds,12);
assert(derivation.edges.some(edge=>edge.type==='DERIVE'),'有登记派生证据时，应允许查看无值关系，不恢复删除载荷');
for(const n of derivation.nodes.filter(n=>n.redacted)){assert.equal(n.payload,null);assert.equal(n.state,'retired');assert(n.evidence);}
assert(derivation.nodes.some(n=>n.redacted));
for(const n of [12,14,16,21,22])assert(stops.some(s=>s.index===n-1),'路演缺少现有治理事件 '+n);
assert.equal(stops.reduce((n,s)=>n+s.seconds,0),30,'默认路演总时长为30秒');
const thirty=M.controller(28);thirty.play();for(let i=0;i<300;i++)thirty.tick(100);assert.equal(thirty.index,27,'默认播放应在30秒展示全部28轮');
for(let i=0;i<28;i++){
  const graph=M.graph(ds,i),snapshot=ds.data.frames[i].after;
  assert.equal(graph.count,Object.values(snapshot).reduce((n,g)=>n+Object.keys(g).length,0));
  for(const n of graph.nodes)if(n.payload)assert.deepEqual(n.payload,snapshot[n.part][n.key]);
  for(const edge of graph.edges){assert(graph.nodes.some(n=>n.id===edge.to));if(!edge.from.startsWith('role:'))assert(graph.nodes.some(n=>n.id===edge.from));}
  assert.deepEqual(M.graph(ds,i,{privateVisible:false}),{nodes:[],edges:[],count:0});
}
// 逐轮阅读工作区必须使用本轮输入、差异和快照，不按操作关键词编造字段变化。
for(let i=0;i<ds.data.frames.length;i++){
 const f=ds.data.frames[i],r=M.roundView(ds,i);
 assert.equal(r.input,f.input||'本轮未记录输入');
 assert.deepEqual(r.decisions,f.decisions);
 assert.deepEqual(r.changes.map(x=>x.path),['added','changed','removed'].flatMap(kind=>f.diff[kind]));
 for(const c of r.changes){const [part,key]=c.path.split('.');assert.equal(c.after,f.after[part][key]?.value??null);if(c.before!==null)assert.equal(c.before,f.before[part][key]?.value??null);}
 assert.deepEqual(M.roundView(ds,i,{privateVisible:false}),{input:'当前视角不展示私人内容。',changes:[],decisions:[]});
}
const emptyFrame={round:1,input:'',before:{current:{},completed:{},history:{},pending:{}},after:{current:{},completed:{},history:{},pending:{}},diff:{added:[],changed:[],removed:[]},decisions:[]};
assert.equal(M.roundView({data:{frames:[emptyFrame]}},0).input,'本轮未记录输入');
const removedFrame=structuredClone(emptyFrame);removedFrame.before.current.secret={value:'已删原文不得回显',version:1};removedFrame.diff.removed=['current.secret'];removedFrame.decisions=[{action:'DELETE',reason:'授权删除'}];
assert.equal(M.roundView({data:{frames:[removedFrame]}},0).changes[0].before,null);
const revisedFrame=structuredClone(emptyFrame);revisedFrame.before.current.preference={value:'简洁',version:1};revisedFrame.after.current.preference={value:'详尽',version:2};revisedFrame.diff.changed=['current.preference'];
assert.deepEqual(M.roundView({data:{frames:[revisedFrame]}},0).changes.map(c=>[c.before,c.after]),[['简洁','详尽']]);
for(const text of ['{','{"__proto__":{}}','{"format":"unknown"}',encoded.replace('"SIMULATED"','"REAL"')])assert.throws(()=>M.parse(text));
const a=M.controller(28);a.play();assert(a.tick(3500));a.pause();a.tick(1e6);assert.equal(a.index,1);a.play();a.jump(27);a.tick(3500);assert.equal(a.playing,false);
const built=await build({stdin:{contents:"export * from './src/graph.js'; export * as THREE from 'three'; export {OrbitControls} from 'three/addons/controls/OrbitControls.js';",resolveDir:root},bundle:true,platform:'node',format:'esm',write:false,logLevel:'silent'});
const loaded=await import('data:text/javascript;base64,'+Buffer.from(built.outputFiles[0].text).toString('base64'));
const {fitView,stableLayout,placeLabels}=await import('./src/view-math.mjs');
for(const aspect of [.7,1,2,3])for(const count of [0,1,3,30,250]){
  const keys=Array.from({length:count},(_,i)=>'field_'+i),layout=stableLayout(keys),fit=fitView(keys.map(key=>layout({key,state:'current'})),aspect);
  assert(fit.distance>=5&&fit.distance<500);assert(fit.target.every(Number.isFinite));
}
// 使用真实Three.js对象和GraphView方法，替换GPU渲染器；不冒充浏览器像素验收。
const {GraphView,THREE}=loaded;
function graphInstance(w=800,h=400){
 const g=Object.create(GraphView.prototype);
 Object.assign(g,{host:{clientWidth:w,clientHeight:h},states:M.states,items:new Map(),motion:true,autoFrame:true,
  scene:new THREE.Scene(),camera:new THREE.PerspectiveCamera(43,w/h,.1,160),role:new THREE.Mesh(new THREE.CircleGeometry(.32,24)),
  lines:new THREE.LineSegments(new THREE.BufferGeometry(),new THREE.LineBasicMaterial()),highlight:new THREE.LineSegments(new THREE.BufferGeometry(),new THREE.LineBasicMaterial()),
  nodeGeometry:new THREE.CircleGeometry(.27,24),request(){},
  text(){return new THREE.Sprite(new THREE.SpriteMaterial({map:new THREE.Texture()}));},
  controls:{target:new THREE.Vector3(),update(){g.camera.lookAt(this.target);g.camera.updateMatrixWorld();}},renderer:{render(){},setPixelRatio(){},setSize(){}},last:performance.now()});
 g.setCatalog(ds.data.frames.flatMap((_,i)=>M.graph(ds,i).nodes));return g;
}
for(const [w,h]of [[686,320],[966,400],[1400,600]]){
 const g=graphInstance(w,h);
 for(const i of [...Array(28).keys(),27,6,0,22,3,27]){
  const model=M.graph(ds,i);g.setData(model,ds.role,{animate:false});g.select(model.nodes[0]?.id);g.tick(performance.now());
  assert.equal(g.items.size,model.nodes.length);assert.equal(g.model.count,model.count);
  for(const n of model.nodes){const item=g.items.get(n.id),v=item.group.position.clone().project(g.camera);
   assert.equal(item.mesh.geometry.type,'CircleGeometry');assert(item.mesh.quaternion.angleTo(g.camera.quaternion)<1e-6);
   assert(Math.abs(v.x)<1&&Math.abs(v.y)<1&&v.z<1,'节点超出相机视野');assert.equal(item.node.payload,n.payload);
  }
 }
 g.setData({nodes:[],edges:[],count:0},ds.role,{animate:false,privateVisible:false});assert.equal(g.items.size,0);
 g.nodeGeometry.dispose();for(const obj of [g.role,g.lines,g.highlight]){obj.geometry.dispose();obj.material.dispose();}
 if(g.roleLabel){g.roleLabel.material.map.dispose();g.roleLabel.material.dispose();}
}
console.log('PASS：102次真实Three.js对象/相机取景/圆点朝向与快速切轮，含无值派生证据、空和未核验视角；非GPU渲染。');
// 针对图谱缺口的原子回归：实际Three.js对象与数学，不使用浏览器或GPU。
const graphFailures=[];let graphChecks=0;
function graphTest(name,fn){try{fn();graphChecks++;}catch(err){graphFailures.push(name+': '+err.message);}}
graphTest('相同节点造型共享几何体，只有状态变化时复用标签并更新颜色',()=>{
 const g=graphInstance(),model=M.graph(ds,27);g.setData(model,ds.role,{animate:false});
 const node=model.nodes[0],item=g.items.get(node.id),label=item.label;
 assert.equal(new Set([...g.items.values()].map(x=>x.mesh.geometry)).size,1);
 const changed={...model,nodes:model.nodes.map(n=>({...n,state:'history'}))};
 g.setData(changed,ds.role,{animate:false});
 assert.equal(item.label,label,'纯状态变化不应销毁并重建相同文本的纹理');
 assert.equal(new Set([...g.items.values()].map(x=>x.mesh.geometry)).size,1);
 assert.equal(item.mesh.material.color.getHex(),M.states.history.color);
 g.setData({...changed,nodes:changed.nodes.map(n=>({...n,label:n.label+' · 更新'}))},ds.role,{animate:false});
 assert.notEqual(item.label,label,'文字变化仍须更新纹理');
 let released=0;g.nodeGeometry.addEventListener('dispose',()=>released++);
 g.remove(node.id);assert.equal(released,0,'移除单节点不得释放共享几何体');
 g.grid=new THREE.GridHelper(1,1);g.resize={disconnect(){}};g.controls.dispose=()=>{};
 g.renderer.domElement={removeEventListener(){},remove(){}};g.renderer.dispose=()=>{};
 const cancel=globalThis.cancelAnimationFrame;globalThis.cancelAnimationFrame=()=>{};
 try{g.dispose();g.dispose();assert.equal(released,1);}finally{globalThis.cancelAnimationFrame=cancel;}
});
graphTest('同字段多次删除的无值版本不重叠，导航顺序不改变坐标',()=>{
 const engine=require('./sandbox.js').create(ds.data.policy);engine.apply({value:'初始偏好'});
 for(let i=0;i<4;i++)engine.apply({action:'CORRECT',value:'偏好修订 '+i});engine.apply({action:'DELETE'});
 const data=engine.dataset(),catalog=data.data.frames.flatMap((_,i)=>M.graph(data,i).nodes),final=M.graph(data,data.data.frames.length-1);
 assert.equal(final.nodes.length,5);assert(final.nodes.every(n=>n.payload===null));
 const a=stableLayout(catalog),b=stableLayout([...catalog].reverse()),positions=final.nodes.map(n=>a(n));
 assert.equal(new Set(positions.map(p=>JSON.stringify(p))).size,5);
 for(const n of [...final.nodes].reverse())assert.deepEqual(a(n),b(n));
 for(const state of ['current','history','retired'])assert.deepEqual(a({...final.nodes[0],state}).filter((_,i)=>i!==1),positions[0].filter((_,i)=>i!==1));
});
graphTest('标签不能覆盖其他节点和角色锚点',()=>{
 const anchors=[{id:'a',x:200,y:120,w:142,h:26,priority:3,radius:8},{id:'b',x:200,y:93,w:142,h:26,priority:1,radius:8}];
 for(const box of placeLabels(anchors,500,300).filter(x=>x.visible))for(const p of anchors)assert(Math.abs(box.x-p.x)>box.w/2+p.radius||Math.abs(box.y-p.y)>box.h/2+p.radius,'标签盖住节点 '+p.id);
});
graphTest('相机目标尚未到达不能提前结束，最终端点精确归位',()=>{
 const g=graphInstance();g.setData(M.graph(ds,0),ds.role,{animate:false});
 const target=new THREE.Vector3(4,3,2),position=g.camera.position.clone();g.focusTarget={target,position};
 g.tick(g.last+16);assert(g.focusTarget,'仅位置到达不能清除聚焦动画');
 for(let i=0;i<200&&g.focusTarget;i++)g.tick(g.last+16);
 assert.equal(g.focusTarget,null);assert.deepEqual(g.controls.target.toArray(),target.toArray());assert.deepEqual(g.camera.position.toArray(),position.toArray());
});
graphTest('无动画切轮取消旧聚焦，移除的选择不继续生效',()=>{
 const g=graphInstance(),model=M.graph(ds,7);g.setData(model,ds.role,{animate:false});const id=model.nodes.at(-1).id;g.select(id);g.focus(id);assert(g.focusTarget);
 g.setData(model,ds.role,{animate:false});assert.equal(g.focusTarget,null);
 g.setData({nodes:[],edges:[],count:0},ds.role,{animate:false});assert.equal(g.selected,null);g.select(id);assert.equal(g.selected,null);
});
graphTest('允许的最远缩放不能被远裁剪面截断',()=>{
 const g=graphInstance();g.setData(M.graph(ds,27),ds.role,{animate:false});const direction=g.camera.position.clone().sub(g.controls.target).normalize();
 g.camera.position.copy(g.controls.target).addScaledVector(direction,g.controls.maxDistance);g.controls.update();
 for(const item of g.items.values())assert(item.group.position.clone().project(g.camera).z<1,'缩放至允许范围内却被裁剪');
});
graphTest('缺失端点不生成通往原点的虚假连线，同数关系复用缓冲',()=>{
 const g=graphInstance(),model=M.graph(ds,0);g.setData(model,ds.role,{animate:false});const geometry=g.lines.geometry;
 g.setData(model,ds.role,{animate:false});assert.equal(g.lines.geometry,geometry);
 g.setData({...model,edges:[{from:'MISSING',to:model.nodes[0].id,type:'DERIVE'}]},ds.role,{animate:false});g.tick(g.last+16);assert.equal(g.lines.geometry.getAttribute('position').count,0);
});
graphTest('减少动态效果关闭轨道惯性，销毁后不再重建对象',()=>{
 globalThis.devicePixelRatio=2;const g=graphInstance();g.setData(M.graph(ds,0),ds.role,{animate:false});g.controls.enableDamping=true;
 g.configure({motion:false,low:true});assert.equal(g.controls.enableDamping,false);
 g.destroyed=true;const items=g.items.size,selection=g.selected;g.setCatalog([]);g.focus(M.graph(ds,0).nodes[0].id);g.select('unknown');g.reset();assert.equal(g.items.size,items);assert.equal(g.selected,selection);assert.equal(g.focusTarget,null);
});
graphTest('长标签按实际宽度与完整字素簇截断',()=>{
 const saved=globalThis.document,drawn=[];
 const context={beginPath(){},roundRect(){},fill(){},stroke(){},measureText:s=>({width:Array.from(s).length*48}),fillText:s=>drawn.push(s)};
 globalThis.document={createElement:()=>({getContext:()=>context})};
 try{for(const [input,expected]of [['甲乙丙丁戊己庚辛😀壬癸','甲乙丙丁戊己庚辛😀…'],['甲乙丙丁戊己庚辛e\u0301壬癸','甲乙丙丁戊己庚辛…'],['甲乙丙丁戊己庚辛👍🏽壬癸','甲乙丙丁戊己庚辛…'],['甲乙丙丁戊己庚辛🇨🇳壬癸','甲乙丙丁戊己庚辛…'],['甲乙丙丁👩‍👩‍👧‍👦壬癸','甲乙丙丁…']]){
  const label=GraphView.prototype.text(input);assert.equal(drawn.at(-1),expected);assert(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(drawn.at(-1)));assert(label.userData.labelWidth>0&&label.userData.labelWidth<=142);label.material.map.dispose();label.material.dispose();
 }}finally{globalThis.document=saved;}
});
graphTest('切轮和目录替换取消未结束的旧图点选手势',()=>{
 for(const catalogReset of [false,true]){
  const g=graphInstance();g.setData(M.graph(ds,0),ds.role,{animate:false});const node=g.model.nodes[0],p=g.items.get(node.id).target.clone().project(g.camera);
  const event={clientX:(p.x+1)*400,clientY:(1-p.y)*200,pointerId:1,button:0};g.ray=new THREE.Raycaster();g.pointer=new THREE.Vector2();g.renderer.domElement={getBoundingClientRect:()=>({left:0,top:0,width:800,height:400})};g.onSelect=id=>{g.picked=id;};
  g.down=[event.clientX,event.clientY,1];if(catalogReset){g.setCatalog([node]);assert.equal(g.down,null);}
  g.setData({nodes:[node],edges:[],count:1},ds.role,{animate:false});const next=g.items.get(node.id).target.clone().project(g.camera);g.pick({...event,clientX:(next.x+1)*400,clientY:(1-next.y)*200});
  assert.equal(g.down,null);assert.equal(g.picked,undefined,'旧手势不得选择替换后的图');
 }
});
graphTest('目录重置立即清除旧节点、连线与聚焦，可安全渲染空场景',()=>{
 const g=graphInstance();g.setData(M.graph(ds,7),ds.role,{animate:false});g.setCatalog([]);assert.equal(g.items.size,0);assert.equal(g.lines.geometry.drawRange.count,0);assert.equal(g.highlight.geometry.drawRange.count,0);assert.doesNotThrow(()=>g.tick(g.last+16));
});
graphTest('初始配置立即同步相机宽高比，隐藏和恢复窗口保持有效取景',()=>{
 const g=graphInstance(966,400);g.setData(M.graph(ds,7),ds.role,{animate:false});g.camera.aspect=1;g.configure({motion:true,low:false});assert.equal(g.camera.aspect,966/400);
 g.host.clientWidth=0;g.resizeToHost();assert.equal(g.camera.aspect,966/400);g.host.clientWidth=400;g.resizeToHost();assert.equal(g.camera.aspect,1);
 g.autoFrame=false;g.camera.position.set(20,12,25);g.controls.target.set(2,1,3);g.host.clientWidth=1280;g.resizeToHost();assert.deepEqual(g.camera.position.toArray(),[20,12,25]);assert.deepEqual(g.controls.target.toArray(),[2,1,3]);
});
graphTest('真实OrbitControls残余惯性不能覆盖无动画聚焦',()=>{
 const g=graphInstance();g.setData(M.graph(ds,7),ds.role,{animate:false});g.controls=new loaded.OrbitControls(g.camera);g.controls.enableDamping=true;g.controls.rotateLeft(1);g.autoFrame=false;
 const position=g.camera.position.clone(),target=g.controls.target.clone();g.configure({motion:false,low:false});assert(g.camera.position.distanceTo(position)<1e-8);assert(g.controls.target.distanceTo(target)<1e-8);
 const direction=position.clone().sub(target).normalize(),id=g.model.nodes[0].id,expected=g.items.get(id).target.clone().addScaledVector(direction,9);g.focus(id);assert(g.camera.position.distanceTo(expected)<1e-8);
});
graphTest('点选使用最新变换，过期或非主键点击不选中节点',()=>{
 const g=graphInstance();g.setData(M.graph(ds,0),ds.role,{animate:false});const id=g.model.nodes[0].id,item=g.items.get(id),p=item.target.clone().project(g.camera);
 const event={clientX:(p.x+1)*400,clientY:(1-p.y)*200,pointerId:1,button:0};
 g.ray=new THREE.Raycaster();g.pointer=new THREE.Vector2();g.renderer.domElement={getBoundingClientRect:()=>({left:0,top:0,width:800,height:400})};g.onSelect=id=>{g.picked=id;};
 g.ray.setFromCamera(new THREE.Vector2(p.x,p.y),g.camera);assert.equal(g.ray.intersectObject(item.mesh).length,0,'夹具应复现尚未渲染的新世界变换');
 g.down=[event.clientX,event.clientY,1];g.pick(event);assert.equal(g.picked,id);assert.equal(g.down,null);
 g.picked=null;g.pick(event);assert.equal(g.picked,null);g.down=[event.clientX,event.clientY,2];g.pick(event);assert.equal(g.picked,null);
 g.down=[event.clientX,event.clientY,1];g.pick({...event,button:2});assert.equal(g.picked,null);
});
graphTest('暂停冻结退出节点，恢复不提前删除，反向切轮不留旧动画',()=>{
 const saved=globalThis.performance;let now=1000;globalThis.performance={now:()=>now};
 try{const g=graphInstance();g.setData(M.graph(ds,7),ds.role,{animate:false});g.setData(M.graph(ds,0),ds.role,{animate:true});const exits=[...g.items.values()].filter(x=>x.exiting);assert(exits.length);
  now+=20;g.tick(now);g.setPaused(true);const positions=exits.map(x=>x.group.position.toArray());now+=4000;g.tick(now);assert.deepEqual(exits.map(x=>x.group.position.toArray()),positions);assert(exits.every(x=>g.items.has(x.node.id)));
  g.setPaused(false);now+=100;g.tick(now);assert(exits.every(x=>g.items.has(x.node.id)));now+=500;g.tick(now);assert(exits.every(x=>!g.items.has(x.node.id)));
  for(const i of [27,0,22,3,27,1]){g.setData(M.graph(ds,i),ds.role,{animate:true});g.focus(g.model.nodes[0]?.id);}
  g.setData(M.graph(ds,7),ds.role,{animate:false});g.tick(now+=16);assert.equal(g.items.size,g.model.nodes.length);assert([...g.items.values()].every(x=>!x.exiting&&x.group.position.equals(x.target)));assert.equal(g.focusTarget,null);
 }finally{globalThis.performance=saved;}
});
graphTest('同帧较早的RAF时间戳不得使节点或聚焦动画反向外推',()=>{
 const g=graphInstance();g.setData(M.graph(ds,0),ds.role,{animate:true});g.focus(g.model.nodes[0].id);
 const item=[...g.items.values()][0],position=item.group.position.clone(),scale=item.group.scale.x,camera=g.camera.position.clone(),target=g.controls.target.clone(),last=g.last;
 // 另一RAF回调内的setPaused使用performance.now()，可能晚于该帧统一时间戳。
 g.tick(last-10);assert(item.group.position.equals(position));assert.equal(item.group.scale.x,scale);assert(g.camera.position.equals(camera));assert(g.controls.target.equals(target));assert.equal(g.last,last);
 g.tick(last+16);assert(item.group.scale.x>scale&&item.group.scale.x<=1);assert(item.group.position.distanceTo(item.target)<position.distanceTo(item.target));
});
graphTest('稀疏和密集图的标签均保留节点点击区域与画布边界',()=>{
 for(const count of [0,1,8,40,150])for(const width of [320,686,1400]){
  const anchors=Array.from({length:count},(_,i)=>({id:String(i),x:16+(i*71)%(width-32),y:16+(i*97)%368,w:80+i%4*16,h:26,radius:6,priority:i?1:3}));
  const boxes=placeLabels(anchors,width,400).filter(x=>x.visible);if(count===1)assert.equal(boxes.length,1);
  for(const [i,b]of boxes.entries()){assert(b.x-b.w/2>=8&&b.x+b.w/2<=width-8&&b.y-b.h/2>=8&&b.y+b.h/2<=392);for(const p of anchors)assert(Math.abs(p.x-b.x)>=b.w/2+p.radius+3||Math.abs(p.y-b.y)>=b.h/2+p.radius+3);for(const a of boxes.slice(i+1))assert(Math.abs(a.x-b.x)>=(a.w+b.w)/2+5||Math.abs(a.y-b.y)>=(a.h+b.h)/2+3);}
 }
});
assert.deepEqual(graphFailures,[]);console.log(`PASS：${graphChecks}组版本布局、标签避让、相机收敛／裁剪、过期动画、关系与资源生命周期原子回归。`);
for(let i=0;i<28;i++)for(const n of M.graph(ds,i).nodes){
  const chain=loaded.versionChain(ds,i,n);assert(Array.isArray(chain));
  assert.deepEqual(loaded.versionChain(ds,i,n,{privateVisible:false}),[]);
  assert.deepEqual(loaded.provenance(ds,i,n,{privateVisible:false}),[]);
}

class Element{
  constructor(id=''){this.id=id;this.children=[];this.listeners={};this.dataset={};this.value='';this.textContent='';this.style={};this.attrs={};this.open=false;this.classList={toggle(){},remove(){},add(){}};}
  append(...n){this.children.push(...n);}replaceChildren(...n){this.children=n;}setAttribute(k,v){this.attrs[k]=v;}addEventListener(k,f){(this.listeners[k]??=[]).push(f);}removeEventListener(){}closest(){return null;}
  querySelectorAll(){return this.children;}querySelector(){return null;}async fire(t){for(const f of this.listeners[t]||[])await f({target:this,preventDefault(){}});}click(){return this.fire('click');}
}
const html=fs.readFileSync(runtime+'index.html','utf8'),elements=Object.fromEntries([...html.matchAll(/\bid="([\w-]+)"/g)].map(m=>[m[1],new Element(m[1])]));
assert.equal(Object.keys(elements).length,[...html.matchAll(/\bid="([\w-]+)"/g)].length,'界面 ID 不得重复');
assert(html.includes("connect-src 'none'"));assert(!/(?:src|href)="(?:https?:|\/)/.test(html));
for(const [k,v]of Object.entries({category:'all',state:'all',source:'all',permission:'owner',speed:'1'}))elements[k].value=v;
const details=[new Element(),new Element()];let frame,graph;
const keyboardHandlers={},windowHandlers={};
const document={getElementById:k=>elements[k],createElement:()=>new Element(),querySelectorAll:q=>q==='.audit-section'?details:[],addEventListener(k,f){keyboardHandlers[k]=f;},removeEventListener(){},hidden:false};
class RecordGraph{constructor(host,opts){graph=this;this.onSelect=opts.onSelect;this.items=new Map();this.scene={traverse(){}};}configure(){}setCatalog(){this.items.clear();}request(){}select(id){this.selected=id;}focus(){}reset(){}setPaused(){}drawInitial(){}dispose(){}setData(g){this.items=new Map(g.nodes.map(n=>[n.id,n]));}}
const ui={document,MemoryModel:M,MemoryState:require('./state.js'),MemoryGraph:{...loaded,GraphView:RecordGraph},REPLAY_DATA:raw,matchMedia:()=>({matches:false}),addEventListener(k,f){windowHandlers[k]=f;},performance,TextEncoder,TextDecoder,crypto:webcrypto,setTimeout,URL,Blob};
const sandbox={window:ui,performance,TextEncoder,TextDecoder,Blob,URL,setTimeout,requestAnimationFrame:f=>{frame=f;return 1;},cancelAnimationFrame(){}};
vm.runInNewContext(fs.readFileSync(runtime+'platform.js','utf8'),sandbox);
vm.runInNewContext(fs.readFileSync(runtime+'app.js','utf8'),sandbox);assert(graph.items.size>0);
const readText=n=>[n.textContent,...n.children.map(readText)].join(' ');
assert.equal(elements['graph-stage'].hidden,true,'默认演化模式不能继续显示三维主画布');
assert.equal(elements['evolution-panel'].hidden,false);
assert(html.indexOf('id="evolution-panel"')<html.indexOf('id="input"')&&html.indexOf('id="input"')<html.indexOf('id="experiment-panel"'),'输入应位于独立阅读区，不在折叠证据内');
for(const round of [...Array(28).keys()].map(i=>i+1).concat([28,1,14,3,22,2])){
 elements.range.value=String(round);await elements.range.fire('input');const f=ds.data.frames[round-1],projection=M.roundView(ds,round-1),nodes=M.graph(ds,round-1).nodes;
 assert.equal(elements.input.textContent,projection.input);assert.equal(elements['reading-round'].textContent,'第 '+round+' 轮输入');
 assert.equal(elements['snapshot-title'].textContent,'第 '+round+' 轮后的记忆');
 assert.deepEqual(elements['changes-list'].children.filter(n=>n.dataset.path).map(n=>n.dataset.path),projection.changes.map(c=>c.path));
 for(const c of projection.changes){const row=elements['changes-list'].children.find(n=>n.dataset.path===c.path);assert(readText(row).includes(c.label));if(c.after!==null)assert(readText(row).includes(c.after));}
 assert.equal(elements['node-list'].children.filter(n=>n.dataset.memoryId).length,nodes.length);
 for(const n of nodes){const button=elements['node-list'].children.find(b=>b.dataset.memoryId===n.id);assert(button);assert(readText(button).includes(n.payload?.value||(n.redacted?'原值已清除':'已退出')));}
 assert.equal(elements.range.value,String(f.round));
 const selection=ui.MemoryWorkspace.selected,filters=ui.MemoryWorkspace.filters;
 ui.MemoryWorkspace.view('spatial');assert.equal(elements['graph-stage'].hidden,false);assert.equal(elements['evolution-panel'].hidden,true);assert.equal(ui.MemoryWorkspace.selected,selection);assert.equal(ui.MemoryWorkspace.index,round-1);assert.deepEqual(ui.MemoryWorkspace.filters,filters);
 ui.MemoryWorkspace.view('graph');assert.equal(elements['graph-stage'].hidden,true);assert.equal(elements['evolution-panel'].hidden,false);assert.equal(ui.MemoryWorkspace.selected,selection);
}
elements.category.value='不存在的类别';await elements.category.fire('change');assert.equal(graph.items.size,0);assert.equal(elements['snapshot-all'].hidden,false);await elements['snapshot-all'].click();assert.equal(elements.category.value,'all');assert(graph.items.size>0);
await elements['detail-round'].click();assert(Number(elements.range.value)<=2,'节点可以跳至已登记版本首次出现轮次');
elements.permission.value='outsider';await elements.permission.fire('change');assert.equal(elements.input.textContent,'当前视角不展示私人内容。');assert(!elements['changes-list'].children.some(n=>n.dataset.path));assert.equal(elements['detail-round'].disabled,true);assert.equal(elements['snapshot-all'].hidden,true);assert(!readText(elements['changes-list']).includes('图册'));
elements.permission.value='owner';await elements.permission.fire('change');await elements.restore.click();
console.log('PASS：28轮输入/具体变化/处理后快照/图谱同帧，双模式内容互斥、选择与筛选保留、完整快照恢复、版本轮次跳转及私有内容隐藏（最小DOM）。');

await elements.play.click();let now=Math.ceil(performance.now());for(let i=0;i<112;i++){now+=1000;frame(now);}assert.equal(elements.range.value,'28');assert.equal(elements.play.textContent,'继续');
for(const n of [1,20,6,28,2]){elements.range.value=String(n);await elements.range.fire('input');assert.equal(graph.items.size,M.graph(ds,n-1).nodes.length);}
for(let i=0;i<20;i++){await elements.play.click();await elements.play.click();}const paused=elements.range.value;now+=1000;frame(now);assert.equal(elements.range.value,paused);
elements.permission.value='outsider';await elements.permission.fire('change');assert.equal(elements['overview-state'].title,'当前视角不展示私人内容。');assert.equal(graph.items.size,0);assert.equal(elements['node-meta'].children.length,0);
await elements.restore.click();const bytes=new TextEncoder().encode(encoded);
elements['import-file'].files=[{size:bytes.length,arrayBuffer:async()=>bytes.buffer}];await elements['import-file'].fire('change');assert(elements.notice.textContent.includes('已导入'));
const good=elements['data-name'].textContent;elements['import-file'].files=[{size:1,arrayBuffer:async()=>new TextEncoder().encode('{').buffer}];await elements['import-file'].fire('change');assert.equal(elements['data-name'].textContent,good);assert(elements.notice.textContent.includes('保留原数据'));
let release;elements['import-file'].files=[{size:1,arrayBuffer:()=>new Promise(r=>{release=r;})}];const pending=elements['import-file'].fire('change');await elements.restore.click();release(new TextEncoder().encode('{').buffer);await pending;assert(elements.notice.textContent.includes('已恢复'));assert.equal(elements.range.value,'1');
await elements.tour.click();for(let i=0;i<M.tour(ds).length*27;i++){now+=1000;frame(now);}assert.equal(elements.range.value,'28');
console.log('PASS：独立28轮快照/图谱/权限、20组取景边界、版本来源、解析拒绝及实际app.js最小DOM播放/跳转/暂停/导入失败与恢复竞态；未运行真实浏览器。');

await elements.restore.click();await elements.play.click();keyboardHandlers.keydown({key:'Escape',target:{closest:()=>elements.play}});assert.equal(elements.play.textContent,'继续');
ui.innerWidth=900;windowHandlers.resize();assert.equal(elements.inspector.hidden,true);
const pick=M.graph(ds,0).nodes[0];graph.onSelect(pick.id);assert.equal(elements.inspector.hidden,false);assert.equal(elements['node-title'].textContent,pick.label);
await elements['close-inspector'].click();assert.equal(elements.inspector.hidden,true);await elements['toggle-inspector'].click();assert.equal(elements.inspector.hidden,false);
ui.innerWidth=1920;windowHandlers.resize();assert.equal(elements.inspector.hidden,false);
elements.range.value='17';await elements.range.fire('input');assert.equal(elements.range.attrs['aria-valuetext'],'第 17 轮，共 28 轮');
const selected=M.graph(ds,16).nodes.find(n=>n.id===graph.selected);assert.equal(elements['node-title'].textContent,selected.label);
console.log('PASS：公开网页版Escape、响应式详情开关、节点联动与滑杆辅助文本（最小DOM，非像素布局）。');
const downloads=[],revoked=[];
sandbox.URL={createObjectURL(blob){downloads.push(blob);return 'blob:local-export';},revokeObjectURL(url){revoked.push(url);}};
await elements.restore.click();elements.range.value='14';await elements.range.fire('input');
await elements.export.click();assert.equal(downloads.length,1);assert.deepEqual(M.parse(await downloads[0].text()),ds);
elements.permission.value='outsider';await elements.permission.fire('change');
await elements.export.click();assert.equal(downloads.length,1,'未核验视角不能导出隐藏记忆');
assert.equal(elements['count-events'].textContent,'—');
assert.equal(elements['audit-summary'].children.length,0);
elements['import-file'].files=[{size:bytes.length,arrayBuffer:async()=>bytes.buffer}];await elements['import-file'].fire('change');
assert.equal(elements.permission.value,'outsider','导入数据不能提升当前视角');assert.equal(graph.items.size,0);
const beforeBad=elements.range.value;
for(const text of [encoded.replace('"SIMULATED"','"REAL"'),encoded.replace(raw.data.policy.sha256,'a'.repeat(64)),JSON.stringify({format:'unsupported'})]){
 const bad=new TextEncoder().encode(text);elements['import-file'].files=[{size:bad.length,arrayBuffer:async()=>bad.buffer}];await elements['import-file'].fire('change');
 assert(elements.notice.textContent.includes('保留原数据'));assert.equal(elements.range.value,beforeBad);assert.equal(elements.permission.value,'outsider');
}
await elements.restore.click();assert.equal(elements.permission.value,'outsider','恢复数据不能提升当前视角');
elements.permission.value='owner';await elements.permission.fire('change');
assert(elements['admission-summary'],'现有检索记录需要可见入口');
elements.range.value='14';await elements.range.fire('input');assert(elements['admission-summary'].textContent.includes('1 项限制'));
assert(elements['admission-list'].children.some(n=>n.textContent.includes('冲突')));
elements.range.value='16';await elements.range.fire('input');assert(elements['admission-list'].children.some(n=>n.textContent.includes('未来')));
elements.permission.value='outsider';await elements.permission.fire('change');assert.equal(elements['admission-list'].children.length,0);
await elements.tour.click();let tourNow=now;
for(let i=0;i<stops[0].seconds;i++){tourNow+=1000;frame(tourNow);}assert.equal(Number(elements.range.value),stops[1].index+1);
keyboardHandlers.keydown({key:'Escape',target:{closest:()=>null}});
await new Promise(resolve=>setTimeout(resolve,1050));assert(revoked.includes('blob:local-export'));
console.log('PASS：浏览器Blob导出往返与URL释放、未核验导出阻断、导入不提升视角、准入证据与路演时长（最小DOM）。');
// 运行真实实验入口及表单，不创建浏览器；验证往返、空白重置、角色与失败隔离。
for(const [k,v]of Object.entries({'lab-action':'ADD','lab-actor':'RESEARCHER_A','lab-owner':'RESEARCHER_A','lab-project':'default','lab-key':'preference','lab-value':'表达先给结论','lab-source':'owner_direct','lab-kind':'fact','lab-privacy':'private','lab-effective':'','lab-expires':'','lab-due':'','lab-date':'2026-01-01','lab-parents':''}))elements[k].value=v;
const storageWrites=[];ui.localStorage={getItem:()=>null,setItem:(...args)=>storageWrites.push(args)};
vm.runInNewContext(fs.readFileSync(runtime+'sandbox.js','utf8'),sandbox);
vm.runInNewContext(fs.readFileSync(runtime+'lab-ui.js','utf8'),sandbox);
assert.equal(elements.welcome.hidden,false);await elements['welcome-start'].click();assert.equal(elements.welcome.hidden,true);
await elements.restore.click();elements.range.value='14';await elements.range.fire('input');
const demoSelection=ui.MemoryWorkspace.selected,originalDemo=JSON.stringify(ui.MemoryWorkspace.dataset);
ui.MemoryWorkspace.view('spatial');assert.equal(ui.MemoryWorkspace.index,13);assert.equal(ui.MemoryWorkspace.selected,demoSelection);
ui.MemoryWorkspace.view('graph');assert.equal(ui.MemoryWorkspace.selected,demoSelection);
// 尚未结束的导入在进入实验时必须作废。
let delayed;elements['import-file'].files=[{size:bytes.length,arrayBuffer:()=>new Promise(r=>delayed=r)}];const delayedImport=elements['import-file'].fire('change');
await elements['enter-experiment'].click();assert.equal(elements['enter-experiment'].attrs['aria-pressed'],'true');assert.equal(elements['experiment-panel'].hidden,false);assert.equal(graph.items.size,0);assert.equal(ui.MemoryWorkspace.dataset.data.experiment.temporary,true);
delayed(bytes.buffer);await delayedImport;assert(ui.MemoryWorkspace.dataset.data.experiment);
elements['lab-value'].value='表达先给结论';await elements['experiment-form'].fire('submit');assert.equal(elements['lab-result'].textContent.startsWith('ADD'),true);assert.equal(graph.items.size,1);assert.equal(elements.range.value,'2');
const experimentSelection=ui.MemoryWorkspace.selected;ui.MemoryWorkspace.view('spatial');assert.equal(ui.MemoryWorkspace.selected,experimentSelection);ui.MemoryWorkspace.view('graph');
const expBefore=JSON.stringify(ui.MemoryWorkspace.dataset);elements['lab-key'].value='rules';await elements['experiment-form'].fire('submit');assert(elements['lab-result'].textContent.includes('状态保留'));assert.equal(JSON.stringify(ui.MemoryWorkspace.dataset),expBefore);elements['lab-key'].value='preference';
// 通用导入与恢复不能偷偷替换实验状态。
elements['import-file'].files=[{size:bytes.length,arrayBuffer:async()=>bytes.buffer}];await elements['import-file'].fire('change');await elements.restore.click();assert.equal(JSON.stringify(ui.MemoryWorkspace.dataset),expBefore);
await elements['lab-export'].click();const selectedExport=JSON.parse(await downloads.at(-1).text());assert.equal(selectedExport.format,'memory-lab.experiment.v1');assert.equal(selectedExport.role,'RESEARCHER_A');assert(!selectedExport.versions);assert(!selectedExport.events);
// 同一实际表单连续操作：暂停、逾期、取消不能在快照里被展示成同一种当前任务。
elements['lab-key'].value='review_task';elements['lab-value'].value='核对图册许可';elements['lab-kind'].value='task';elements['lab-due'].value='2026-01-02';elements['lab-action'].value='ADD';await elements['experiment-form'].fire('submit');
elements['lab-action'].value='PAUSE';await elements['experiment-form'].fire('submit');assert(readText(elements['node-list']).includes('任务已暂停'));
elements['lab-action'].value='ADVANCE';elements['lab-date'].value='2026-01-05';await elements['experiment-form'].fire('submit');
elements['lab-action'].value='RESUME';await elements['experiment-form'].fire('submit');assert(readText(elements['node-list']).includes('逾期待确认'));
elements['lab-action'].value='CANCEL';await elements['experiment-form'].fire('submit');assert(!M.graph(ui.MemoryWorkspace.dataset,ui.MemoryWorkspace.index).nodes.some(n=>n.key==='default__review_task'&&n.state==='task'));assert(elements.decisions.children.some(n=>readText(n).includes('取消')));
elements['lab-actor'].value='RESEARCHER_B';await elements['lab-actor'].fire('change');assert.equal(elements['lab-value'].value,'');assert.equal(elements['lab-parents'].value,'');assert.equal(graph.items.size,0);elements['lab-action'].value='READ';await elements['experiment-form'].fire('submit');assert(elements['lab-result'].textContent.startsWith('REJECT'));assert.equal(graph.items.size,0);
await elements['reset-experiment'].click();assert.equal(graph.items.size,0);assert.equal(elements.range.value,'1');
await elements['leave-experiment'].click();assert.equal(elements['enter-experiment'].attrs['aria-pressed'],'false');assert.equal(elements['experiment-panel'].hidden,true);assert.equal(elements.range.value,'14');assert.equal(JSON.stringify(ui.MemoryWorkspace.dataset),originalDemo);assert.equal(ui.MemoryWorkspace.selected,demoSelection);
await elements['enter-experiment'].click();assert.equal(graph.items.size,0);await elements['leave-experiment'].click();
assert.deepEqual(storageWrites,[['memory-lab.intro-seen','1']],'只允许保存介绍已阅标记，不得持久化实验');
// Tauri适配层必须真正调用原生导出，且保留取消／失败语义。
const native=[];ui.__TAURI__={core:{invoke:async(command,args)=>{native.push({command,args});return true;}}};
await elements.export.click();assert.equal(native.length,1);assert.equal(native[0].command,'export_json');assert.deepEqual(M.parse(native[0].args.content),ds);delete ui.__TAURI__;
console.log('PASS：实际实验表单／双视图联动、演示状态往返、迟到导入隔离、角色拒绝、失败原子性、受控导出、重置／再进入清空、仅介绍标记持久化及Tauri原生导出适配（最小DOM）。');
// 页面离开（包括浏览器往返缓存）不能保留实验载荷；恢复页面触发重新加载。
await elements['enter-experiment'].click();elements['lab-value'].value='本次临时实验专用内容';await elements['experiment-form'].fire('submit');
assert(JSON.stringify(ui.MemoryWorkspace.dataset).includes('本次临时实验专用内容'));
windowHandlers.pagehide();assert(!ui.MemoryWorkspace.dataset.data.experiment);assert.equal(elements['lab-value'].value,'');assert.equal(elements['experiment-panel'].hidden,true);
let reloaded=0;ui.location={reload(){reloaded++;}};windowHandlers.pageshow({persisted:true});assert.equal(reloaded,1);
console.log('PASS：页面离开清空实验展示与载荷引用，缓存恢复重新初始化（事件夹具）。');
// 导入文件中的标记不能控制工作区模式或锁死恢复入口。
const tagged=JSON.parse(encoded);tagged.data.experiment={engine:'browser-deterministic.v1',temporary:true};const taggedBytes=new TextEncoder().encode(JSON.stringify(tagged));elements['import-file'].files=[{size:taggedBytes.length,arrayBuffer:async()=>taggedBytes.buffer}];await elements['import-file'].fire('change');
assert(elements.notice.textContent.includes('已导入'));assert.equal(elements.restore.disabled,false);assert.equal(elements.export.disabled,false);await elements.restore.click();assert(!ui.MemoryWorkspace.dataset.data.experiment);
console.log('PASS：导入记录标记不能取得实时实验控制权，恢复与导出仍可使用。');
elements['memory-browser'].open=false;elements['graph-fallback'].hidden=true;
sandbox.window={...ui,MemoryGraph:{...loaded,GraphView:class{constructor(){throw Error('synthetic WebGL unavailable');}}}};
vm.runInNewContext(fs.readFileSync(runtime+'app.js','utf8'),sandbox);
assert.equal(elements['memory-browser'].open,true);assert.equal(elements['graph-fallback'].hidden,false);assert(elements['node-list'].children.length>0);assert.equal(elements['detail-focus'].disabled,true);assert.equal(elements.reset.disabled,true);assert.equal(elements['graph-caption'].hidden,true);
console.log('PASS：公开网页版WebGL不可用时二维列表和时间轴仍可使用（合成故障）。');
