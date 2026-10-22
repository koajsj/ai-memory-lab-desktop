import {sync} from './sync-frontend.mjs';
await sync();
import {build} from 'esbuild';
import {mkdir,copyFile,rm,readFile,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {createHash} from 'node:crypto';
const dir=path.dirname(fileURLToPath(import.meta.url));
const evaluation=JSON.parse(await readFile(path.join(dir,'evaluation.json'),'utf8'));
for(const [file,digest]of Object.entries(evaluation.inputs)){if(createHash('sha256').update(await readFile(path.join(dir,'..',file))).digest('hex')!==digest)throw new Error('评估输入已改变，请先运行 python3 -B -m tools.memory_eval');}
await build({entryPoints:[path.join(dir,'src/graph.js')],bundle:true,format:'iife',globalName:'MemoryGraph',outfile:path.join(dir,'graph.bundle.js'),minify:true,legalComments:'eof',target:['safari16','chrome105']});
await rm(path.join(dir,'web-dist'),{recursive:true,force:true});
await mkdir(path.join(dir,'web-dist'));
const runtime=['index.html','style.css','platform.js','native-ui.js','sandbox.js','lab-ui.js','state.js','model.js','app.js','data.js','graph.bundle.js','icon.png'];
const hashes={};
for(const file of runtime)hashes[file]=createHash('sha256').update(await readFile(path.join(dir,file))).digest('hex');
await writeFile(path.join(dir,'assets-manifest.json'),JSON.stringify({application:'AI Memory Lab',version:JSON.parse(await readFile(path.join(dir,'package.json'),'utf8')).version,files:hashes},null,2)+'\n');
for(const file of [...runtime,'assets-manifest.json','THIRD_PARTY_NOTICES.txt'])await copyFile(path.join(dir,file),path.join(dir,'web-dist',file));
console.log('PASS：本地Three.js资源与桌面静态目录已构建，不包含Node/Python运行时。');
