# Windows 原生构建与验收

开发机使用 macOS；Windows 构建由私有仓库的 GitHub Actions `windows-latest` 完成，无须购买或更换设备。

本仓库提供应用构建源码和安装包，不是完整参赛包。正式提交还须在比赛项目中备齐当前守则、真实最终角色记忆、官方导出的单个原始log.json和策略说明报告.docx，按官方目录组织；不得用SIMULATED演示或实验导出替代平台成果。应用内核、真实日志、角色文件、背景卡及完整submission不进入公开网页版仓库。

## 源码与权限

公开仓库 `koajsj/teleagent` 仅维护静态网页版，不用于上传桌面内核。私有构建仓库为 `koajsj/ai-memory-lab-desktop`。上传前使用明确的文件白名单导出最小源码：

```sh
python3 -B app/prepare-windows-ci.py --output /新的项目外目录/ai-memory-lab-desktop
```

导出拒绝覆盖已有目录，不复制本地 Git 历史、二进制、官方原件、背景卡、官方回放、真实日志、角色私人记忆、内部评估或 submission。安装包内置独立虚构的 ATLAS_DEMO（SIMULATED），不替换本地比赛演示。导出的源码清单记录逐文件大小和 SHA-256；应用构建另行校验输入及资源。Python 内核和当前守则只进入经过授权的私有仓库。

## Actions 构建

工作流在 main 的构建相关文件变更时自动触发，也保留手动 `workflow_dispatch`，并拒绝在公开仓库执行。构建 Job 只读；main 推送的 Windows 构建、测试和安装包核验全部通过后，独立发布 Job 才获得 contents 写权限，从同一次运行的已核验 Artifact 创建私有 Release。手动运行只保留 Artifact，不发布 Release。不签名，也不生成 DMG 或比赛 ZIP。

1. Actions → **Windows native build** → **Run workflow**。
2. Runner 使用 x64 Node 22、Python 3.12、Rust stable MSVC 和仓库锁文件。在隔离 venv 中安装 PyInstaller 6.16.0、hooks-contrib 2026.9、pytest 8.4.2；Windows SDK/MSVC 来自托管 Windows 镜像。
3. 执行桌面服务定向测试、公开模拟数据的前端检查、原生网络适配器及 Credential Manager 合成凭据测试。两项仅针对比赛回放/提交文件的 Python 测试不属于私有构建集，仍保留在本地测试文件中。
4. 在 Windows 重新运行 PyInstaller，检查原生 sidecar 的目标、输入哈希和文件哈希。限制 PATH 后验证独立进程、中文/空格目录、保存恢复、导出删除、取消及异常终止恢复。
5. 运行现有 `npm --prefix app run desktop:windows`，产出 unsigned x64 NSIS；默认 WebView2 使用 embedBootstrapper：已有运行时可离线安装，缺失时联网下载；手动 Run workflow 勾选 offline_installer 可嵌入完整离线运行时。应用自身不要求评委安装 Python、Node 或开发工具。
6. 只有此前步骤及安装包/载荷完整性检查全部成功，才上传私有 Artifact，保留14天。main 推送随后下载同一 Artifact，复核安装包、提交哈希和 SHA256SUMS，附上安装包与校验文件并创建带运行编号的私有 Release；不重复构建。下载需拥有私有仓库访问权限。

构建使用 npm/pip/NSIS 下载缓存（后续步骤失败也保存）与按 Windows、Rust 工具链和依赖锁文件区分的 Cargo 依赖缓存；测试和安装器共用 release/x64 编译配置；前端在 Rust 测试前构建一次，Tauri 打包前仅重新核验内核，打包后逐项检查静态资源，避免再次编译同一前端。应用自身的编译产物在缓存前移除，源码变更仍会重新编译；资源、Python 内核和最终安装器每次重新生成与核验，不从缓存交付。纯文档推送不会自动构建；同分支新运行会取消过时运行。推送后由仓库所有者确认 Actions 与 Release 结果，不自动监控或重试。NSIS 使用 zlib，避免对已压缩的 WebView2 离线安装器进行耗时的 LZMA 重压缩；默认安装包不再内嵌完整 WebView2 运行时；离线选项仍保留完整运行时。没有修复后的同条件耗时对照，不报告提速比例。

