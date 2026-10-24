import {sync} from './sync-frontend.mjs';
import {mkdir,copyFile,rm,readFile,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {createHash} from 'node:crypto';
const dir=path.dirname(fileURLToPath(import.meta.url));
// The evaluation describes the fixed demo. Its historical core hashes remain
// evidence; current implementation inputs are bound by the source manifest.
export async function verifyInputs(root,data){
 const evaluation=JSON.parse(await readFile(path.join(root,'app/evaluation.json'),'utf8'));
 const current=JSON.parse(await readFile(path.join(root,'source-manifest.json'),'utf8'));
 if(current.format!=='memory-lab.private-source.v1')throw new Error('当前源码清单格式无效');
 for(const [file,historical]of Object.entries(evaluation.inputs)){
  const digest=file==='memory-rules.md'||file.startsWith('tools/')?current.files[file]?.sha256:historical;
  const bytes=file==='app/data.js'?Buffer.from(data):await readFile(path.join(root,file));
  if(createHash('sha256').update(bytes).digest('hex')!==digest)throw new Error('构建输入登记不一致：'+file+'；请核对当前源码清单或历史演示来源。');
 }
}
async function main(){
const {build}=await import('esbuild');
await sync();
// 独立模拟数据只有一个源码；先校验生成字节，再写出桌面运行资源。
const demo=JSON.parse(await readFile(path.join(dir,'../web-public/src/public-demo.json'),'utf8'));
const data='window.REPLAY_DATA='+JSON.stringify(demo).replaceAll('<','\\u003c')+';\n';
await verifyInputs(path.join(dir,'..'),data);
await writeFile(path.join(dir,'data.js'),data);
await build({entryPoints:[path.join(dir,'src/graph.js')],bundle:true,format:'iife',globalName:'MemoryGraph',outfile:path.join(dir,'graph.bundle.js'),minify:true,legalComments:'eof',target:['safari16','chrome105']});
await rm(path.join(dir,'web-dist'),{recursive:true,force:true});
await mkdir(path.join(dir,'web-dist'));
const runtime=['index.html','style.css','platform.js','native-ui.js','sandbox.js','lab-ui.js','state.js','model.js','app.js','data.js','graph.bundle.js','icon.png'];
const hashes={};
for(const file of runtime)hashes[file]=createHash('sha256').update(await readFile(path.join(dir,file))).digest('hex');
await writeFile(path.join(dir,'assets-manifest.json'),JSON.stringify({application:'AI Memory Lab',version:JSON.parse(await readFile(path.join(dir,'package.json'),'utf8')).version,files:hashes},null,2)+'\n');
for(const file of [...runtime,'assets-manifest.json','THIRD_PARTY_NOTICES.txt'])await copyFile(path.join(dir,file),path.join(dir,'web-dist',file));
console.log('PASS：本地Three.js资源与桌面静态目录已构建，不包含Node/Python运行时。');
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await main();
