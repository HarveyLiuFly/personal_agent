# Personal Agent

Electron/React 桌面宿主，通过锁版 Codex App Server 驱动执行。当前具备安全窗口、持久执行账本、只读消息发送/流式展示与项目历史浏览；macOS arm64 的 M0 真实模型闭环与平台 Gate 已通过，完整任务发送、个人记忆与长期自治按阶段交付。

- [总体规划与技术专题](docs/design/00_总体架构与开发规划.md)
- [M0–M5 进展点与同步规则](docs/progress/README.md)
- [当前 M0 执行记录](docs/progress/M0.md)
- [M1 独立基础组件进展](docs/progress/M1.md)
- [本地 Codex 接手指南](docs/progress/LOCAL_HANDOFF.md)（当前接手入口，含平台差异与下一步）

## 一键启动

```bash
bash scripts/start.sh          # 或 pnpm start
```

第一次运行会补齐缺少的部分：Node 24（系统没有时下载官方版本到 `.local/` 并核对 SHA-256）、依赖、Linux 终端的 node-pty、Electron、锁定版 Codex CLI（装在 `.local/codex-install`），核对 Codex 哈希与登录状态，然后构建并打开窗口。首次启动时应用会自行为 Codex 建立状态索引（读取 `~/.codex` 历史，可能需要一两分钟），左下角显示进度，完成后自动连接。之后再运行只做检查，几秒即可打开；应用已在运行时直接唤回窗口，不会重新构建。全过程不发模型请求，保留 Electron 沙箱。

| 选项 | 作用 |
|---|---|
| `--check` | 只准备与诊断，不打开窗口 |
| `--install-desktop-entry` | 在 Linux 应用菜单添加“Personal Agent”（输出写入 `.local/start.log`） |
| `--log` | 所有输出追加到 `.local/start.log` |

关闭窗口后应用在后台继续运行（托盘图标）；在启动终端按 Ctrl+C，或用菜单/托盘“退出并停止运行”停止。Codex 未登录时脚本会提示登录命令（应用可以打开，但不能请求模型）。已在 Linux x64 宿主机验证；macOS 走相同步骤，尚未在此分支验证。

## 环境与依赖

已验证 Linux x86_64 与 macOS arm64、Node 24.19.x、pnpm 11.25.0；使用 Codex CLI 0.163.0。各平台原生二进制与共用生成协议指纹见 `codex-version.lock.json`；其他平台尚未验收。

本机接续已在 `.local/` 安装匹配工具链。新终端先启用本机 Node，再运行下面的命令（该路径只适用于本次 macOS arm64 安装）：

```bash
export PATH="$PWD/.local/node-v24.19.0-darwin-arm64/bin:$PATH"
```

Codex 优先使用 Host 配置 `PERSONAL_AGENT_CODEX_PATH`，其次使用项目内 `.local/codex-install`，最后查找 PATH。官方 npm 包装入口会解析到平台原生文件，先校验平台哈希再核对版本，不执行未验证的包装脚本。项目内安装方式为 `npm install --prefix .local/codex-install --cache .local/npm-cache --no-audit --no-fund --save-exact @openai/codex@0.163.0`；本机全局 CLI 保持原状。详细来源和验证见[本机基线](docs/progress/LOCAL_BASELINE.md)。

```bash
pnpm install --frozen-lockfile
pnpm exec install-electron
pnpm protocol:verify
pnpm check
pnpm dev
```

Electron 45 使用显式安装器下载运行时；安装器保留官方发行包校验。图形启动需要有效 DISPLAY/桌面环境。当前安全窗口启用 Context Isolation、Renderer Sandbox、CSP 与白名单 Preload；不使用关闭沙箱的启动参数。

## Linux

Linux x64/arm64 桌面的启用步骤、诊断与已知限制见 [Linux 平台适配](docs/progress/LINUX_PLATFORM.md)。简要：

```bash
bash scripts/start.sh                 # 一键准备并启动（见上文“一键启动”）
bash scripts/verify-linux.sh          # 完整本机验证：诊断、增量测试、真实 Smoke；不发模型请求
pnpm diagnose                         # 只读诊断：沙箱、显示、Codex 锁、终端、验证器
```

Ubuntu 23.10+ 默认限制非特权 user namespace，Electron 沙箱可能无法启动；`pnpm dev` 会在启动前给出修复命令（setuid `chrome-sandbox` 或 AppArmor 配置），始终保留沙箱。

