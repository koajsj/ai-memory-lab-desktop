export {lifecycle,versionChain,provenance,lineage,lifecycleSummary,roleBoundary,auditEvents,lifecycleNames,authorityNames,sourceKindNames,decisionTrace,diagnostics,validationReport} from './audit.mjs';
import * as THREE from 'three';
import {fitView,stableLayout,placeLabels} from './view-math.mjs';
import {OrbitControls} from 'three/addons/controls/OrbitControls.js';

const graphemes=typeof Intl.Segmenter==='function'?new Intl.Segmenter(undefined,{granularity:'grapheme'}):null;
export const edgeColors={'主体归属':0xb6c0c6,'已存储历史版本':0x7c8993,SUPERSEDE:0x657d8b,DERIVE:0x1b6c80};
export class GraphView {
  constructor(host,{onSelect,onUnavailable,states}){
    this.host=host;this.onSelect=onSelect;this.onUnavailable=onUnavailable;this.states=states;this.items=new Map();this.destroyed=false;this.motion=true;
    this.scene=new THREE.Scene();this.scene.background=new THREE.Color(0xffffff);
    this.camera=new THREE.PerspectiveCamera(43,1,.1,160);this.camera.position.set(10,9,22);this.autoFrame=true;this.layout=stableLayout([]);
    this.renderer=new THREE.WebGLRenderer({antialias:true,alpha:false,powerPreference:'low-power'});
    this.renderer.setPixelRatio(Math.min(devicePixelRatio||1,1.75));host.appendChild(this.renderer.domElement);
    this.controls=new OrbitControls(this.camera,this.renderer.domElement);this.controls.enableDamping=true;this.controls.dampingFactor=.12;this.controls.minDistance=5;this.controls.maxDistance=400;this.controls.maxPolarAngle=Math.PI*.93;this.controls.target.set(0,.4,0);
    this.controls.addEventListener('change',()=>this.request());
    this.controls.addEventListener('start',()=>{this.autoFrame=false;this.focusTarget=null;});
    this.scene.add(new THREE.AmbientLight(0xffffff,1.8));const light=new THREE.DirectionalLight(0xdbe9f5,2.6);light.position.set(10,16,12);this.scene.add(light);
    const grid=new THREE.GridHelper(24,12,0xe8ecee,0xf4f6f7);grid.position.y=-5.2;this.scene.add(grid);this.grid=grid;
    this.nodeGeometry=new THREE.CircleGeometry(.27,24);
    this.role=new THREE.Mesh(new THREE.CircleGeometry(.32,24),new THREE.MeshStandardMaterial({color:0x6e808a,roughness:1,metalness:0}));this.scene.add(this.role);
    // 连线颜色按已登记关系类型着色，不推断语义或因果。
    this.lines=new THREE.LineSegments(new THREE.BufferGeometry(),new THREE.LineBasicMaterial({vertexColors:true,transparent:true,opacity:.38}));this.scene.add(this.lines);
    this.highlight=new THREE.LineSegments(new THREE.BufferGeometry(),new THREE.LineBasicMaterial({color:0x1b6c80,transparent:true,opacity:.95}));this.scene.add(this.highlight);
    this.ray=new THREE.Raycaster();this.pointer=new THREE.Vector2();this.down=null;
    this.pointerDown=e=>{this.down=e.button===0&&e.isPrimary!==false?[e.clientX,e.clientY,e.pointerId]:null;};
    this.pointerMove=e=>{if(this.down&&(e.pointerId!==this.down[2]||Math.hypot(e.clientX-this.down[0],e.clientY-this.down[1])>5))this.down=null;};
    this.pointerCancel=()=>{this.down=null;};this.pointerUp=e=>this.pick(e);
    this.contextLost=e=>{e.preventDefault();this.unavailable('WebGL上下文丢失，二维列表与时间轴仍可使用；重开应用可重试。');};
    this.renderer.domElement.addEventListener('pointerdown',this.pointerDown);this.renderer.domElement.addEventListener('pointerup',this.pointerUp);this.renderer.domElement.addEventListener('pointermove',this.pointerMove);this.renderer.domElement.addEventListener('pointercancel',this.pointerCancel);this.renderer.domElement.addEventListener('webglcontextlost',this.contextLost);
    this.resize=new ResizeObserver(()=>this.resizeToHost());this.resize.observe(host);
    this.last=performance.now();this.tick=this.tick.bind(this);this.resizeToHost();this.request();
  }
  resizeToHost(){
    if(this.destroyed)return;const w=this.host.clientWidth,h=this.host.clientHeight;if(!w||!h)return;
    this.camera.aspect=w/h;this.camera.updateProjectionMatrix();this.renderer.setSize(w,h);if(this.autoFrame&&this.model)this.fit(false);this.request();
  }
  stopInertia(){
    const position=this.camera.position.clone(),target=this.controls.target.clone(),damping=this.controls.enableDamping;
    this.controls.enableDamping=false;this.controls.update();this.camera.position.copy(position);this.controls.target.copy(target);this.controls.update();this.controls.enableDamping=damping;
  }
  text(text,color='#24282b'){
    const canvas=document.createElement('canvas');canvas.width=512;canvas.height=96;const c=canvas.getContext('2d');
    const font='500 48px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif';c.font=font;
    const chars=graphemes?Array.from(graphemes.segment(text),x=>x.segment):[text];let title=text;
    if(c.measureText(title).width>480){while(chars.length&&c.measureText(chars.join('')+'…').width>480)chars.pop();title=chars.join('')+'…';}
    canvas.width=Math.ceil(Math.max(96,c.measureText(title).width+32));c.font=font;
    c.fillStyle='rgba(255,255,255,.97)';c.strokeStyle='rgba(100,119,132,.16)';c.lineWidth=2;
    if(c.roundRect){c.beginPath();c.roundRect(2,2,canvas.width-4,92,12);c.fill();c.stroke();}else{c.fillRect(0,0,canvas.width,96);c.strokeRect(1,1,canvas.width-2,94);}
    c.textAlign='center';c.textBaseline='middle';c.fillStyle=color;c.fillText(title,canvas.width/2,48);
    const texture=new THREE.CanvasTexture(canvas);texture.colorSpace=THREE.SRGBColorSpace;
    const sprite=new THREE.Sprite(new THREE.SpriteMaterial({map:texture,depthTest:false,transparent:true}));sprite.userData.labelWidth=Math.ceil(canvas.width*26/96);sprite.scale.set(2.6,.49,1);return sprite;
  }
  setCatalog(keys){
    if(this.destroyed)return;
    for(const id of [...this.items.keys()])this.remove(id);
    this.down=null;this.layout=stableLayout(keys);this.autoFrame=true;this.focusTarget=null;this.model=null;this.selected=null;
    this.edges=[];this.edgeBuffer=null;this.lines.geometry.setDrawRange(0,0);this.highlight.geometry.setDrawRange(0,0);this.role.visible=false;if(this.roleLabel)this.roleLabel.visible=false;
    this.request();
  }
  fit(smooth=true){
    if(this.destroyed||!this.model||!this.host.clientHeight)return;
    this.stopInertia();
    const view=fitView(this.model.nodes.map(n=>this.layout(n)),this.host.clientWidth/this.host.clientHeight);
    this.controls.maxDistance=Math.max(400,view.distance*2);this.camera.far=Math.max(160,this.controls.maxDistance*2,view.distance*4);this.camera.updateProjectionMatrix();
    const target=new THREE.Vector3(...view.target),position=new THREE.Vector3(...view.position);
    if(smooth&&this.motion&&(target.distanceTo(this.controls.target)>.002||position.distanceTo(this.camera.position)>.002))this.focusTarget={target,position};
    else{this.controls.target.copy(target);this.camera.position.copy(position);this.focusTarget=null;this.controls.update();}
    this.request();
  }
  remove(id){const item=this.items.get(id);if(!item)return;this.scene.remove(item.group);item.mesh.material.dispose();item.label.material.map.dispose();item.label.material.dispose();this.items.delete(id);}
  setData(model,role,{animate=true,privateVisible=true}={}){
    if(this.destroyed)return;
    this.focusTarget=null;this.down=null;
    // 新轮次/筛选开始时清理上一轮退出动画，防止快速跳转残留。
    for(const [id,item] of this.items)if(item.exiting||!privateVisible)this.remove(id);
    const first=!this.model;
    this.role.visible=privateVisible;
    const roleText=privateVisible?role+' · 角色归属':'未授权视角：无私人节点';
    if(this.roleText!==roleText){
      if(this.roleLabel){this.scene.remove(this.roleLabel);this.roleLabel.material.map.dispose();this.roleLabel.material.dispose();}
      this.roleLabel=this.text(roleText);this.roleLabel.position.set(0,1.1,0);this.scene.add(this.roleLabel);this.roleText=roleText;
    }
    const ids=new Set(model.nodes.map(n=>n.id));if(!ids.has(this.selected))this.selected=null;
    for(const [id,item]of this.items){if(!ids.has(id)){if(this.motion&&animate){item.exiting=true;item.target=item.group.position.clone().add(new THREE.Vector3(0,-1.8,0));item.until=performance.now()+420;}else this.remove(id);}}
    for(const node of model.nodes){
      let item=this.items.get(node.id);const target=new THREE.Vector3(...this.layout(node));
      if(!item){
        const group=new THREE.Group(),material=new THREE.MeshStandardMaterial({color:this.states[node.state].color,roughness:1,metalness:0,transparent:true});
        const mesh=new THREE.Mesh(this.nodeGeometry,material);mesh.userData.id=node.id;group.add(mesh);
        const label=this.text(node.label);label.position.y=.7;group.add(label);group.position.copy(target);
        if(animate&&this.motion){group.position.multiplyScalar(.7);group.scale.setScalar(.05);}
        this.scene.add(group);item={group,mesh,label,target,exiting:false,node};this.items.set(node.id,item);
      }
      if(item.node.label!==node.label){
        item.group.remove(item.label);item.label.material.map.dispose();item.label.material.dispose();
        item.label=this.text(node.label);item.group.add(item.label);
      }
      item.target=target;item.node=node;item.exiting=false;item.mesh.material.emissive.setHex(0);
      if(!animate||!this.motion){item.group.position.copy(target);item.group.scale.setScalar(1);}
    }
    this.model=model;this.edges=model.edges.filter(edge=>ids.has(edge.to)&&(ids.has(edge.from)||edge.from==='role:'+role));
    if(this.autoFrame)this.fit(!first&&animate);
    if(!this.edgeBuffer||this.edgeBuffer.length!==this.edges.length*6){
      this.edgeBuffer=new Float32Array(this.edges.length*6);this.lines.geometry.dispose();this.lines.geometry=new THREE.BufferGeometry();
      this.lines.geometry.setAttribute('position',new THREE.BufferAttribute(this.edgeBuffer,3));this.lines.geometry.setAttribute('color',new THREE.BufferAttribute(new Float32Array(this.edgeBuffer.length),3));
    }
    this.lines.geometry.setDrawRange(0,this.edgeBuffer.length/3);
    const colors=this.lines.geometry.getAttribute('color'),color=new THREE.Color();this.edges.forEach((edge,i)=>{color.setHex(edgeColors[edge.type]??0x35515b);for(const k of [0,3])colors.array.set([color.r,color.g,color.b],i*6+k);});colors.needsUpdate=true;this.select(this.selected);
  }
  request(){if(!this.destroyed&&!this.raf)this.raf=requestAnimationFrame(this.tick);}
  drawInitial(){if(this.destroyed)return;cancelAnimationFrame(this.raf);this.raf=0;this.tick(performance.now());}
  tick(now){
    this.raf=0;if(this.destroyed)return;let moving=false;const dt=Math.max(0,Math.min((now-this.last)/1000,.05));this.last=Math.max(this.last,now);const alpha=1-Math.exp(-dt*12);
    for(const [id,item]of this.items){
      if(item.exiting&&!this.paused&&now>=item.until){this.remove(id);continue;}
      if(!this.paused&&(item.group.position.distanceTo(item.target)>.002||Math.abs(item.group.scale.x-1)>.002||item.exiting)){
        if(this.motion){item.group.position.lerp(item.target,alpha);item.group.scale.setScalar(item.group.scale.x+((item.exiting ? .01 : 1)-item.group.scale.x)*alpha);moving=true;}else{item.group.position.copy(item.target);item.group.scale.setScalar(1);}
      }else if(!this.paused&&!item.exiting){item.group.position.copy(item.target);item.group.scale.setScalar(1);
      }
    }
    if(this.focusTarget){const blend=1-Math.exp(-dt*16);this.controls.target.lerp(this.focusTarget.target,blend);this.camera.position.lerp(this.focusTarget.position,blend);moving=true;if(this.camera.position.distanceTo(this.focusTarget.position)<.002&&this.controls.target.distanceTo(this.focusTarget.target)<.002){this.controls.target.copy(this.focusTarget.target);this.camera.position.copy(this.focusTarget.position);this.focusTarget=null;}}
    if(this.edgeBuffer){let offset=0;for(const edge of this.edges||[]){const a=edge.from.startsWith('role:')?this.role.position:this.items.get(edge.from).group.position,b=this.items.get(edge.to).group.position;for(const v of [a,b]){this.edgeBuffer[offset++]=v.x;this.edgeBuffer[offset++]=v.y;this.edgeBuffer[offset++]=v.z;}}this.lines.geometry.attributes.position.needsUpdate=true;this.lines.geometry.computeBoundingSphere();}
    this.controls.update();this.updateLabels();this.updateHighlight();try{this.renderer.render(this.scene,this.camera);}catch{this.unavailable('WebGL渲染异常，已释放三维场景；二维列表与时间轴仍可使用。');return;}if(this.destroyed)return;this.renderedFrames=(this.renderedFrames||0)+1;if(moving)this.request();
  }
  updateLabels(){
    this.camera.updateMatrixWorld();const width=this.host.clientWidth,height=this.host.clientHeight;if(!width||!height)return;
    this.role.quaternion.copy(this.camera.quaternion);
    const candidates=[];
    for(const [id,item]of this.items){
      item.mesh.quaternion.copy(this.camera.quaternion);
      const units=2*Math.max(.1,-item.group.position.clone().applyMatrix4(this.camera.matrixWorldInverse).z)*Math.tan(this.camera.fov*Math.PI/360)/height;item.mesh.scale.setScalar(Math.max(1,Math.min(4,units*5/.27))*(id===this.selected?1.2:1));
      const projected=item.group.position.clone().project(this.camera);item.label.visible=false;
      if(item.exiting||projected.z< -1||projected.z>1||Math.abs(projected.x)>1||Math.abs(projected.y)>1)continue;
      candidates.push({id,x:(projected.x+1)*width/2,y:(1-projected.y)*height/2,w:item.label.userData.labelWidth||142,h:26,radius:.27*item.mesh.scale.x*item.group.scale.x/units,priority:id===this.selected?3:item.node.changed?2:1});
    }
    const up=new THREE.Vector3(0,1,0).applyQuaternion(this.camera.quaternion);
    if(this.roleLabel){this.roleLabel.visible=false;if(this.role.visible){const p=this.role.position.clone().project(this.camera),units=2*Math.max(.1,-this.role.position.clone().applyMatrix4(this.camera.matrixWorldInverse).z)*Math.tan(this.camera.fov*Math.PI/360)/height;if(p.z>=-1&&p.z<=1&&Math.abs(p.x)<=1&&Math.abs(p.y)<=1)candidates.push({id:null,x:(p.x+1)*width/2,y:(1-p.y)*height/2,w:this.roleLabel.userData.labelWidth||154,h:26,priority:0,radius:.32/units});}}
    const anchors=new Map(candidates.map(x=>[x.id,x])),right=new THREE.Vector3(1,0,0).applyQuaternion(this.camera.quaternion);
    for(const box of placeLabels(candidates,width,height)){
      if(box.id===null){this.roleLabel.visible=box.visible;if(box.visible){const units=2*Math.max(.1,-this.role.position.clone().applyMatrix4(this.camera.matrixWorldInverse).z)*Math.tan(this.camera.fov*Math.PI/360)/height;this.roleLabel.scale.set(box.w*units,box.h*units,1);this.roleLabel.position.copy(this.role.position).addScaledVector(up,-(box.y-anchors.get(null).y)*units).addScaledVector(right,(box.x-anchors.get(null).x)*units);}continue;}
      const item=this.items.get(box.id);item.label.visible=box.visible;if(!box.visible)continue;
      const units=2*Math.max(.1,-item.group.position.clone().applyMatrix4(this.camera.matrixWorldInverse).z)*Math.tan(this.camera.fov*Math.PI/360)/height;
      item.label.scale.set(box.w*units/Math.max(item.group.scale.x,.05),box.h*units/Math.max(item.group.scale.y,.05),1);
      item.label.position.copy(up).multiplyScalar(-(box.y-anchors.get(box.id).y)*units/Math.max(item.group.scale.y,.05)).addScaledVector(right,(box.x-anchors.get(box.id).x)*units/Math.max(item.group.scale.x,.05));
    }
  }
  updateHighlight(){
    const points=[];for(const edge of this.edges||[])if(edge.from===this.selected||edge.to===this.selected){const a=edge.from.startsWith('role:')?this.role.position:this.items.get(edge.from)?.group.position,b=this.items.get(edge.to)?.group.position;if(a&&b)points.push(a.x,a.y,a.z,b.x,b.y,b.z);}
    // 属性复用，只有选中关系数量变化时才重新分配。
    let attr=this.highlight.geometry.getAttribute('position');
    if(!attr||attr.array.length!==points.length){this.highlight.geometry.dispose();this.highlight.geometry=new THREE.BufferGeometry();attr=new THREE.Float32BufferAttribute(points,3);this.highlight.geometry.setAttribute('position',attr);}else{attr.array.set(points);attr.needsUpdate=true;}
    this.highlight.geometry.setDrawRange(0,points.length/3);
    this.highlight.geometry.computeBoundingSphere();
  }
  pick(event){
    const down=this.down;this.down=null;
    if(this.destroyed||!down||event.button!==0||event.pointerId!==down[2]||Math.hypot(event.clientX-down[0],event.clientY-down[1])>5)return;
    const rect=this.renderer.domElement.getBoundingClientRect();if(!rect.width||!rect.height)return;
    // 快速切轮到下一次GPU渲染之间，Raycaster也必须使用最新世界变换。
    this.updateLabels();this.scene.updateMatrixWorld(true);
    this.pointer.set((event.clientX-rect.left)/rect.width*2-1,-(event.clientY-rect.top)/rect.height*2+1);this.ray.setFromCamera(this.pointer,this.camera);
    const hit=this.ray.intersectObjects([...this.items.values()].filter(x=>!x.exiting).map(x=>x.mesh))[0];if(hit)this.onSelect(hit.object.userData.id);
  }
  select(id){
    if(this.destroyed)return;id=this.items.has(id)&&!this.items.get(id).exiting?id:null;
    this.selected=id;this.lines.material.opacity=id? .2 : .38;const related=new Set([id]);for(const edge of this.edges||[])if(edge.from===id||edge.to===id){related.add(edge.from);related.add(edge.to);}
    for(const [key,item]of this.items){item.mesh.material.color.setHex(key===id?0x124d5c:this.states[item.node.state].color);item.mesh.material.emissive.setHex(0);item.mesh.material.opacity=id&&!related.has(key)?.65:1;item.label.material.color.setHex(0xffffff);}
    this.request();
  }
  setPaused(paused){if(this.destroyed)return;const now=performance.now();if(paused&&!this.paused)this.pausedAt=now;if(!paused&&this.paused)for(const item of this.items.values())if(item.exiting)item.until+=now-this.pausedAt;this.paused=paused;this.last=now;this.request();}
  focus(id){if(this.destroyed)return;const item=this.items.get(id);if(!item||item.exiting)return;this.stopInertia();this.autoFrame=false;const target=item.target.clone(),direction=this.camera.position.clone().sub(this.controls.target).normalize(),position=target.clone().addScaledVector(direction,9);this.focusTarget={target,position};if(!this.motion){this.controls.target.copy(target);this.camera.position.copy(position);this.focusTarget=null;this.controls.update();}this.request();}
  reset(){if(this.destroyed)return;this.autoFrame=true;this.fit(true);}
  configure({motion,low}){if(this.destroyed)return;this.stopInertia();this.motion=motion;this.controls.enableDamping=motion;this.renderer.setPixelRatio(low?1:Math.min(devicePixelRatio||1,1.75));this.resizeToHost();if(!motion){for(const [id,item]of this.items){if(item.exiting)this.remove(id);else{item.group.position.copy(item.target);item.group.scale.setScalar(1);}}if(this.focusTarget){this.controls.target.copy(this.focusTarget.target);this.camera.position.copy(this.focusTarget.position);this.focusTarget=null;this.controls.update();}}this.request();}
  unavailable(message){if(this.destroyed)return;this.dispose();this.onUnavailable(message);}
  dispose(){
    if(this.destroyed)return;this.destroyed=true;cancelAnimationFrame(this.raf);this.resize.disconnect();this.controls.dispose();
    const canvas=this.renderer.domElement;canvas.removeEventListener('pointerdown',this.pointerDown);canvas.removeEventListener('pointerup',this.pointerUp);canvas.removeEventListener('pointermove',this.pointerMove);canvas.removeEventListener('pointercancel',this.pointerCancel);canvas.removeEventListener('webglcontextlost',this.contextLost);this.down=null;
    for(const id of [...this.items.keys()])this.remove(id);this.nodeGeometry.dispose();this.lines.geometry.dispose();this.lines.material.dispose();this.highlight.geometry.dispose();this.highlight.material.dispose();this.role.geometry.dispose();this.role.material.dispose();this.grid.geometry.dispose();if(Array.isArray(this.grid.material))this.grid.material.forEach(x=>x.dispose());else this.grid.material.dispose();
    if(this.roleLabel){this.roleLabel.material.map.dispose();this.roleLabel.material.dispose();}this.renderer.dispose();canvas.remove();
  }
}
