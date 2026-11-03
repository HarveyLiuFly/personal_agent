# 本地 Codex 开发交接

交接日期：2026-11-02（Asia/Shanghai）。用户决定停止在当前云环境中推进，改用本地电脑的 Codex 继续开发。本文件是接手入口，详细执行历史保留在阶段记录中。

本机后续状态以[本机平台接续](LOCAL_BASELINE.md)、[阶段总览](README.md)、[M1](M1.md)和[M2](M2.md)为准：**M0/M1 Gate 在已记录的 macOS arm64 范围通过，M1 定位 `checkpoint/M1`**，见[历史 Gate](evidence/M1-gate.json)。**M2 最新 `checkpoint/M2.5a`：队列/预算/Operation/计划/后台窗口之上，新增工作树创建、列表、切换、保守移除及托管 Linked Git 原生只读预览。Schema Revision 5，2/3/4→5 先验证备份；239/239、14 项 Electron 新用例、三个新增 Host SIGKILL（累计 11 个账本故障位置）及 36 项 IPC 白名单通过。** 创建不搬迁原目录脏文件；移除保留私有恢复目录和分支，Unknown 不自动重发。本点 0 模型，真实 Electron 无窗口模型证据仍见 M2.4a（1 Turn / 18,082 Token），工作树模型集成尚未运行。开发仓库仍只有 main；权限管理移至 M5，继续用户 PTY、恢复目录管理/中断登记修复、资源与备份恢复。M2 Gate 开放，关闭窗口保留 Main，显式退出应用停止；不承诺独立 Daemon。历史 Verifier Hash 变化仍拒绝复用，不可改 Hash 绕过。下文保留原云交接事实。

## 1. Git 与交付范围

- 仓库：`https://github.com/HarveyLiuFly/personal_agent`，远程分支 `main`。
- 交接前最后一个功能提交：`d9f39423dc65121177a94c6eff5fc05c0593cad2`（M1.1b）。本次文档/证据交接提交用标签 `handoff/local-codex-2026-11-02` 定位，实际 SHA 以 Git 为准。
- 设计、评审、代码、生成的 747 个协议类型、pnpm 锁文件、阶段规划、成功和失败证据均已纳入 Git。本次另归档原来仅在 `.local/` 的两张自有应用截图与云端安装/启动说明。
- `node_modules/`、`build/`、`.local/` 是可重建依赖/构建/运行数据，不迁入 Git。云端 CLI 二进制、登录凭据、缓存及运行进程不通过仓库迁移；没有把云环境快照或正式安装包作为交付物。

| 进展点 | 状态 | 提交 |
|---|---|---|
| M0.1 工程、依赖、版本基线 | 完成 | `c975c1e` |
| M0.2 双向 RPC / 原生目录 | 完成 | `a20eefe` |
| M0.3 真实模型闭环 | 未完成；云端最后实测代理 CONNECT 403 | 阻塞记录 `9f713e4`，后续证据见阶段文档 |
| M0.4 沙箱桌面窗口 | 桌面子项完成，整个 M0 Gate 未通过 | `7fb3ebd` |
| M1.1a 有界流事件投影 | 独立组件完成 | `fc8f9d0` |
| M1.1b 项目与只读历史浏览 | 限定范围完成 | `d9f3942` |
| M1.1c、M1.2–M1.4 | 待开发/验收 | 尚无完成标签 |
| M2–M5 / DeepSeek 可选适配 | 已有设计和验证要求，未实现 | 见设计专题 |

已有 `checkpoint/M0.1`、`checkpoint/M0.2`、`checkpoint/M0.4`、`checkpoint/M1.1a`、`checkpoint/M1.1b` 标签。**M0、M1 均未通过阶段 Gate。**

## 2. 阅读顺序与模块定位

1. [仓库协作约定](../../AGENTS.md)、[总进展与每点推送规则](README.md)。
2. [总体架构/开发规划](../design/00_总体架构与开发规划.md)、[M0–M1 技术方案](../design/01_M0_M1_Codex接入与桌面交互.md)。
3. [M0 实际记录](M0.md)、[M1 实际记录](M1.md)，其中明确区分真实原生接口与 Fixture。
4. [最小持久执行合同](../design/02_M2_工作台与持久执行.md)、[SQL](../design/contracts/schema.sql)、[领域 DTO](../design/contracts/domain.ts)、[能力矩阵](../design/contracts/protocol-capabilities.json)。M1 的最小账本已经规划在这些共用合同中。

