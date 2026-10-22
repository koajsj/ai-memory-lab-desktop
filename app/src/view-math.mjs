// 版本是独立节点；全回放目录预分配坐标，分区变化只改变高度。
export function stableLayout(catalog){
 const keyOf=n=>(typeof n==='string'?n:n.key).replace(/__previous$/,'');
 const idOf=n=>typeof n==='string'?keyOf(n):n.evidence?.version_id||(n.payload?keyOf(n)+'/'+n.payload.version:n.id||keyOf(n));
 const unique=new Map(catalog.map(n=>[idOf(n),n]));
 const sorted=[...unique].sort((a,b)=>keyOf(a[1]).localeCompare(keyOf(b[1]),'en')||(a[1].evidence?.revision||a[1].payload?.version||0)-(b[1].evidence?.revision||b[1].payload?.version||0)||a[0].localeCompare(b[0],'en'));
 const coords=new Map();
 function assign(key){const i=coords.size,angle=i*2.399963229728653,radius=3.1+2.05*Math.sqrt(i);const p=[Math.cos(angle)*radius,Math.sin(angle)*radius];coords.set(key,p);return p;}
 sorted.forEach(([id])=>assign(id));
 return node=>{const id=idOf(node);const [x,z]=coords.get(id)||assign(id);return [x,({current:1.2,task:4.4,completed:7.6,history:-2.6,pending:-.8,retired:-5.2})[node.state]??0,z];};
}
const dot=(a,b)=>a.reduce((s,v,i)=>s+v*b[i],0);
const normal=v=>{const l=Math.hypot(...v);return v.map(n=>n/l);};
export function fitView(points,aspect=1){
 const direction=normal([.35,.32,1]),right=normal([direction[2],0,-direction[0]]);
 const up=[direction[1]*right[2],direction[2]*right[0]-direction[0]*right[2],-direction[1]*right[0]];
 const tanY=Math.tan(43*Math.PI/360),tanX=tanY*Math.max(.2,aspect);
 const all=[[0,0,0],...points],min=[0,1,2].map(i=>Math.min(...all.map(p=>p[i]))),max=[0,1,2].map(i=>Math.max(...all.map(p=>p[i])));
 const target=min.map((v,i)=>(v+max[i])/2);let distance=5;
 for(const p of all)for(const x of [-.65,.65])for(const y of [-.6,1.2])for(const z of [-.65,.65]){
   const d=[p[0]+x-target[0],p[1]+y-target[1],p[2]+z-target[2]],depth=dot(d,direction);
   distance=Math.max(distance,depth+Math.abs(dot(d,right))/(tanX*.8),depth+Math.abs(dot(d,up))/(tanY*.8));
 }
 return {target,direction,right,up,tanX,tanY,distance,position:target.map((v,i)=>v+direction[i]*distance)};
}
// 屏幕标签避让：优先选中/本轮变化。隐藏的仅是标签，节点和列表完整保留。
export function placeLabels(labels,width,height){
 const placed=[];return [...labels].sort((a,b)=>b.priority-a.priority||String(a.id).localeCompare(String(b.id))).map(item=>{
   for(const offset of [-27,27,-54,54,-81,81]){
     const box={...item,x:Math.max(item.w/2+8,Math.min(width-item.w/2-8,item.x)),y:item.y+offset,visible:true};
     if(box.x-box.w/2<8||box.x+box.w/2>width-8||box.y-box.h/2<8||box.y+box.h/2>height-8)continue;
     if(placed.some(p=>Math.abs(p.x-box.x)<(p.w+box.w)/2+5&&Math.abs(p.y-box.y)<(p.h+box.h)/2+3))continue;
     if(labels.some(p=>Math.abs(p.x-box.x)<box.w/2+(p.radius??8)+3&&Math.abs(p.y-box.y)<box.h/2+(p.radius??8)+3))continue;
     placed.push(box);return box;
   }
   return {...item,visible:false};
 });
}
