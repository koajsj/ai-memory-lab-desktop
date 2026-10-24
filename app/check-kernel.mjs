// Fail closed before bundling an outdated or wrong-target governance worker.
import {readFile,lstat} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const app=path.dirname(fileURLToPath(import.meta.url)),sha=b=>createHash('sha256').update(b).digest('hex');
if(process.platform!=='win32')throw Error('交付内核只在Windows x64原生构建和校验；其他开发机使用源码原子检查');
const target=execFileSync('rustc',['-vV'],{encoding:'utf8'}).split('host: ')[1].split('\n')[0].trim();
if(target!=='x86_64-pc-windows-msvc')throw Error('交付内核需要Windows x64 MSVC工具链');
const m=JSON.parse(await readFile(path.join(app,'src-tauri/binaries/kernel-manifest.json'),'utf8'));
if(m.format!=='memory-lab.kernel-build.v1'||m.target!==target)throw Error('治理内核目标与当前原生工具链不一致');
const binary=path.join(app,'src-tauri/binaries/memory-kernel-'+target+'.exe');const info=await lstat(binary);
if(!info.isFile()||info.isSymbolicLink())throw Error('治理内核必须为普通文件');
if(m.sha256!==sha(await readFile(binary))||m.size!==info.size)throw Error('治理内核哈希或大小错误');
if(info.size>=50_000_000)throw Error('治理内核必须小于50 MB（50,000,000字节）');
for(const [file,hash]of Object.entries(m.inputs))if(hash!==sha(await readFile(path.join(app,'..',file))))throw Error('治理源码已改变，请重新执行 kernel:build：'+file);
console.log('PASS：治理内核目标架构、普通文件、大小、SHA-256及源码输入一致。');