| 位置 | 已有实现 |
|---|---|
| `apps/desktop/src/` | Electron Host、固定白名单 Preload、IPC 来源和参数校验 |
| `apps/desktop/renderer/` | 项目/会话/轮次/Item 只读浏览，纯文本展示，发送关闭 |
| `packages/codex-adapter/src/rpc.ts` | 双向 stdio RPC、超时、坏帧/大小限制、取消、进程退出与清理 |
| `packages/codex-adapter/src/projection.ts` | 重复 Delta、终态校准、连接代/通知序号、快照替换、内存上限 |
| `packages/codex-adapter/src/history.ts` | 项目目录身份、逐级导航授权、范围绑定游标、分页及有界 Legacy 适配 |
| `packages/codex-adapter/src/launch.ts` | CLI 查找/哈希、受控环境变量、独立 SQLite/日志目录 |
| `packages/codex-adapter/src/generated/` | 锁版生成类型，禁止手工修改 |
| `packages/contracts/src/views.ts` | Renderer 投影 DTO，非原始 RPC 或任务成功收据 |
| `scripts/`、`tests/` | 构建、协议、Smoke、根目录所列测试及本地 stdio Fixture |

尚无完整任务 Store/Runtime、Intent 持久化、可信审批/停止、真实编码任务、Diff/验证收据、主聊天、Memory、Scheduler 或设备接入。不要从只读 UI 的存在推断这些能力已实现。

## 3. 本机启动与检查

新目录可克隆；已有目录先检查本地修改，再以保留本地工作的方式更新：

```bash
git clone https://github.com/HarveyLiuFly/personal_agent.git
cd personal_agent
git fetch origin --tags
```

已验证云端工具链为 Debian 13 Linux x86_64、Node 24.19.0、pnpm 11.25.0、Python 3（含 sqlite3）、Codex CLI 0.163.0。依赖精确版本见 [package.json](../../package.json) 和 `pnpm-lock.yaml`。**macOS、Apple Silicon 和 Windows 尚未验证。**

先在本机盘点 OS/CPU、Node/pnpm/Python/Codex 版本与 CLI 安装来源；通过受支持的本机 Codex 登录检查认证状态。不要把云端 `proxy:8080`、CA 路径或 `CODEX_HOME` 值带到本机；本机使用自己的正常网络、代理和登录。

```bash
node --version
pnpm --version
python3 --version
codex --version
codex login status
pnpm install --frozen-lockfile
pnpm exec install-electron
```

如果本机确需代理，按本机代理配置 Electron 下载；云端的 `ELECTRON_GET_USE_PROXY=1` 只是已验证的云端安装方式。保留发行包/TLS 校验。不要为安装器跳过校验。

以下检查不依赖 Codex 二进制匹配，可先确认开发工具链与源码：

```bash
pnpm typecheck
pnpm test
pnpm test:contracts
pnpm build
```

它们通过不代表整体检查或真实模型已通过。完成下一节的平台基线后再运行：

```bash
pnpm protocol:verify
pnpm check
pnpm smoke:connection
pnpm smoke:codex
pnpm dev
```

`smoke:codex` 运行一次只读、无工具模型请求，可能消耗本机账号额度。`pnpm dev` 本身构建并启动 Electron；连接相关功能仍会严格校验 CLI。项目选择仅在当前启动期间保存。

## 4. 本地接手首先处理的两个适配点

### 4.1 CLI 指纹与安装入口

当前 [codex-version.lock.json](../../codex-version.lock.json) 只记录原 Linux x86_64 原生 CLI 的版本/哈希，来源提交为 null；当前生成协议指纹为 `d3bb2d6b3aba976aecaa62eab4f0496f3cccd4bfc5b355190b23bd14c1bb545c`。二进制哈希为 `399ff69c431c066e40de318fba45c2b07f45a76b19939d247ee4828fc70c4215`。

同版本的 macOS/其他 CPU 原生二进制也会有不同哈希；npm 安装还可能在 PATH 中提供包装脚本。因此本机首次 `protocol:verify` / Smoke 很可能因基线不符而被阻止，这是应记录并解决的移交事项。

接手时核对实际执行的官方原生文件与安装来源，按平台扩展二进制锁定/解析，保留现有 Linux 证据；确认对应官方发行物是否可得及协议是否一致，不假设同版本必然同 Schema。受影响位置是 `scripts/generate-protocol.mjs`、`packages/codex-adapter/src/launch.ts`、锁文件与能力矩阵。重新生成到临时目录比较 Schema，再运行相关合同和真实接口验证。当前脚本会校验旧二进制后才生成，不能直接运行 `protocol:generate` 来解决跨平台差异，也不能只改哈希让校验变绿。

### 4.2 图形 Smoke 的平台分支

当前 `scripts/virtual-display.mjs` 在没有 DISPLAY 时尝试 Xvfb，尚未区分 macOS/Windows 原生窗口。本机 Mac 即使有桌面，也通常没有 DISPLAY；两个桌面 Smoke 需要先补充原生显示分支并验证。

Debian 13 无桌面时才使用 `pnpm setup:headless`；它解压四个锁版 Debian 包到 `.local/`。不要在 Mac 上执行这项 Linux 安装步骤。Mac 可先用 `pnpm dev` 检查原生窗口，再适配自动化 Smoke。保持 Electron Sandbox、Context Isolation 与 CSP，不能用 `--no-sandbox` 代替适配。

