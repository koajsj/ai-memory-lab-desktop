// Windows原生构建成功后整理交付；不签名、不发布，不替代实机验收。
import {readFile,writeFile,mkdir,mkdtemp,copyFile,readdir,lstat,rename,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
export const sha256=b=>createHash('sha256').update(b).digest('hex');
export function inspectPE(b,application=true,subsystem=2){
  if(b.length<64||b.toString('ascii',0,2)!=='MZ')throw Error('不是有效Windows程序');
  const p=b.readUInt32LE(60);
  if(p<64||p+96>b.length||b.toString('ascii',p,p+4)!=='PE\0\0')throw Error('PE头损坏');
  const machine=b.readUInt16LE(p+4),optional=b.readUInt16LE(p+24),flags=b.readUInt16LE(p+22);
  if(![0x8664,0x14c].includes(machine)||optional!==(machine===0x8664?0x20b:0x10b)
      ||!(flags&2)||(flags&0x2000)||b.readUInt16LE(p+92)!==subsystem
      ||(application&&machine!==0x8664))throw Error('程序架构或GUI类型不符');
  return {architecture:machine===0x8664?'x64':'x86',subsystem:'Windows GUI'};
}
export async function checkedFile(dir,name,record){
  if(!/^[A-Za-z0-9][A-Za-z0-9 ._-]*$/.test(name)||name.includes('..')||name.endsWith('.'))throw Error('不安全文件名');
  const file=path.join(dir,name),s=await lstat(file);
  if(!s.isFile()||s.isSymbolicLink())throw Error('拒绝非普通文件');
  const b=await readFile(file);
  if(b.length!==record.size||sha256(b)!==record.sha256)throw Error('交付文件大小或哈希不一致');
  return b;
}
export async function verifyRelease(dir){
  const m=JSON.parse(await readFile(path.join(dir,'windows-manifest.json'),'utf8'));
  if(m.format!=='memory-lab.windows-release.v1'||m.target!=='x86_64-pc-windows-msvc'
      ||m.delivery_status!=='NOT_RUN'||!m.files||Object.keys(m.files).length!==2
      ||!Object.keys(m.files).some(n=>n.endsWith('-setup.exe'))||!Object.keys(m.files).some(n=>n.endsWith('-portable.zip')))throw Error('Windows交付清单无效；实机验收另行记录');
  for(const [n,r]of Object.entries(m.files))await checkedFile(dir,n,r);
  return m;
}
export async function verifyInstaller(dir){
  const m=JSON.parse(await readFile(path.join(dir,'windows-manifest.json'),'utf8'));
  if(m.format!=='memory-lab.windows-installer.v1'||m.target!=='x86_64-pc-windows-msvc'
      ||m.build_status!=='PASS'||m.installation_status!=='NOT_RUN'||!m.files||Object.keys(m.files).length!==1)throw Error('Windows安装包清单无效');
  for(const [n,r]of Object.entries(m.files)){if(!n.endsWith('-setup.exe'))throw Error('安装包文件名无效');inspectPE(await checkedFile(dir,n,r),false);}
  return m;
}
const app=path.dirname(fileURLToPath(import.meta.url));
function powershell(script,env={}){
  execFileSync('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-Command',"$ErrorActionPreference='Stop'; "+script],{stdio:'inherit',env:{...process.env,...env}});
}
async function inspectBuild(){
  if(process.platform!=='win32'||process.arch!=='x64')throw Error('BLOCKED：须在原生Windows x64及64位Node环境构建和整理');
  const version=JSON.parse(await readFile(path.join(app,'package.json'),'utf8')).version;
  const release=path.join(app,'src-tauri/target/x86_64-pc-windows-msvc/release');
  const executable=path.join(release,'ai-memory-lab.exe');
  const installers=(await readdir(path.join(release,'bundle/nsis'))).filter(n=>n.endsWith(`_${version}_x64-setup.exe`));
  if(installers.length!==1)throw Error('必须有唯一对应当前版本的x64 NSIS安装器');
  const installer=path.join(release,'bundle/nsis',installers[0]);
  inspectPE(await readFile(executable));inspectPE(await readFile(installer),false);
  const kernel=path.join(release,'memory-kernel.exe');inspectPE(await readFile(kernel),true,3);
  execFileSync(process.execPath,[path.join(app,'check-kernel.mjs')],{stdio:'inherit'});
  const km=JSON.parse(await readFile(path.join(app,'src-tauri/binaries/kernel-manifest.json'),'utf8'));
  if(sha256(await readFile(kernel))!==km.sha256)throw Error('发布目录治理内核与登记不一致');
  const assets=JSON.parse(await readFile(path.join(app,'assets-manifest.json'),'utf8'));
  for(const [n,h]of Object.entries(assets.files)){
    const b=await readFile(path.join(app,n));
    if(sha256(b)!==h||!b.equals(await readFile(path.join(app,'web-dist',n))))throw Error('前端构建资源不一致');
  }
  // 原生构建后的资源应比生成物旧；失败的构建不得复用旧程序打包。
  const nativeSources=['src-tauri/src/main.rs','src-tauri/src/model_api.rs','src-tauri/src/desktop.rs','src-tauri/binaries/kernel-manifest.json','src-tauri/Cargo.toml','src-tauri/Cargo.lock','src-tauri/tauri.conf.json','src-tauri/tauri.windows.conf.json'];
  const builtAt=Math.min((await lstat(executable)).mtimeMs,(await lstat(installer)).mtimeMs);
  for(const n of [...Object.keys(assets.files),...nativeSources])if((await lstat(path.join(app,n))).mtimeMs>builtAt)throw Error('构建产物早于输入，请先重新原生构建');
  return {version,release,executable,installer,kernel,km,assets};
}
async function collectInstaller(){
  const {version,executable,installer,kernel,km,assets}=await inspectBuild();
  const target=path.join(app,'ci-artifact');await mkdir(target); // refuse to mix an older run's outputs
  const name=`AI-Memory-Lab-${version}-windows-x64-setup.exe`,bytes=await readFile(installer);
  await copyFile(installer,path.join(target,name));
  const m={format:'memory-lab.windows-installer.v1',version,target:'x86_64-pc-windows-msvc',build_status:'PASS',installation_status:'NOT_RUN',signing:'unsigned',source_commit:process.env.GITHUB_SHA||null,kernel:km,assets:assets.files,
    payload:{application_sha256:sha256(await readFile(executable)),kernel_sha256:sha256(await readFile(kernel))},files:{[name]:{size:bytes.length,sha256:sha256(bytes)}}};
  await writeFile(path.join(target,'windows-manifest.json'),JSON.stringify(m,null,2)+'\n');
  await writeFile(path.join(target,'SHA256SUMS.txt'),sha256(bytes)+'  '+name+'\r\n');
  await copyFile(path.join(app,'QUICKSTART.md'),path.join(target,'QUICKSTART.md'));
  await copyFile(path.join(app,'assets-manifest.json'),path.join(target,'assets-manifest.json'));
  await verifyInstaller(target);
  console.log(JSON.stringify(m,null,2));
}
async function packageRelease(runtime){
  const {version,executable,installer,kernel,km,assets}=await inspectBuild();
  const runtimePath=path.resolve(runtime);
  if(path.basename(runtimePath)!=='MicrosoftEdgeWebView2RuntimeInstallerX64.exe'||(await lstat(runtimePath)).size<20*1024*1024)throw Error('须提供微软x64 Standalone离线安装器，不能用在线Bootstrapper');
  powershell("$s=Get-AuthenticodeSignature -LiteralPath $env:MEMORY_LAB_RUNTIME; if($s.Status -ne 'Valid' -or $s.SignerCertificate.Subject -notmatch 'O=Microsoft Corporation'){throw 'Invalid Microsoft runtime signature'}",{MEMORY_LAB_RUNTIME:runtimePath});
  const parent=path.join(app,'releases');await mkdir(parent,{recursive:true});
  const name=`AI-Memory-Lab-${version}-windows-x64`,target=path.join(parent,name);
  try{await lstat(target);throw Error('交付目录已存在，拒绝覆盖原包；请先人工确认旧版本归属');}catch(e){if(e.code!=='ENOENT')throw e;}
  const temp=await mkdtemp(path.join(parent,'.windows-'));
  try{
    const stage=path.join(temp,'portable');await mkdir(stage);
    for(const [source,dest]of [[executable,'AI Memory Lab.exe'],[kernel,'memory-kernel.exe'],[runtimePath,'MicrosoftEdgeWebView2RuntimeInstallerX64.exe'],[path.join(app,'QUICKSTART.md'),'QUICKSTART.md'],[path.join(app,'THIRD_PARTY_NOTICES.txt'),'THIRD_PARTY_NOTICES.txt']])await copyFile(source,path.join(stage,dest));
    const sums=[];for(const n of await readdir(stage))sums.push(sha256(await readFile(path.join(stage,n)))+'  '+n);
    await writeFile(path.join(stage,'SHA256SUMS.txt'),sums.join('\r\n')+'\r\n','utf8');
    const zip=name+'-portable.zip',setup=name+'-setup.exe';await copyFile(installer,path.join(temp,setup));
    powershell("Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::CreateFromDirectory($env:MEMORY_LAB_STAGE,$env:MEMORY_LAB_ZIP); $z=[IO.Compression.ZipFile]::OpenRead($env:MEMORY_LAB_ZIP); try { $files=Get-ChildItem -LiteralPath $env:MEMORY_LAB_STAGE -File; if($z.Entries.Count -ne $files.Count){throw 'ZIP count mismatch'}; foreach($f in $files){$e=@($z.Entries | Where-Object {$_.FullName -ceq $f.Name}); if($e.Count -ne 1){throw 'ZIP entry mismatch'}; $stream=$e[0].Open(); $hash=[Security.Cryptography.SHA256]::Create(); try{$actual=([BitConverter]::ToString($hash.ComputeHash($stream))).Replace('-',''); if($actual -ne (Get-FileHash -LiteralPath $f.FullName -Algorithm SHA256).Hash){throw 'ZIP content mismatch'}}finally{$stream.Dispose();$hash.Dispose()}} }finally{$z.Dispose()}",{MEMORY_LAB_STAGE:stage,MEMORY_LAB_ZIP:path.join(temp,zip)});
    const files={};for(const n of [setup,zip]){const b=await readFile(path.join(temp,n));files[n]={size:b.length,sha256:sha256(b)};}
    const m={format:'memory-lab.windows-release.v1',application:'AI Memory Lab',version,target:'x86_64-pc-windows-msvc',build_status:'PASS',delivery_status:'NOT_RUN',signing:'unsigned',kernel:km,assets:assets.files,files,acceptance:'Windows首次安装、断网、原生对话框、卸载重装及无开发环境验收须另行记录'};
    await writeFile(path.join(temp,'windows-manifest.json'),JSON.stringify(m,null,2)+'\n');
    await writeFile(path.join(temp,'SHA256SUMS.txt'),Object.entries(files).map(([n,r])=>r.sha256+'  '+n).join('\r\n')+'\r\n');
    await copyFile(path.join(app,'QUICKSTART.md'),path.join(temp,'QUICKSTART.md'));
    await rm(stage,{recursive:true});await verifyRelease(temp);await rename(temp,target);
    console.log('PASS：构建文件与ZIP完整性校验完成；Windows实机验收NOT_RUN。\n'+target);
  }finally{await rm(temp,{recursive:true,force:true});}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{
    if(process.argv[2]==='--ci-installer')await collectInstaller();
    else if(process.argv[2]==='--verify-installer'){await verifyInstaller(path.resolve(process.argv[3]));console.log('PASS：安装包普通文件、PE、大小、SHA-256及未验收状态一致。');}
    else if(process.argv[2]==='--verify'){await verifyRelease(path.resolve(process.argv[3]));console.log('PASS：Windows交付文件大小与SHA-256一致；实机状态见验收记录。');}
    else if(process.argv[2]==='--webview-installer'&&process.argv[3])await packageRelease(process.argv[3]);
    else throw Error('用法：node package-windows.mjs --webview-installer <微软x64离线安装器>；或 --verify <交付目录>');
  }catch(e){console.error(e.message);process.exitCode=1;}
}
