# Linux 平台适配

日期：2026-11-05　进展点：`LINUX.compat`　目标平台：Linux x64 / arm64 桌面（Ubuntu 22.04 / 24.04 为主要参考）

状态：代码适配完成；沙箱内可运行的检查已通过；**需要用户在本机桌面会话运行一次 `bash scripts/verify-linux.sh`**，验证 Electron 窗口、Codex 沙箱（验证器/文件浏览）与真实连接。真实模型请求尚未在 Linux 运行。

## 1. 背景

M0–M3 只在 macOS arm64 实测。代码中的平台假设导致 Linux 上即使能启动，也会静默缺少大部分功能：

| 位置 | 原假设 | 结果 |
|---|---|---|
| `main.ts` 可选服务初始化 | 仅 `darwin && arm64` 才创建验证器、终端、工作树、文件浏览 | Linux 上代码任务、终端、工作树、文件浏览全部不可用，且无提示 |
| `workspace/terminal-binding.ts` | 只接受 node-pty 的 `prebuilds/darwin-arm64` 哈希 | Linux 一律 `TERMINAL_PLATFORM_NOT_VERIFIED` |
| `workspace/terminal-worker.mjs`、`terminal.ts` | 固定 `/bin/zsh -f -i`、zsh 的 `PROMPT` | 多数 Linux 发行版默认没有 zsh |
| `workspace/worktrees.ts` | `git worktree list --porcelain -z` | `-z` 需要 git 2.36+；Ubuntu 22.04 自带 2.34.1，所有工作树操作报 `WORKTREE_GIT_UNAVAILABLE` |
| `scripts/setup-terminal.mjs` | 只处理 macOS helper | Linux 无初始化路径 |
| `workspace/service.ts` | Linux 固定 `/usr/bin/git` | 非标准安装找不到 git |
| `main.ts`、`probe-project-skills.ts` | `/private/tmp` | Linux 不存在 |
| `virtual-display.mjs` | 只认 `DISPLAY` | 纯 Wayland 会话误判为无显示 |
| `smoke-verification.ts` | 用 PATH 上的 `node` | Linux 系统 Node 常不是 24，与 Host 使用的验证 Node 不一致 |
| Smoke 脚本 | 固定写 `docs/progress/evidence/<名>.json` | 在 Linux 跑会覆盖已提交的 macOS 证据 |
| Renderer | `⌘ N / ⌘ K`、“在 Finder 中定位” | Linux 文案错误 |
| 后台模式 | 关窗后靠 Dock 找回 | Linux 无 Dock，关窗后应用在后台运行但无可见入口 |

## 2. 改动

- **按能力探测替代平台硬编码**：`main.ts` 对验证器、终端、工作树、文件浏览逐个尝试创建，失败时打印 `[personal-agent] <服务> unavailable: <错误码>`。
- **平台选择集中到 `packages/workspace/src/platform.ts`**：
  - 终端 Shell：macOS 保持 `/bin/zsh -f -i`；Linux 用 `/bin/bash --noprofile --norc -i`（与 `zsh -f` 一样不读用户 rc），没有 bash 时 `/bin/sh -i`。`LANG` 在 Linux 用 `C.UTF-8`。
  - git：Linux 先找系统目录（`/usr/local/bin`、`/usr/bin`、`/bin`…），再找 PATH 中的绝对路径；都没有时 `WORKSPACE_GIT_UNAVAILABLE`。
