# 本机平台基线接续

日期：2026-11-02（Asia/Shanghai）。进展点：M0.local（平台适配），随后单独验收 M0.3。开始提交 `ea623ce`，分支 `main`，初始工作区干净。

当前结论：M0.local 与 M0.3 均已完成，macOS arm64 的 M0 Gate 已通过；下一进展点为 M1.3 最小持久账本。以下按规划与实际执行顺序保留结果及失败修正。

## 规划与验收范围

1. 盘点本机工具链和受支持登录；取得官方锁版 CLI 的 macOS arm64 发行物，不更改全局 Codex，不复制凭据。
2. 扩展平台二进制锁与 npm 包装入口解析，在临时目录重新生成协议并比较全部类型；保留 Linux 基线和生成类型。
3. 补充 macOS 原生显示分支，执行常规检查、真实目录连接、真实 Electron 沙箱窗口和独立合成历史界面验证。
4. 平台基线成立后运行一次有界、只读、零工具模型 Smoke，单独记录 M0.3；Unknown 不自动重发。
5. 每点落盘脱敏证据，提交、标签、推送远程 `main` 并核对 SHA。后续才进入 M1.3 最小账本，不提前开放真实任务 Composer。

## 初始盘点与执行

- 实际 OS/CPU：Darwin arm64；PATH Node `v24.7.0`、pnpm `11.25.0`、Python `3.14.4`。
- PATH Codex：官方 npm 包 `@openai/codex` 的 JS 包装入口，版本 `0.162.1`；`codex login status` 显示 ChatGPT 登录。未读取认证文件。
- 仓库要求 Node `>=24.19.0 <25`、CLI `0.163.0`；当前无 `node_modules`。版本不匹配尚未解决，不能只替换二进制哈希。
- 默认沙箱访问 npm registry 返回 DNS `ENOTFOUND`；已按开发依赖获取需要申请网络执行上下文，尚待实际结果。未运行真实模型。
- 官方说明：[CLI](https://learn.chatgpt.com/docs/codex/cli)、[App Server](https://learn.chatgpt.com/docs/app-server)。协议兼容结论须来自锁版实际生成和接口验证。

## 实际结果、阻塞与下一步

M0.local 平台子项完成，提交定位 `checkpoint/M0.local`。本点不关闭 M0 Gate；真实模型 Smoke 尚未运行，下一点 M0.3 单独验收。

- 官方 Node 24.19.0 macOS arm64 归档 SHA-256 与 nodejs.org 同版本校验清单匹配；项目内 npm 安装 Codex 0.163.0，保留 registry/TLS/完整性校验。系统全局版本未变，未修补全局 npm 缓存权限。
- 实际原生 CLI 哈希 `8813367285524ac798dd96d1b071aea30d58708c7226fd236cd275cf1cfdee31`。先生成临时 stable/experimental 协议，再比较全部 747 个 stable 文件和 16 个已锁文件（含 8 个 experimental 文件）；零差异，共用协议指纹保持不变，生成目录无改动。[来源/比较证据](evidence/M0-local-platform-schema.json)。
- 新平台锁保留 Linux 原始哈希与证据；Host 与脚本共用 npm 原生入口解析、哈希和版本校验，未审查平台明确拒绝。`protocol:verify` 每次从实际锁版 CLI 临时生成并比对仓库和锁，不只校验已有类型。
- `pnpm install --frozen-lockfile`、`pnpm exec install-electron` 成功。Node 24.19.0 下 `pnpm check`：46 项 Node 用例（新增 7 项二进制解析/校验，原 39 项）全部通过，0 失败、0 跳过；17 项设计合同、类型检查、747 类型双重校验及生产构建通过。[检查输出](evidence/M0-local-checks.txt)。
- 首轮类型检查暴露脚本重构遗漏输出目录变量，已修正；[首轮记录](evidence/M0-local-first-check-failure.txt)。随后 8 项历史 Fixture 在 macOS 因 `/var` 别名与 `/private/var` 规范路径不一致失败；修正 Fixture 为真实规范 cwd，保留 Host 严格校验。[脱敏失败记录](evidence/M0-local-path-fixture-failure.txt)。
- 真实 `smoke:connection` 成功，8 个模型、默认 `gpt-6.1-sol`，无推理请求。[本机目录](evidence/M0-catalog-probe-darwin-arm64.json)。隔离无凭据 Home 下原生元数据/空分页与重启浏览通过，仍不是有内容的模型历史恢复。[空历史证据](evidence/M1.1b-native-history-darwin-arm64.json)。
- 真实 macOS Electron 45.2.1：原生桌面分支、Sandbox/Context Isolation、Renderer 无 Node、7 个固定桥接字段、原生目录查询和“检查连接”按钮通过，正常退出 0、无超时。[窗口证据](evidence/M0-desktop-smoke-2026-11-02T14-58-18-543Z.json)、[截图](evidence/screenshots/M0-macos-native-catalog.png)。Windows 仅加入原生分支，未运行，仍未列入二进制平台锁。
- 真实 Electron + 合成 stdio 历史 Fixture：实际分页/刷新/选会话/选轮次，3 个 Item、HTML 作为文本、无脚本/图片注入、无私有工具字段、发送禁用通过。[历史窗口](evidence/M1.1b-desktop-2026-11-02T14-58-36-925Z.json)、[截图](evidence/screenshots/M1-macos-history-fixture.png)。原生目录人工选择未运行，不能以固定 Fixture 替代验收。
- 外部前提已解决：网络执行上下文可取得官方依赖，使用项目独立 npm 缓存避开本机 EACCES。未运行 Linux 重验、其他 CPU/Windows、有内容历史、真实代码任务及完整进程/发布验收。
- 下一步：M0.3 在本机现有受支持登录下运行一次只读零工具模型 Smoke；根据真实结果更新 Gate。此后实现 M1.3 最小持久账本及 ExecutionIntent，账本完成前发送任务仍关闭。

## M0.3 本机真实模型计划

平台进展点已提交为 `c4135b0`（`checkpoint/M0.local`），远程 SHA 核验结果将在本节随执行结果落盘。仅执行一次已有 `pnpm smoke:codex`：本机受支持登录、隔离临时目录、只读 Sandbox、禁止工具、随机标记完整最终回复；目录与 Thread/Turn 接收不能代替最终内容通过。超时/断线保留 Unknown，不自动重发；凭据与原始 stderr/运行库不进入证据。该点通过前 M0 Gate 保持未通过。

## M0.3 实际结果与下一步

- 状态：完成，定位 `checkpoint/M0.3`；macOS arm64 的 M0 Gate 已通过。执行时间为 2026-11-02 23:02（Asia/Shanghai），仅运行一次 `pnpm smoke:codex`，无重发。
- 真实模型 `gpt-6.1-sol`；指定 Thread/Turn 的最终助手内容完整匹配随机标记，12 个文字 Delta、一次 `turn/completed`，`completionSource=notification`，工具 Item 与服务端请求均为 0。[成功证据](evidence/M0-real-smoke-2026-11-02T15-02-06-121Z.json)。原云失败时间戳文件保留。
- Smoke 输出增加与已验证平台绑定的 CLI/Schema 哈希、实际已完成方法和范围。类型检查通过；矩阵及文档更新后的常规回归见 [M0.3-checks.txt](evidence/M0.3-checks.txt)。真实推理不由这份静态/Fixture 回归替代，也没有因回归再次调用模型。
- 上一进展点远程核验：`main` 和 `checkpoint/M0.local` 均为 `c4135b0b83ece0ffbb294c4e1d833892274a67f9`。
- M1.3 之前仍没有产品任务账本、可信审批/停止或发送 Composer；本次 ephemeral 协议 Smoke 不宣称持久任务可恢复。未运行有内容历史恢复、真实编码任务和其他平台模型验收。
- 后续开发从 M1.3 最小持久化/Intent 开始，复用共用 SQL/领域状态；先细化并实现状态 Guard、发送前落盘、Thread/Turn 绑定和崩溃 Unknown 用例，再开放 M1.1c。M1 阶段记录保持未通过，原生目录人工选择仍待实际验收。
