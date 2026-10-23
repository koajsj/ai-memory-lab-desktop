# AI Memory Lab

桌面版包含真实模型实验、28轮结构化演示和临时模拟沙盒。网页版保留静态模拟体验；模型实验只在 Tauri 桌面端开放。

## 真实模型实验

点击左侧“真实模型实验”：保存模型配置 → 导入 Markdown 或粘贴守则 → 新建实验 → 发送消息 → 逐项确认、隔离或忽略模型建议。对话与获准记忆会发给所选供应商，模型连接测试也可能计费；使用前确认 Base URL 可信。

支持 OpenAI Chat Completions、Anthropic Messages、Gemini GenerateContent；第三方服务选择 OpenAI 兼容协议，自填模型 ID。Base URL 填 API 前缀，如 `https://api.openai.com/v1`，不包含 `/chat/completions`。HTTPS 为默认要求；自建本机服务可使用 `http://localhost:端口/v1`。不绕过 TLS 验证，不跟随重定向。兼容服务若不支持 SSE，可关闭“流式回复”。

Key 默认仅保留在 Rust 进程内；选中保存时交给系统凭据库（Windows Credential Manager、macOS Keychain）。模型配置只保存非敏感字段。编辑配置时重新填写 Key；不保存 Key 的自建服务可留空。不要在聊天中粘贴凭据。

真实模型实验持久化在系统应用本地数据目录 `local.memorylab.desktop/experiments.sqlite`。每个实验保存守则原文及 SHA-256，旧实验不随新守则改变；“重置为新实验”保留原实验并新建空状态。请求中断后通过“结束上次中断请求并恢复”继续；模型输出和记忆提交分别保存、分别展示。

模型只提出候选。未确认的普通新增只能进入待核实区；更正、派生、删除、完成与重建须本人确认，随后仍由原 Python Store 检查来源、权限、时间、冲突、敏感字段和谱系。请求上下文使用最近至多20轮、合计64000字符以内的完整对话，以及至多32条获准记忆，不宣称无限上下文。一个实验对应独立 LOCAL 角色数据库，不提供多人身份认证或跨角色共享授权。自然语言理解、组合敏感性检测和整份守则的模型遵循不由结构化内核保证；暂停/恢复任务尚无对应内核操作，不伪装成取消或完成。

删除清除本实验内可控记忆版本、派生及回放载荷；后续模型请求不再附带删除前的聊天上下文。原始对话、原始用户输入和用户已导出的文件不随记忆删除而擦除。完整移除本机实验需选择“删除实验”。导出由用户选择守则、记忆和/或对话范围，不含模型 Key；导出 JSON 供分析，不支持任意旧快照覆盖恢复。恢复实验应从本机实验列表打开。

## 演示和图谱

内置数据标记 SIMULATED，不是真实 TeleAgent。播放、暂停、跳转、输入与快照联动；图谱支持旋转、缩放、平移、点选、聚焦和全景。模型实验与固定回放、浏览器模拟沙盒各自隔离。真实实验的时间轴展示实际聊天及治理记录；图形不可用时继续使用二维记忆列表。原模拟沙盒仍只驻留运行内存。

## 开发与 Windows 构建

只有 macOS 时，使用私有仓库的 Windows Actions 完成原生构建，无须 Windows 电脑。流程及源码白名单见 [Windows 构建说明](../docs/windows-delivery.md)。公开网页版仓库不包含桌面内核，不能直接用于原生构建。

先安装 Node.js 22+、Rust MSVC 工具链、Visual Studio C++ Build Tools、Windows SDK；构建治理程序使用原生 x64 Python 3.10–3.14 和 `PyInstaller==6.16.0`（仅构建依赖，评委无须安装）。

```powershell
cd app
npm ci
python -m pip install PyInstaller==6.16.0
npm run kernel:build
npm run kernel:check
npm run build
npm run check
npm run desktop:windows
```

治理源码改变后必须重新执行 kernel:build。`check-kernel.mjs`核对架构、文件和源码 SHA-256，拒绝使用过期内核。Tauri externalBin 打包 `memory-kernel.exe`；NSIS 为当前用户安装并创建开始菜单入口，默认包含轻量 WebView2 引导器：已有运行时可直接安装，缺失时需联网下载运行时；Actions 手动构建可选完整离线安装器。便携版整理器也包含内核及完整性清单；没有原生构建及实机验收不标记为可交付。不要仅复制主 EXE。

开发模式可设置 `MEMORY_LAB_PYTHON` 为 Python 绝对路径，再运行 `npm run dev`。发布模式只加载同目录已打包内核，不查找系统 Python，不允许前端指定可执行文件或任意数据库路径。Python 以 stdio 调用，不开本地端口；Rust 管理超时、取消、错误和凭据。两端共用 `web-public` 的前端，只有桌面启用真实模型功能。

macOS 本地验证可用 `python3 build-kernel.py`，再执行 `npm run desktop -- --no-sign --bundles app -- --locked`；不生成 DMG。Windows 的安装、卸载、升级、凭据库和无开发环境首次启动须在 Windows 11 x64 验收。当前本地 macOS 结果不替代这些检查。人工视觉、文件面板和 GPU 体验独立验收。第三方许可证见 THIRD_PARTY_NOTICES.txt 及 Cargo.lock 中组件的许可。
