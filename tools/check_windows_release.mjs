// Windows交付校验器的独立回归；PE仅为内存头部样本，不是可运行程序。
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm,symlink} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {inspectPE,checkedFile,verifyRelease,verifyInstaller,sha256} from '../app/package-windows.mjs';

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
  const dir=path.join(tmp,'中文 空格');await (await import('node:fs/promises')).mkdir(dir);
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
  const manifest={format:'memory-lab.windows-installer.v1',target:'x86_64-pc-windows-msvc',build_status:'PASS',installation_status:'NOT_RUN',files:{[name]:{size:installer.length,sha256:sha256(installer)}}};
  await writeFile(path.join(dir,'windows-manifest.json'),JSON.stringify(manifest));
  await verifyInstaller(dir);
  await writeFile(path.join(dir,name),Buffer.from('damaged'));
  await assert.rejects(()=>verifyInstaller(dir));
  manifest.installation_status='PASS';await writeFile(path.join(dir,'windows-manifest.json'),JSON.stringify(manifest));
  await assert.rejects(()=>verifyInstaller(dir));
}finally{await rm(tmp,{recursive:true,force:true});}
console.log('PASS：Windows交付工具的PE架构/GUI、损坏头部、中文路径、哈希/大小、链接/路径逃逸及缺失/错误清单拒绝；未执行Windows程序或安装器。');
