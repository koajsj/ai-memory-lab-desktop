/* 浏览器与Tauri只在这里区分文件能力；数据处理始终在本机。 */
(function(root){
'use strict';
async function save(content,name='memory-lab-simulated.json'){
 if(root.__TAURI__?.core){const saved=await root.__TAURI__.core.invoke('export_json',{content});return saved?'已保存本地模拟文件。':'已取消保存。';}
 const url=URL.createObjectURL(new Blob([content],{type:'application/json;charset=utf-8'}));
 try{const a=root.document.createElement('a');a.href=url;a.download=name;a.click();}finally{root.setTimeout(()=>URL.revokeObjectURL(url),1000);}
 return '已请求浏览器下载本地模拟JSON，不是官方日志。';
}
const api={save};if(typeof module!=='undefined')module.exports=api;else root.MemoryPlatform=api;
})(typeof window!=='undefined'?window:globalThis);