## M0 调试

```bash
pnpm smoke:codex
pnpm setup:headless # 无 DISPLAY 的 Debian 13 x86_64 云环境
pnpm smoke:desktop
```

`smoke:codex` 使用现有受支持的 Codex 登录执行一次有界、只读、无工具的真实模型请求；结果写入 `docs/progress/evidence/`，失败不会被当作通过或自动重发。受限云环境需要允许启动本地子进程与访问既有代理的执行上下文。

运行状态写入独立 `sqlite_home/log_dir`，认证仍由 Codex 支持的路径处理，不复制 Token。`.local/`、依赖和构建输出不进入 Git。每次进展点完成后，先更新文档和证据，再提交、推送并同步提交号。

协议升级需重新审查二进制/Schema 指纹和契约结果；生成目录由 `pnpm protocol:generate` 管理，禁止手改类型。

`smoke:connection` 只运行原生握手与模型目录查询，不发起推理。`smoke:desktop` 在 macOS 使用原生桌面；Linux 无 DISPLAY 时使用带 Xauthority 的本地 Xvfb，并在结束后回收显示进程；保留 Electron 沙箱。`setup:headless` 只在 `.local/` 内解压四个锁版 Debian 包，首次下载使用官方签名索引和固定 SHA-256，不需要 sudo。缺少其他系统动态库的平台仍需先准备相应依赖。

## 只读历史浏览

`pnpm dev` 启动后选择项目目录。侧栏顶部是 Dot（个人助手），下面是“新对话”和这个项目的对话清单。一个对话对应一个 Codex Thread：发送的是你输入的原文，之后可以在同一个对话里继续追问；停止、失败或已完成的对话也能继续。结果未知时不会自动重发。“历史”按项目浏览 Codex 已保存的原生会话（第一页由应用缓存、后台刷新）。项目目录与对话记录保存在本机私有 SQLite，重启后复核目录身份。

```bash
pnpm smoke:history:local
pnpm smoke:history:desktop
```

`smoke:history:local` 在独立空白 Codex Home 验证原生元数据和空历史分页；不复制凭据、不调用模型。`smoke:history:desktop` 验证真实沙箱窗口与本地 stdio 合成 Fixture 的完整浏览路径，并替代原生目录对话框的选择结果，证据明确记录这一区别。这两项不能代替有内容的真实模型历史恢复与 M1 Gate。

## M1 消息执行验证

`pnpm smoke:execution` 通过产品 Runtime 和持久 Intent 执行一次只读零工具模型请求，读取该 Thread 的真实有内容历史并重开本地账本验证缓存。`pnpm smoke:execution:desktop` 使用真实沙箱 Electron 与合成 stdio Fixture 验证发送、流式中间态和 IPC 范围；后者不调用模型，目录选择由固定 Fixture 代替。结果与未验收范围见 [M1 进展](docs/progress/M1.md)。

产品发送路径统一经过账本。M0 的无账本模型调试按钮已移除；独立协议 Smoke 仍作为显式开发诊断命令保留。M1 关闭外部 Apps/MCP/Plugins/Hooks/自治扩展，并在派发前检查线程内全部 MCP 均已明确禁用且无可用工具。

`pnpm smoke:interactions:desktop` 使用真实沙箱窗口与合成 stdio 后端测试单次命令允许、越权/永久批准/重放拒绝；它不调用模型。M1.2a 的组件和迁移结果见阶段记录，原生模型交互不由该 Fixture 替代。

`pnpm smoke:conversation:desktop`（CORE.2d）在真实沙箱窗口中用合成后端（不调用模型）走一遍：新对话 → 追问 → 同一对话两轮 → 侧栏一个对话 → 置顶 → 打开 Dot → 返回对话。

`pnpm smoke:concurrency:desktop`（CORE.1 验收）在真实沙箱窗口中让两个临时项目同时各发一条只读问题（2 次真实模型请求，消耗额度），运行期间检查浏览文件、Diff、历史和连接检查都不被拒绝，并记录首段回答延迟和空闲 CPU。它使用独立配置目录 `.local/desktop-concurrency-smoke-data`，首次运行会先建立 Codex 索引。结果见 [CORE 计划](docs/progress/CORE.md)。