## 5. 验证证据与尚未验收的范围

- 最近功能基线实际执行 **39 个测试，39 通过、0 失败、0 跳过**：13 个历史范围、13 个投影、13 个 RPC；另有 **17 个设计合同检查**、747 个类型指纹、类型检查和生产构建。[摘要](evidence/M1.1b-summary.json)、[TAP](evidence/M1.1b-tests.tap)、[检查输出](evidence/M1.1b-checks.txt)。
- 真实 Electron/Linux/Xvfb：沙箱、上下文隔离、Renderer 无 Node；原生握手/模型目录与真实按钮通过。[M0 窗口证据](evidence/M0-desktop-smoke.json)、[截图](evidence/screenshots/M0-native-catalog.png)。
- 历史协议：隔离空白 Codex Home 的元数据及空分页通过，无模型请求；未验证有内容的模型历史恢复。[原生证据](evidence/M1.1b-native-history.json)。
- 历史界面：真实 Electron 配合合成 stdio 后端，目录选择用固定 Fixture 代替；分页、记录展示、不可信 HTML 阻断和发送关闭通过。[证据](evidence/M1.1b-desktop.json)、[截图](evidence/screenshots/M1-history-fixture.png)。不是模型生成的聊天结果，也没有完成原生目录对话框的人工选择验收。
- 新空 Thread 未物化时分页会被拒绝；本地注入合成内容后空分页可读，重启后的列表仍为空。这个试验不证明真实 Turn 历史恢复可用。Legacy 路径只有合同用例，没有原生有内容恢复证据。
- 云容器曾留有已退出的 Electron zygote Z 态进程，宿主回收限制见 M0 记录；完整产品进程生命周期、打包签名与升级均未验收。

交接仅新增文档、协作约定与已检查的截图；沿用上述功能验证证据，不重复宣称本机或新平台测试已经运行。

## 6. M0.3 阻塞与本地继续顺序

云端最后实际模型尝试：Thread/Turn 已接收，上游流断开，最终出现 `httpConnectionFailed`；通过云代理对官方目标发 HEAD 得到 CONNECT 403。草稿为 unrestricted，但运行策略观测为 unknown。交接时仅复核了配置状态，没有因迁移再次请求模型；本机能否连通和推理必须重新实测。

用户已决定迁移，本地开发不依赖继续寻找云设置入口或发布云环境。原先“保存/发布云环境后重试”的步骤仅适用于继续使用原云实例，不能作为本机开发的阻塞条件。云端设置入口在此前对话中未能可靠定位；不复用猜测的 UI 导航作为既定操作路径。

下一步按以下顺序推进：

1. 在本机确认依赖、Codex 官方来源/平台二进制/Schema 和图形运行基线，落盘本机验证记录。
2. 使用本机受支持登录完成 M0.3 的真实只读模型 Smoke，记录模型目录、Thread/Turn、最终内容与零工具活动；通过后更新能力矩阵与 M0 Gate。失败按实际网络/授权/额度/兼容性定位，不自动重发未知真实任务。
3. 细化并实现 M1.3 必需的最小 Profile/Dot/Project/Workspace/Task/Run/ThreadBinding、ExecutionIntent 子集，复用现有共用 Schema 和状态语义。
4. 账本就绪后实现 M1.1c 的真实创建/发送/流式路径，再推进审批/补问/停止、恢复与验证；用真实隔离代码任务关闭 M1 Gate。
5. 每完成一个进展点更新阶段总结与脱敏证据，提交、推送并核对远程；未来阶段用例继续在实际开发时并行细化。

云端安装/启动草稿的非敏感字段已从服务重新读取并归档到 [cloud-setup-handoff.json](evidence/cloud-setup-handoff.json)，便于追溯。这是旧 Linux 环境参考，不是本地安装脚本；未验证其发布或新任务恢复。

## 7. 可直接交给本地 Codex 的指令

```text
请先阅读 AGENTS.md、docs/progress/LOCAL_HANDOFF.md、docs/progress/M0.md 和 M1.md，核对当前 Git 与本机环境后继续开发。
先处理本机 Codex 的官方安装来源、OS/CPU 二进制锁与协议兼容，以及原生桌面 Smoke 分支，再完成 M0.3 的真实只读模型闭环。
然后实现 M1.3 的最小持久化/Intent 子集，再开放 M1.1c 的真实任务发送，后续按设计阶段推进。
每个进展点的规划、执行过程、实际用例结果、阻塞与总结都写入 docs/progress；每完成一点就提交并推送远程 main，核验 SHA。
不要把 Fixture/空历史或静态检查当作真实模型验收，不要通过替换哈希、关闭沙箱或盲重试 Unknown 绕过问题。
```