- **工作树与旧版 git**：`WorktreeService` 启动时读取 `git --version`。2.36+ 继续用 `-z`；更旧的 git 用换行格式，但按 porcelain 语法逐行严格校验（`worktree /…`、`HEAD <hash>`、`branch refs/…`、`bare`、`detached`、`locked`、`prunable`），出现语法外的行（例如路径里含换行）直接 `WORKTREE_GIT_OUTPUT_UNSUPPORTED`，不猜测。
- **node-pty（Linux）**：1.1.0 没有 Linux 预编译包，安装时本地编译 `build/Release/pty.node`。上游没有可固定的哈希，`pnpm setup:terminal`（postinstall 自动执行）把本地编译产物的 SHA-256、路径和 Node ABI 记录到 `.local/terminal-binding.json`；Host 每次启动终端前复核，不一致时拒绝加载并提示重新 setup。macOS arm64 的官方哈希校验不变。
- **Worker 协议**：Host 把选定的 Shell 路径和参数随 `configure` 传给 `terminal-worker.mjs`；Worker 只接受绝对路径。
- **Linux 托盘**（`apps/desktop/src/tray.ts`）：后台模式下提供“显示主窗口 / 退出并停止运行”。GNOME 需要 AppIndicator 扩展才显示托盘；再次运行 `pnpm dev` 也会通过单实例锁唤回窗口。
- **显示**：`WAYLAND_DISPLAY` 视为已有显示。
- **Renderer 文案**：快捷键在 Linux 显示 `Ctrl N / Ctrl K`；“在文件管理器中定位”。
- **Electron 沙箱预检**（`scripts/linux-preflight.mjs`，`pnpm dev` 启动前执行，只读、不阻断）：检测 AppArmor 是否限制非特权 user namespace（Ubuntu 23.10+ 默认开启）、user namespace 是否被关闭（容器/嵌套沙箱常见）、`chrome-sandbox` 是否 setuid root、所在挂载是否 `nosuid`，给出修复命令。始终保留沙箱，不建议 `--no-sandbox`。
- **`pnpm diagnose`**：只读环境诊断，覆盖 Node、依赖、Electron、沙箱、显示、项目所在文件系统、Codex CLI 版本与哈希、登录状态、验证用 Node、git、node-pty、Codex 沙箱能否运行验证器配置。不发模型请求。Codex 沙箱失败时指出 CLI 自带的 `codex-resources/bwrap` 需要 user namespace。
- **`pnpm baseline:platform`**：为本机平台建立 Codex 二进制锁。先确认版本等于锁定版本，再用该二进制在临时目录重新生成协议，全部类型与锁定指纹、仓库生成目录一致后，才允许 `--write` 写入锁和证据。不能只替换哈希。
- **证据目录**：`PERSONAL_AGENT_EVIDENCE_DIR` 可覆盖 `main.ts`、`smoke-desktop`、`smoke:connection`、`smoke:codex`、`smoke:verification`、`smoke:workspace` 的证据输出目录；未设置时行为不变。`verify-linux.sh` 设为 `.local/verify-linux/<时间>-evidence/`。
- **`scripts/verify-linux.sh`**：一键本机验证（见第 3 节）。
- 测试：`tests/platform.test.ts` 7 项（含 git 版本判断与两种格式解析、严格拒绝）；`terminal`、`project-isolation`、`scheduled-execution` 中的真实 PTY 用例改为“终端可用即运行”。`project-isolation` 原先在文件出现后立即断言终端输出，bash 会在命令执行后一次性回显输入和输出，改为同时等待两者。

## 3. 本机启用与验证

前提：Node 24.19+（<25；没有时脚本会把官方 24.19.0 装到 `.local/` 并核对 SHA-256）、pnpm 11.25、python3、make、g++、git。

在桌面会话的终端里（**不要在容器或其他沙箱里**，Electron 与 Codex 沙箱都需要 user namespace）：

```bash
bash scripts/verify-linux.sh               # 不发模型请求
bash scripts/verify-linux.sh --with-model  # 额外 1 次只读、无工具的模型请求（消耗账号额度）
```

脚本依次执行：工具链/内核参数盘点 → Node 24 → `pnpm install` → 重编 node-pty → Electron → 锁定版 Codex 0.163.0（装在 `.local/codex-install`，不动全局）→ `setup:terminal` → `diagnose` → `baseline:platform`（只比较）→ 类型检查 → 受影响增量用例 → 构建 → `smoke:connection`（初始化 + 模型目录）→ `smoke:verification`（真实 Codex 沙箱里跑 `node --test`）→ `smoke:workspace`（真实 Codex 沙箱只读 git/文件，网络被阻断）→ `smoke:desktop`（真实 Electron 窗口：沙箱、上下文隔离、窗口内实时连接）→ 正常启动 25 秒（可选服务不得出现 `unavailable`）。日志 `.local/verify-linux/<时间>.log`，证据与窗口截图在同名 `-evidence/` 目录。

常见问题：

- **Codex CLI 哈希与锁不一致**：`pnpm baseline:platform` 只比较；协议完全一致时 `--write` 写入锁与 `evidence/platform-baseline-<平台>.json`。提示 `CODEX_PROTOCOL_FINGERPRINT_MISMATCH` 时不能固定。
- **Electron sandbox / Codex sandbox 失败**：Ubuntu 23.10+ 的 AppArmor 会限制非特权 user namespace，Electron 和 Codex 自带的 `bwrap` 都受影响；按 `diagnose` 给出的 AppArmor 配置（或 setuid `chrome-sandbox`）处理。项目在 `nosuid` 挂载上时只能用 AppArmor 方式。
- **Terminal 失败**：安装编译工具后 `pnpm rebuild node-pty && pnpm setup:terminal`，PATH 上的 Node 应为 24。
- **项目在 NTFS/exFAT**：NTFS（ntfs3）可用但安装/构建较慢；exFAT/FAT 没有符号链接和权限位，应迁移。

## 4. 验证结果