原始安装包在 `app/src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis/`；核验后的文件在 `app/ci-artifact/`，包含 `AI-Memory-Lab-版本-windows-x64-setup.exe`、`windows-manifest.json`、`SHA256SUMS.txt`、`assets-manifest.json` 和 QUICKSTART。

```sh
node app/package-windows.mjs --verify-installer /实际下载解压目录
```

Tauri 会在打包前将主程序的 bundle type 从 `UNK` 改为 `NSS`，打包后恢复 Cargo 目录原文件。`beforeBundleCommand` 先记录本次编译输出（`release/compiler-input.json`）；`windows-hooks.nsh` 在 NSIS 编译期、主程序 `File` 指令前记录实际输入的路径、大小和 SHA-256（`release/nsis-input.json`），不在安装时调用 Node。整理器核对该记录与本次恢复后的编译输出、sidecar 源文件及提交一致，再生成交付清单。解包校验分别要求主程序与内核各有唯一文件、大小和哈希完全一致；不会用解包结果反填预期哈希。失败时输出实际路径及预期/实际大小、哈希，便于区分缺失、重复与字节差异。

清单的 `installation_status` 必须保持 NOT_RUN，直到独立记录真实安装验收。文件完整性通过不能证明首次启动或使用体验。为避免旧产物混入，整理器拒绝覆盖已有输出目录。现有便携版整理入口仍保留，但本流程不自动创建便携 ZIP。

## 验证边界

| 层级 | 验证方式 |
|---|---|
| Windows 原生编译 | Runner 实际 Tauri/MSVC 与 PyInstaller 构建 |
| Windows 自动化 | Rust/Node/Python 测试、合成系统凭据、原生 stdio 与本地模拟 HTTP |
| 安装包完整性 | PE、大小、SHA-256、当前输入、资源、sidecar及NSIS载荷 |
| 实际安装/首次启动/卸载 | 单独验收；不以构建或解包成功替代 |
| 真实供应商 API | 需要用户配置可信服务与有效 Key；CI 不使用真实 Key |
| 图形、鼠标、原生面板和 GPU 体验 | 人工验收；本轮不执行 GUI 自动化 |

Runner 不会证明干净用户电脑缺少开发工具时的完整 UI 行为，也不代表 Windows 11 人工体验已通过。Actions 日志与产物仅证明各自实际执行的步骤。Windows 未签名安装包可能触发 SmartScreen；不关闭系统防护。卸载沿用 Tauri 默认行为，不添加删除用户无关文件的钩子。

参考：[GitHub Artifact](https://docs.github.com/en/actions/tutorials/store-and-share-data)、[Tauri Windows安装器](https://v2.tauri.app/distribute/windows-installer/)。

## 体积基线与门槛

对 Release `windows-v1.1.0-39798792394-1` 下载文件逐字节校验 SHA256SUMS 后解包：安装包 227,984,954 字节，WebView2 离线安装器 214,156,024 字节，Tauri 主程序 12,593,664 字节，Python onefile 内核 9,373,585 字节。约217 MiB是安装包体积，并非内核体积。

内核归档共68项、120个 Python 模块；未发现 NumPy、PIL、pytest、Tk 或 setuptools。主要解压体积来自 Python DLL 6,945,272 字节、哈希用 libcrypto 5,231,472 字节、SQLite DLL 1,583,608 字节、PYZ 1,412,872 字节、UCRT 1,361,448 字节。这些运行依赖保留，不拆分 onefile 或删除治理功能。

`python app/build-kernel.py --audit /实际/memory-kernel.exe` 输出归档组成；构建清单保存完整内核大小、压缩/解压条目合计、最大条目及模块表。构建和打包前均要求实际内核 EXE **小于50,000,000字节**，超限阻止交付。Runner Summary 分别记录实际内核（含全部Python运行时）、主程序和安装包大小及哈希；新构建体积以本次 Runner 实测为准。未引入 UPX、LTO 或拆分运行时，避免增加启动风险、编译耗时或隐藏总大小。
