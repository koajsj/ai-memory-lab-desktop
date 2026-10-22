# Windows 原生构建与验收

开发机使用 macOS；Windows 构建由私有仓库的 GitHub Actions `windows-latest` 完成，无须购买或更换设备。

## 源码与权限

公开仓库 `koajsj/teleagent` 仅维护静态网页版，不用于上传桌面内核。私有构建仓库为 `koajsj/ai-memory-lab-desktop`。上传前使用明确的文件白名单导出最小源码：

```sh
python3 -B app/prepare-windows-ci.py --output /新的项目外目录/ai-memory-lab-desktop
```

导出拒绝覆盖已有目录，不复制本地 Git 历史、二进制、官方原件、背景卡、官方回放、真实日志、角色私人记忆、内部评估或 submission。安装包内置独立虚构的 ATLAS_DEMO（SIMULATED），不替换本地比赛演示。导出的源码清单记录逐文件大小和 SHA-256；应用构建另行校验输入及资源。Python 内核和当前守则只进入经过授权的私有仓库。

## Actions 构建

工作流在 main 的构建相关文件变更时自动触发，也保留手动 `workflow_dispatch`，并拒绝在公开仓库执行。使用只读 contents 权限、固定 SHA 的官方 Actions，不创建 Release，不签名，也不生成 DMG 或比赛 ZIP。

1. Actions → **Windows native build** → **Run workflow**。
2. Runner 使用 x64 Node 22、Python 3.12、Rust stable MSVC 和仓库锁文件。Python 构建依赖锁定 PyInstaller 6.16.0、pytest 8.4.2；Windows SDK/MSVC 来自托管 Windows 镜像。
3. 执行桌面服务定向测试、公开模拟数据的前端检查、原生网络适配器及 Credential Manager 合成凭据测试。两项仅针对比赛回放/提交文件的 Python 测试不属于私有构建集，仍保留在本地测试文件中。
4. 在 Windows 重新运行 PyInstaller，检查原生 sidecar 的目标、输入哈希和文件哈希。限制 PATH 后验证独立进程、中文/空格目录、保存恢复、导出删除、取消及异常终止恢复。
5. 运行现有 `npm --prefix app run desktop:windows`，产出 unsigned x64 NSIS；WebView2 使用 offlineInstaller，安装过程不要求下载运行时。应用自身不要求评委安装 Python、Node 或开发工具。
6. 只有此前步骤及安装包/载荷完整性检查全部成功，才上传私有 Artifact，保留14天。下载需拥有私有仓库访问权限；Artifact 是 Actions 的文件传输容器，不是正式比赛 ZIP。

构建使用 npm/pip 下载缓存与按 Rust 工具链、依赖锁文件和源码区分的 Cargo 缓存；测试和安装器共用 release/x64 编译配置。应用代码、资源、Python 内核和最终安装器每次重新生成与核验，不从缓存交付。纯文档推送不会自动构建；同分支新运行会取消过时运行。推送后由仓库所有者确认 Actions 结果，不自动监控或重试。尚无同等条件下的耗时对照，不报告提速比例。

原始安装包在 `app/src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis/`；核验后的文件在 `app/ci-artifact/`，包含 `AI-Memory-Lab-版本-windows-x64-setup.exe`、`windows-manifest.json`、`SHA256SUMS.txt`、`assets-manifest.json` 和 QUICKSTART。

```sh
node app/package-windows.mjs --verify-installer /实际下载解压目录
```

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
