// web-public是共享前端权威源；桌面保留自己的数据、评估和原生配置。
import {copyFile,readFile,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const app=path.dirname(fileURLToPath(import.meta.url)),web=path.join(app,'../web-public');
export const shared=['index.html','style.css','state.js','model.js','app.js','platform.js','native-ui.js','sandbox.js','lab-ui.js','src/graph.js','src/view-math.mjs','src/audit.mjs'];
export async function sync(){for(const f of shared)await copyFile(path.join(web,f),path.join(app,f));
 let html=await readFile(path.join(app,'index.html'),'utf8');
 html=html.replace("connect-src 'none'","connect-src ipc: http://ipc.localhost");
 await writeFile(path.join(app,'index.html'),html);
 console.log('PASS：共享前端同步；桌面数据、评估与原生文件操作单独保留。');
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 if(process.argv.includes('--check')){for(const f of shared){let expected=await readFile(path.join(web,f),'utf8');if(f==='index.html')expected=expected.replace("connect-src 'none'","connect-src ipc: http://ipc.localhost");if(expected!==await readFile(path.join(app,f),'utf8'))throw Error('共享前端偏离权威源：'+f);}console.log('PASS：两端共享源码逐字节一致（仅CSP按平台区分）。');}
 else await sync();
}
