(function(root){
  'use strict';
  function indices(data,source){return data.frames.map((f,i)=>({f,i})).filter(x=>source==='all'||x.f.source===source).map(x=>x.i);}
  function select(data,current,delta,source){
    const list=indices(data,source);if(!list.length)return -1;
    let p=list.indexOf(current);
    if(p<0)return list[0];
    return list[Math.max(0,Math.min(list.length-1,p+delta))];
  }
  const api={indices,select};
  if(typeof module!=='undefined')module.exports=api;else root.MemoryState=api;
})(typeof window!=='undefined'?window:globalThis);