### 云容器（Ubuntu 24.04 x64，Node 22.23，无 Electron/Codex/node-pty，依赖为桩）

`tests/platform.test.ts` 当时 6/6；`binary` 7/7、`workspace` 14/14、`terminal-input` 4/4、`ui-model` 11/11；`terminal`、`worktrees`、`scheduled-execution` 因 Node 版本/桩在加载时失败，改动前后相同。

### 本机第 1 轮（2026-11-04 18:40 MST / 11-05 01:40 UTC，用户运行 `verify-linux.sh`；station，Ubuntu 22.04.5 / 内核 6.8 / X11，系统 Node 22.23.4）

| 步骤 | 结果 |
|---|---|
| 依赖安装 / node-pty 本地编译 / Electron 下载 | 通过；node-pty 按 Node 22 编译并记录哈希 |
| 锁定 Codex 0.163.0 | 装入 `.local/codex-install`；原生二进制哈希 `399ff69c…` 与锁中 `linux-x64` 一致（PATH 上另有 0.164.0，不使用） |
| 类型检查 / 构建 | 通过 |
| 增量测试 | 57 项：53 通过、4 失败，均为 `VERIFIER_NODE_VERSION_UNSUPPORTED`（系统 Node 22） |
| Electron 启动 | 沙箱开启下窗口持续 25 秒；`max_user_namespaces=254067`、AppArmor 未限制，无需 setuid/配置文件。四项可选服务因 Node 22 被禁用（错误码日志按预期输出）。MESA 无法在 GPU 沙箱内打开 DRI 驱动，Chromium 回退软件渲染 |
| 诊断 | 未执行：`pnpm doctor` 被 pnpm 11 内置同名命令拦截 |

据此修正：诊断改名 `pnpm diagnose`；脚本在系统 Node 不满足时安装官方 Node 24.19.0 到 `.local/`；`dev.mjs` 转发 SIGINT/SIGTERM；NTFS 改为提示。

### 本机第 2 轮（2026-11-05 02:00–02:40 UTC，Agent 在命令沙箱内执行）

环境同上。Agent 的命令沙箱（bubblewrap）内 `user.max_user_namespaces=0`，因此 Electron 窗口、Codex 沙箱相关检查**不能在沙箱内运行**；尝试在沙箱外运行只读诊断被权限策略拒绝。

| 步骤 | 结果 |
|---|---|
| Node 24.19.0 | 官方 `node-v24.19.0-linux-x64.tar.xz` SHA-256 与 `SHASUMS256.txt` 一致，解压到 `.local/` |
| node-pty | 用 Node 24 自带 node-gyp 和 tarball 头文件重编，Node 24（ABI 137）可加载；`setup:terminal` 重新记录哈希 |
| `pnpm diagnose` | Node/依赖/Electron/显示/Codex 锁/登录（ChatGPT）/验证 Node/git/终端通过；NTFS 提示；Electron sandbox 与 Codex sandbox 失败，原因是 Agent 沙箱内无 user namespace（第 1 轮宿主机上 user namespace 可用） |
| 类型检查 / 构建 | 通过 |
| 增量测试首跑 | 90 项：78 通过、12 失败。11 项工作树全部是 git 2.34 不支持 `-z`（真实缺陷，已修）；1 项是 `project-isolation` 的 bash 回显时序假设（已修） |
| 修复后 | `platform` + `project-isolation` + `worktrees` 32/32 通过（真实 git 2.34、真实 PTY）；9 个受影响文件 91 项中 88 通过 |
| 余下 3 项 | `scheduled-execution` 两项、`worktrees` 一项 SIGKILL 用例在 3–12 秒期限内等待子进程。同一时段宿主机 I/O 压力 `full avg60≈51%`，单独打开 SQLite 建表实测 31 秒、关闭 10 秒，用例超时；空闲时段首跑这些用例通过，与本轮改动无关。未标为通过，需在 I/O 正常时由第 3 轮复跑 |

### 本机第 3 轮（待用户在桌面会话运行）

需要记录：`verify-linux.sh` 摘要、`diagnose` 输出、三个真实沙箱/连接 Smoke 与窗口 Smoke 的证据、正常启动是否出现 `unavailable`。若使用 `--with-model`，另记一次真实只读模型请求的结果与 Token。

## 5. 未验证与边界

- Electron 窗口内真实连接、托盘、`codex sandbox` 的验证器/文件浏览配置在 Linux 上是否可用（第 3 轮）。
- 任何真实模型请求、真实代码任务端到端（Linux 上 M0.3/M1 Gate 未关闭）。
- Ubuntu 23.10+/24.04 的 AppArmor 限制只按文档给出处理方式，未在该版本上实测。
- Wayland 原生会话、arm64、GNOME 托盘扩展未实测。
