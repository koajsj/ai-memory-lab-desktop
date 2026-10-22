(function(root){
  'use strict';
  function indices(data,source){return data.frames.map((f,i)=>({f,i})).filter(x=>source==='all'||x.f.source===source).map(x=>x.i);}
  function select(data,current,delta,source){
    const list=indices(data,source);if(!list.length)return -1;
    let p=list.indexOf(current);
    if(p<0)return list[0];
    return list[Math.max(0,Math.min(list.length-1,p+delta))];
  }
  function makeExport(data,index){
    if(!data.frames[index])throw new RangeError('轮次无效');
    return JSON.stringify({kind:'本地结构化回放导出，非TeleAgent日志',policy:data.policy,boundary:data.boundary,frame:data.frames[index]},null,2);
  }
  const api={indices,select,makeExport};
  if(typeof module!=='undefined')module.exports=api;else root.MemoryState=api;
})(typeof window!=='undefined'?window:globalThis);
