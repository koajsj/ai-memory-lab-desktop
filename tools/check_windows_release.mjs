// Windows交付校验器的独立回归；PE仅为内存头部样本，不是可运行程序。
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,mkdir,copyFile,rm,symlink,readFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as packaging from '../app/package-windows.mjs';
import {verifyInputs} from '../app/build.mjs';
const {inspectPE,checkedFile,verifyRelease,verifyInstaller,sha256}=packaging;

function header(machine=0x8664,magic=0x20b,subsystem=2){
  const b=Buffer.alloc(512);b.write('MZ');b.writeUInt32LE(128,60);b.write('PE\0\0',128);
  b.writeUInt16LE(machine,132);b.writeUInt16LE(0x22,150);b.writeUInt16LE(240,148);
  b.writeUInt16LE(magic,152);b.writeUInt16LE(subsystem,220);return b;
}
assert.equal(inspectPE(header(),true).architecture,'x64');
assert.equal(inspectPE(header(0x14c,0x10b),false).architecture,'x86'); // NSIS启动器可为x86。
for(const b of [Buffer.alloc(10),header(0xaa64),header(0x14c,0x10b),header(0x8664,0x20b,3)])assert.throws(()=>inspectPE(b,true));
const invalid=header();invalid.writeUInt32LE(9999,60);assert.throws(()=>inspectPE(invalid,true));
const tmp=await mkdtemp(path.join(os.tmpdir(),'memory-windows-check-'));
try{
  // Current implementation provenance is independent of an immutable demo evaluation.
  const project=path.join(tmp,'build-inputs');await mkdir(path.join(project,'app'),{recursive:true});await mkdir(path.join(project,'tools'));
  const core=Buffer.from('current core'),data='fixed demo';
  const evaluation=JSON.stringify({inputs:{'tools/governance.py':sha256(Buffer.from('historical core')),'app/data.js':sha256(Buffer.from(data))}});
  await writeFile(path.join(project,'app/evaluation.json'),evaluation);
  await writeFile(path.join(project,'tools/governance.py'),core);
  const sources={format:'memory-lab.private-source.v1',files:{'tools/governance.py':{sha256:sha256(core)}}};
  const registry=path.join(project,'source-manifest.json');await writeFile(registry,JSON.stringify(sources));
  await verifyInputs(project,data);
  await assert.rejects(()=>verifyInputs(project,'changed demo'),/app\/data.js/);
  sources.files['tools/governance.py'].sha256='0'.repeat(64);await writeFile(registry,JSON.stringify(sources));
  await assert.rejects(()=>verifyInputs(project,data),/governance/);
  delete sources.files['tools/governance.py'];await writeFile(registry,JSON.stringify(sources));
  await assert.rejects(()=>verifyInputs(project,data),/governance/);
  assert.equal(await readFile(path.join(project,'app/evaluation.json'),'utf8'),evaluation);
  const dir=path.join(tmp,'中文 空格');await mkdir(dir);
  const bytes=Buffer.from('仅为文件完整性样本');await writeFile(path.join(dir,'payload.bin'),bytes);
  const record={size:bytes.length,sha256:sha256(bytes)};
  await checkedFile(dir,'payload.bin',record);
  for(const name of ['../payload.bin','C:\\secret','a/b','a\\b'])await assert.rejects(()=>checkedFile(dir,name,record));
  await assert.rejects(()=>checkedFile(dir,'payload.bin',{...record,sha256:'0'.repeat(64)}));
  await assert.rejects(()=>checkedFile(dir,'payload.bin',{...record,size:1}));
  try{await symlink(path.join(dir,'payload.bin'),path.join(dir,'link.bin'));await assert.rejects(()=>checkedFile(dir,'link.bin',record));}
  catch(e){if(process.platform!=='win32'||e.code!=='EPERM')throw e;console.log('NOT_RUN：当前Windows账户不允许创建测试链接。');}
  await assert.rejects(()=>verifyRelease(dir)); // 缺失清单不能通过。
  await writeFile(path.join(dir,'windows-manifest.json'),JSON.stringify({format:'unknown',files:{}}));
  await assert.rejects(()=>verifyRelease(dir));
  await writeFile(path.join(dir,'windows-manifest.json'),JSON.stringify({format:'memory-lab.windows-release.v1',target:'x86_64-pc-windows-msvc',delivery_status:'PASS',files:{}}));
  await assert.rejects(()=>verifyRelease(dir)); // 工具不能自行宣布实机验收PASS。
  const installer=header(0x14c,0x10b),name='AI-Memory-Lab-setup.exe';
  await writeFile(path.join(dir,name),installer);
  const payload={application_sha256:sha256(header()),application_size:512,kernel_sha256:sha256(header(0x8664,0x20b,3)),kernel_size:512};
  const manifest={payload,format:'memory-lab.windows-installer.v1',target:'x86_64-pc-windows-msvc',build_status:'PASS',installation_status:'NOT_RUN',files:{[name]:{size:installer.length,sha256:sha256(installer)}}};
  await writeFile(path.join(dir,'windows-manifest.json'),JSON.stringify(manifest));
  await verifyInstaller(dir);
  manifest.source_commit='a'.repeat(40);
  await writeFile(path.join(dir,'windows-manifest.json'),JSON.stringify(manifest));
  const sums=path.join(dir,'SHA256SUMS.txt');
  await writeFile(sums,`${sha256(installer)}  ${name}\r\n`);
  await packaging.verifyPublishableInstaller(dir,manifest.source_commit);
  await assert.rejects(()=>packaging.verifyPublishableInstaller(dir,'b'.repeat(40)),/提交/);
  await writeFile(sums,`${'0'.repeat(64)}  ${name}\r\n`);
  await assert.rejects(()=>packaging.verifyPublishableInstaller(dir,manifest.source_commit),/校验/);
  await rm(sums);
  await assert.rejects(()=>packaging.verifyPublishableInstaller(dir,manifest.source_commit));
  await writeFile(path.join(dir,name),Buffer.from('damaged'));
  await assert.rejects(()=>verifyInstaller(dir));
  // Tauri patches UNK -> NSS while makensis reads the file, then restores UNK.
  // The capture must bind the actual NSIS input to the restored compiler output.
  const release=path.join(dir,'release'),external=path.join(dir,'binaries');
  await mkdir(release);await mkdir(external);
  const executable=path.join(release,'ai-memory-lab.exe');
  const kernel=path.join(external,'memory-kernel-x86_64-pc-windows-msvc.exe');
  const original=header(),patched=header(),worker=header(0x8664,0x20b,3);
  original.write('__TAURI_BUNDLE_TYPE_VAR_UNK',300);
  patched.write('__TAURI_BUNDLE_TYPE_VAR_NSS',300);
  await writeFile(executable,original);await writeFile(kernel,worker);
  await packaging.captureCompilerInput(executable);
  await writeFile(executable,patched);
  const input=await packaging.captureNsisInput(executable,kernel);
  assert.equal(input.application.sha256,sha256(patched));
  assert.notEqual(input.application.sha256,sha256(original));
  await writeFile(executable,original); // the normal post-bundle restore
  const captured=await packaging.verifyNsisInput(release,kernel,input.source_commit);
  assert.equal(captured.application.sha256,sha256(patched));
  const extracted=path.join(dir,'extracted');await mkdir(extracted);
  await writeFile(path.join(extracted,'ai-memory-lab.exe'),patched);
  await writeFile(path.join(extracted,'memory-kernel.exe'),worker);
  const actual={application_sha256:input.application.sha256,application_size:patched.length,kernel_sha256:sha256(worker),kernel_size:worker.length};
  await packaging.verifyExtractedPayload(extracted,actual);
  // Exact-size stale/modified bytes must fail, even with the same filename.
  await writeFile(path.join(extracted,'ai-memory-lab.exe'),original);
  await assert.rejects(()=>packaging.verifyExtractedPayload(extracted,actual),/ai-memory-lab.exe/);
  await writeFile(path.join(extracted,'ai-memory-lab.exe'),patched);
  const nested=path.join(extracted,'old');await mkdir(nested);
  await copyFile(path.join(extracted,'ai-memory-lab.exe'),path.join(nested,'ai-memory-lab.exe'));
  await assert.rejects(()=>packaging.verifyExtractedPayload(extracted,actual),/ai-memory-lab.exe/);
  await rm(nested,{recursive:true});await rm(path.join(extracted,'memory-kernel.exe'));
  await assert.rejects(()=>packaging.verifyExtractedPayload(extracted,actual),/memory-kernel.exe/);
  const newer=Buffer.from(original);newer[400]=1;await writeFile(executable,newer);
  await assert.rejects(()=>packaging.verifyNsisInput(release,kernel,input.source_commit),/compiler|编译/);
  await writeFile(executable,original);
  await assert.rejects(()=>packaging.verifyNsisInput(release,kernel,'different-commit'),/commit|提交/);
  const captureFile=path.join(release,'nsis-input.json');
  const other=path.join(dir,'other','ai-memory-lab.exe');await mkdir(path.dirname(other));await writeFile(other,original);
  const wrongPath={...input,application:{...input.application,path:other}};
  await writeFile(captureFile,JSON.stringify(wrongPath));
  await assert.rejects(()=>packaging.verifyNsisInput(release,kernel,input.source_commit),/path|路径/);
  await rm(captureFile);
  await assert.rejects(()=>packaging.verifyNsisInput(release,kernel,input.source_commit));
  manifest.installation_status='PASS';await writeFile(path.join(dir,'windows-manifest.json'),JSON.stringify(manifest));
  await assert.rejects(()=>verifyInstaller(dir));
}finally{await rm(tmp,{recursive:true,force:true});}
console.log('PASS：Windows PE/清单/路径校验，打包前与NSIS编译输入登记、恢复后绑定、正确载荷通过，错误/旧/重复/缺失载荷及错误路径/提交拒绝；未执行Windows程序或安装器。');
