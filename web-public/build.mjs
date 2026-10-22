import {build} from 'esbuild';
import {mkdir,rm,readFile,writeFile,copyFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {createRequire} from 'node:module';
const dir=path.dirname(fileURLToPath(import.meta.url)),require=createRequire(import.meta.url);
const M=require('./model.js');
const demo=JSON.parse(await readFile(path.join(dir,'src/public-demo.json'),'utf8'));M.adapt(demo);
await writeFile(path.join(dir,'data.js'),'window.REPLAY_DATA='+JSON.stringify(demo).replaceAll('<','\\u003c')+';\n');
await build({entryPoints:[path.join(dir,'src/graph.js')],bundle:true,format:'iife',globalName:'MemoryGraph',outfile:path.join(dir,'graph.bundle.js'),minify:true,legalComments:'eof',target:['safari16','chrome105']});
const dist=path.join(dir,'dist');await rm(dist,{recursive:true,force:true});await mkdir(dist);
const files={};
for(const n of ['index.html','style.css','platform.js','native-ui.js','sandbox.js','lab-ui.js','state.js','model.js','app.js','data.js','graph.bundle.js','icon.png','THIRD_PARTY_NOTICES.txt']){
  const bytes=await readFile(path.join(dir,n));files[n]=createHash('sha256').update(bytes).digest('hex');await copyFile(path.join(dir,n),path.join(dist,n));
}
await writeFile(path.join(dist,'assets-manifest.json'),JSON.stringify({application:'AI Memory Lab Web',mode:'SIMULATED',files},null,2)+'\n');
await writeFile(path.join(dist,'.nojekyll'),'');
console.log('PASS：独立虚构场景及本地Three.js静态资源已构建到dist；不含比赛材料或后端。');
