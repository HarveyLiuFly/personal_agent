# 架构、界面与逻辑审查（M3 / UI V2 之后）

日期：2026-11-05　范围：`main` @ `c159e29`（UI V2 交付后）　参照：Codex 桌面应用的核心工作流（不含账号、计费等商业化模块）

## 0. 结论

项目在“可审计、不重发、不越权”上投入很深，单个组件质量不差；但整体偏离了“个人 Agent 原型”的目标：**验证流程压过了产品本身**。用户面对的是一个必须理解 Task/Run/Route/Intent 才能用顺手的工具，而不是 Codex 那种“打开项目 → 对话 → Agent 改代码 → 审阅 Diff”的顺滑体验。

最关键的六个问题：

1. **全局只有一个执行槽，而且每个 Run 单独起一个 Codex 进程。** 任何 Run 进行中，助手、任务、目标、定时都不能开始；文件浏览、历史、工作树、技能、验证、恢复也返回 `RUNTIME_BUSY`。
2. **助手不是对话。** 每条消息 = 路由 Run + 回答 Run，两次都是全新的临时 Thread、不带任何历史消息、不能读代码；发给模型的是 JSON 信封。
3. **Agent 默认不能改代码。** 默认只读；改代码必须是 Node 项目、手填测试文件和允许修改的文件、工作区完全干净；推理强度固定 `low`，不能选模型。
4. **截断与卡死让数据“消失”。** 助手超过 20 条后旧回答显示成“已保存这条笔记”；约 25 条助手消息后任务显示“尚无执行记录”且无法继续；任务运行时问助手，输入框会一直锁住。
5. **Main 线程反复阻塞。** 每个 Run 两次完整哈希 297 MB 的 Codex 二进制（约 0.6 s 冻结），SQLite 同步查询，250 ms 一次的路由轮询，Renderer 侧 62 个接口全部靠轮询。
6. **生产入口与测试/证据耦合，代码难以审阅。** `main.ts` 有 27 个 smoke 开关并从 `tests/fixtures` 导入；运行时读仓库根目录文件，无法打包；45 行超过 1,000 字符。

建议：冻结新功能，先按第 5 节 P0 收敛“产品主干”，再继续 M4。

## 1. 方法与证据边界

- 通读交接、设计 00/08、UI V2 记录与旧评审；阅读了 `apps/`、`packages/` 全部非生成源码。
- 两路独立复核：架构/逻辑逐条对照源码并重新测量数字；界面逐条对照 Renderer 代码与截图。原报告中被复核修正的数字已在下文直接改正。
- 截图用 esbuild 打包真实 Renderer，配合**模拟的 `window.personalAgent`**（假数据）在 Chromium 1280×800 下拍摄，只反映布局与交互结构：[evidence/2026-11-05-ui](evidence/2026-11-05-ui/)。
- 审查本身没有发送模型请求。标注“估算”的性能数字来自代码路径推算，未实测。

## 2. 架构审查

### A1　流程成本远大于产品产出

- 68 个提交中 23 个是 `docs(...)`（34%）；Git 中有 459 个证据文件（9 MB）。44 个源文件会向 `docs/progress/evidence` 写文件，每次 Smoke 都会覆盖已提交的证据。
- 进展文档高度压缩、术语密集（“0Intent证据核对”“CP换代”“Host4/4后完成Goal”），`LOCAL_HANDOFF.md` 开头几段“最新状态”互相覆盖，作为交接入口已难以阅读。
- 设计把 M4/M5 级别的问题（租约/Fence、删除代、Outbox、预算预留、备份演练）提前到了原型期。

**建议**：证据改为本地 `.local/` 或 CI 产物；进展文档改为 README + 少量 ADR + 变更日志；Gate 只保留影响用户的验收。

### A2　生产入口与测试、探针纠缠

| 位置 | 问题 |
|---|---|
| `apps/desktop/src/main.ts:36` | 生产代码 `import { createCodeFixture } from '../../../tests/fixtures/code-project.ts'` |
| `main.ts:92–131` | 27 个 `--m*-smoke/preflight` 开关，交织决定 `userData`、是否起 App Server、是否加载服务 |
| `apps/desktop/src/*-probe.ts` | 16 个探针（140 KB）经同一 esbuild 入口打进主包，其中 9 个直接打开 `node:sqlite` |
| `launch.ts:14`、`binary.ts:59`、`main.ts:188` | 运行时读取仓库根的 `codex-version.lock.json`、`.local/codex-install`、`.local/node-v24…` 和 `docs/design/contracts/schema.sql`，打包后不存在 |

`docs/progress/evidence` 的写入都在 Smoke 分支里，正常运行不会写；正常运行数据在 `userData`。

**建议**：Smoke/探针移到 `tests/e2e/`，用 Playwright for Electron（`_electron.launch`）+ 测试专用 Host 配置；`main.ts` 只做“组装服务 + 注册 IPC”；运行所需的锁、Schema 作为构建资源复制进包。

### A3　Store 是“上帝对象”，包边界只是目录

- `ExecutionLedger` 180 个方法（145 公开），名义上是 6 个子 Ledger（Goal 38、Context 25、Scheduler 25、Memory 19、Terminal 16、Budget 12）的门面，共享一个 `DatabaseSync`。
- 运行时循环依赖：`store → runtime` 10 处导入（7 处值导入）、`runtime → store` 21 处。`store`、`contracts` 还从 `docs/design/contracts/domain.ts` 导入（生产代码依赖文档目录）。
- 只有 `codex-adapter` 与 `apps/desktop` 有 `package.json`，其余靠 `../../../packages/...` 相对路径互引，没有可强制的边界。
- 58 张表，迁移写在 `ledger.ts` 构造函数里。对单用户本地原型过度建模。

**建议**：按领域拆 Repository（Threads/Runs、Tasks、Schedules、Memory、Workspace），每包有 `package.json` 与 `exports`，用 `dependency-cruiser` 或 ESLint `import/no-cycle` 守住 `contracts ← store ← runtime ← desktop`；领域类型从 `docs/` 移到 `packages/contracts`。

### A4　全局单执行槽，且不复用连接

- `packages/runtime/src/execution.ts:51` `get busy() { return this.session !== undefined; }`。`submit`、`submitRole`、`rollover`、`startTask`、`startScheduled`、`continueRun` 在 busy 时都抛 `RUNTIME_BUSY`（:71–153）；Schedule 与路由 `tick()` 在 busy 时跳过。
- 每个 Run 都新起一个 App Server 子进程（`execution.ts:261` → `openDedicated` → `rpc.ts:57`），并做 7 次 RPC 握手（initialize、model/list、config/read、mcpServerStatus×2、thread/start、turn/start）。

**建议**：一个 App Server 连接上并发多个 Thread（App Server 本身支持），并发上限作为资源参数；“同一工作区只允许一个可写 Run”放在工作区租约上，而不是全局。

### A5　Main 线程阻塞与轮询

- **每次读 App Server 配置都重新校验二进制**：`app-server.ts:57/97` → `verifiedCodex()`（`binary.ts:59–71`）同步读入并 SHA-256 整个 297 MB 文件，再同步执行 `codex --version`。实测每次约 0.3 s；每个 Run 的 `prepare()` 调用两次，即每个 Run 冻结 Main 约 0.6 s，助手每条消息约 1.2 s。历史列表、`runtime:inspect` 同样付出这笔开销。
- `node:sqlite` 的 `DatabaseSync` 在 Main 线程同步执行所有查询。
- Main 定时器：Outbox + 计划 + `chatRoutes.tick()` 每 250 ms，Schedule 每 1 s，Goal 每 15 s。`tick()` 对每条路由调用 `view()`，而 `view()` 又调 `mainRoutes()`：20 条路由时约 2,000 次查询/项目/次，即约 8,000 次/秒/项目，即使全部已完成（估算）。
- Renderer：应用壳 1.5 s × 4 个接口，助手 1.5 s × 2，任务页 800 ms（每次重取整份 `getRun`），任务/计划/定时 500 ms，终端 250 ms。共 62 个 `invoke` 接口，没有任何 Main → Renderer 推送。

后果：窗口卡顿、空闲耗 CPU、流式输出只能按秒级“跳”出来。

**建议**：二进制哈希只在启动时校验一次并缓存（文件身份不变即复用）；Store 移入 `utilityProcess` 或 worker；Main 收到 App Server 通知后用 `webContents.send` 推送增量；后台调度改为“下一次到期时间”驱动的单个定时器。

### A6　代码风格不可维护

| 文件 | 行数 | 最长行（字节） |
|---|---|---|
| `renderer/style.css` | 13 | 4,619 |
| `renderer/goal-plan-editor.tsx` | 10 | 3,333 |
| `renderer/autonomy-manager.tsx` | 144 | 3,148 |
| `store/src/goals.ts` | 150 | 2,021 |
| `store/src/ledger.ts` | 1,289 | 1,320 |

非生成源码约 1.17 MB / 8,463 物理行（平均 139 字节/行），45 行超过 1,000 字符。

**建议**：引入 Prettier（`printWidth: 100`）与 ESLint，一次性格式化（单独提交），CI 中 `prettier --check`。

### A7　按平台硬编码而不是按能力探测（Linux 适配中已修）

验证、终端、工作树、文件浏览原先只在 `darwin && arm64` 时初始化（`main.ts:194`），其他平台静默缺失。见第 6 节。

### A8　静默吞错

55 处吞错：33 处空 `catch {}`、13 处只有注释的 catch、9 处 `.catch(()=>{})`。后台循环（Outbox、Schedule、Goal、路由逐条 `tick`）出错没有任何日志；可选服务初始化失败原先也不记录原因（Linux 适配中已改为输出错误码）。

## 3. 用户界面审查（对照 Codex 桌面应用）

UI V2 的外观已接近 Codex（左侧项目/会话、中间对话、底部输入框），问题集中在**交互模型**和**信息层级**。

| # | 现状 | Codex 的做法 | 建议 |
|---|---|---|---|
| U1 | 两套对话：“项目助手”（`chat:propose/commit`、路由卡片、“确认并处理以上操作”）与“新任务”（`execution:submit`），输入上限、提示、语义都不同；路由内部创建的任务在侧栏被隐藏 | 只有 Thread，每个对话都是一个可读可写的 Agent 会话 | 合并为“新对话”；助手是置顶的默认 Thread |
| U2 | 助手输入框只有“讨论对象”下拉和“刷新”按钮；任务输入框只有“只读/修改代码”，修改代码必须填“验证测试文件”“允许修改的文件”，profile 写死 `node-test`。没有模型/推理强度/权限选择、`@` 文件、附件；斜杠命令只是隐藏的 `/query /note /remember` 正则 | 输入框带模型、推理强度、权限模式（只读/自动/完全访问）、`@` 文件、斜杠命令菜单、附件 | 权限模式替代手填范围；验证命令做成可选的项目设置 |
| U3 | 回答按 0.8–1.5 s 快照刷新；工具步骤从对话中过滤掉，放在折叠的“查看执行过程”日志里（带类型/状态筛选和“轮次…·记录…”ID）；推理过程不显示 | 流式输出；命令、文件修改、计划作为步骤实时出现在对话中 | 接入推送后逐条渲染 Item；运行中的命令默认展开最后一条 |
| U4 | Diff 是一整块 `<pre>`，不分文件、无 +/- 着色；“文件与变更”标着“只读预览”，显示原始 porcelain 代码（如 `M .`）；没有暂存/撤销/在编辑器打开 | 右侧审阅面板，按文件 Diff，可暂存、撤销、打开 | 右侧固定审阅栏：Review / Files / Terminal 三个标签 |
| U5 | 基础 `button` 样式即实心主色，开始/暂停/恢复/改名/取消同权重；没有 primary/danger 类；Renderer 中**没有任何确认**，取消、批量“取消所选”、取消目标立即执行 | 主操作唯一，次要操作文字/图标，危险操作二次确认 | 建立 primary / secondary / ghost / danger 层级；危险操作确认 |
| U6 | 内部术语外露，例：“确认并处理以上操作”“这次发送尚未确认…核对这次发送”“状态 {state} · 记录 {id} · 版本 {n}”“实际执行 n / 发现 n · 跳过 n…核验记录：{verificationId}”“刷新实际记录”“核验并完成目标”“推断不等于用户确认”“引用哈希”“高级：按来源遗忘（message:消息ID 或 claim:记忆ID）”“写入租约 n · 排队记录 n”“删除水位”“五段数字 Cron / IANA 时区” | 面向任务的日常语言 | 文案按“用户会怎么说”重写，内部状态只在诊断里出现 |
| U7 | “任务”页是“任务队列与活动”：排队表单、预算、资源占用、批量管理、任务列表、活动流堆在一页 | 侧栏就是会话列表；用量在设置 | 删掉任务页：侧栏筛选/多选 + 发送按钮里的“稍后运行”；预算/资源移到设置 |
| U8 | 项目用 `<select>` 切换，一次只能看一个项目；会话行只有 5 px 圆点、标题和状态字，`updatedAt` 有但不显示；需要审批只是琥珀色圆点 | 侧栏按项目分组，显示相对时间和运行中/需审批标记 | 项目分组 + 相对时间 + 明显的运行中/需审批徽标 |
| U9 | 没有 ErrorBoundary，根组件直接渲染；任一组件抛错整窗白屏 | 局部失败只影响局部 | 每个面板包 ErrorBoundary，显示“重新加载此面板” |
| U10 | 快捷键提示与文件管理器文案已平台化（Linux 适配）；`workspace-panel.tsx:46` 仍有“⌘”；窗口底色固定 `#0c1221`，浅色主题下打开会闪一下 | 平台化文案与主题 | 底色随 `nativeTheme`；清理剩余 ⌘ |
| U11 | 运行中无法打开项目、文件浏览、历史、技能、工作树（见 L4） | 运行中随时看文件与 Diff | 随 A4 一并解决 |
| U12 | 任务“已验证完成”后输入框不渲染，只能“新建后续任务”；只有最新 Run 处于待审阅/失败时才能继续，暂停和取消的任务是死胡同 | 任何 Thread 都能继续对话 | 完成只是标记，不锁对话 |
| U13 | 四套互相矛盾的状态文案（`ui-model.ts`、`task-manager.tsx`、`autonomy-manager.tsx`、未使用的 `chat-route-panel.tsx`）：侧栏“已完成”、任务页“已验证完成”；“待审阅”与“待审查”并存 | 一套状态词 | 统一到 `ui-model.ts` 一处 |
| U14 | 加载已有任务时先显示“新任务”界面（“把下一件事交给我”和只读/修改代码选择）；助手加载时显示欢迎页 | 骨架屏 | 区分“加载中”和“空” |
| U15 | 死代码随包发布：`ChatRoutePanel`（13.5 KB）、`MainChatDialog` 未被引用；`workspace` 页面没有入口；任务只加载最近 12 个 Run，无“加载更早” | — | 删除死代码；分页 |
| U16 | 终端开启期间暂停本项目的模型执行和工作树操作（`WORKSPACE_TERMINAL_ACTIVE`）；终端埋在右侧检查器里 | 终端与 Agent 并行 | 只在写同一工作区时互斥 |
| U17 | 消息渲染只支持代码块、粗体、`-` 列表、标题；无链接、编号列表、表格、语法高亮、可点击文件路径。审批卡只有“仅允许本次/拒绝” | 完整 Markdown；“本会话总是允许” | 用成熟 Markdown 渲染（保持不执行 HTML）；审批增加会话级允许 |

**导航结构**：`Surface` 共 9 个——项目助手、新任务、任务、目标、记忆、自动化、文件与变更（不可达）、设置、原生历史。建议收敛为：侧栏（项目 → Thread，外加“目标”“自动化”两组）+ 设置（个性化/记忆、用量/预算、资源、备份、诊断/原生历史）。

**可访问性**：只有 Ctrl/Cmd+K、Ctrl/Cmd+N 两个快捷键，没有 Esc 停止、切换面板、会话间键盘导航；对话区无 `aria-live`，选中项无 `aria-current`；次要文字对比度 3.97:1 / 4.33:1，低于 AA；48 条 CSS 规则使用 9–11 px 字号；运行中状态只靠 5 px 圆点颜色表达。

**做得好的地方**：按项目/任务隔离的草稿；Enter 发送、Shift+Enter 换行、输入法组合期间不误发；深浅色主题变量；`aria-label` 覆盖较全；空状态引导明确；原生 `<dialog>` 自带 Esc 与焦点约束。

**目标主窗口**：

```text
┌ 侧栏 ──────────────────┬ Thread ──────────────────────────────────────────┬ 审阅 ────────────────┐
│ ▾ personal_agent    +  │ personal_agent › 修复 sum 符号    ⎇ 本地 ▾  ⋯      │ [审阅] 文件  终端    │
│   ◉ 修复 sum 符号   2m │                                                   │ 2 个文件  +3 −1  ⟳   │
│   ⚠ 依赖更新  需批准   │ 你  修复 src/math.mjs 的 sum 并让测试通过         │ ▾ src/math.mjs +1 −1 │
│   ○ 解释 ledger.ts 1h  │ ▾ 计划  ✓阅读代码  ✓修改 math.mjs  ◌运行测试      │   - a - b            │
│   📌 项目助手          │ ▸ 已运行 rg "sum" src            0.3s  ✓          │   + a + b            │
│ ▸ other-project        │ ▸ 已编辑 src/math.mjs  +1 −1        [查看差异]    │  [暂存][撤销][↗编辑器]│
│ ─────────────────────  │ ▾ 正在运行 pnpm test …（实时输出末尾 5 行）        │ ▸ test/math.test.mjs │
│ ◇ 目标        2 进行中 │ ┌ 需要批准：运行 npm install ─────────────────┐  │                      │
│ ⏱ 自动化      1 已启用 │ │ [允许一次] [本会话总是允许] [拒绝]            │  │ [全部暂存] [提交…]   │
│ ⚙ 设置                 │ └─────────────────────────────────────────────┘  │                      │
│                        │ Agent  已修复，4/4 测试通过。 ✓已验证             │                      │
│                        │ ┌ 问点什么，@ 引用文件，/ 命令… ───────────────┐  │                      │
│ ● Codex 已连接         │ │ 📎  模型 ▾  推理 高 ▾  自动(按需批准) ▾    ↑ │  │                      │
└────────────────────────┴───────────────────────────────────────────────────┴──────────────────────┘
```

个人 Agent 能力的位置：目标是侧栏中的一组 Thread，完成检查自动运行、显示为 ✓，不需要手填 verificationId；定时是“向某个 Thread 定时发消息”，从“⋯ › 定时”或 `/schedule` 创建；记忆是消息上的“记住”动作，在设置中管理；排队是发送按钮里的“稍后运行”；代码验证是可选的项目测试命令。

截图（模拟数据）：[助手](evidence/2026-11-05-ui/01-assistant.png)、[代码任务结果](evidence/2026-11-05-ui/02-task-code.png)、[新建代码任务](evidence/2026-11-05-ui/04b-new-code-task.png)、[任务页](evidence/2026-11-05-ui/05-tasks.png)、[目标页](evidence/2026-11-05-ui/06-goals.png)。

## 4. 逻辑审查

| # | 问题 | 位置 | 影响 |
|---|---|---|---|
| L1 | 助手每条消息 = 路由 Run + 回答 Run，两者都是临时 Thread、`tools:'none'`、各自起进程。回答的上下文只有任务、本条消息、路由和 ≤8 条记忆，**不含任何之前的消息**；chat 角色 `workspace_read:false`、禁用 shell | `chat-routes.ts:47/102`、`execution.ts:89/303`、`route-profile.ts:8`、`launch.ts:47–52` | 延迟与 Token 翻倍；没有多轮对话；示例提示“概括这个项目的用途”实际读不到代码 |
| L2 | 用户请求被包装成 JSON 信封（`format:1`、`notice:"Sourced data only…"`、`sources[]`）作为 user message 发给模型，路由来源内容本身又是 JSON；**普通任务也一样**；Renderer 再反解析显示 | `runtime/src/context.ts:88/94`、`execution.ts:248/318`、`context-sources.ts:38–41`、`ui-model.ts:10–16` | 模型看到的是嵌套 JSON；信封被截断后不是合法 JSON，界面会原样显示 |
| L3 | 默认只读；代码任务必须 `{profile:'node-test', target, allowedPaths 1–20}`，`prepare()` 还要求工作区完全干净（含未跟踪文件）且有 HEAD 提交；网络和全部 MCP 关闭 | `verification.ts:29–33/84–86`、`execution.ts:69` | 非 Node 项目无法让 Agent 改代码；有任何未提交改动就不能开始 |
| L4 | `historyCommand()` 在 busy 时返回 `RUNTIME_BUSY`：选择项目、Thread/Turn/Item 历史、技能、`workspace:*`、`worktrees:*`、执行对账、验证、`runtime:inspect`、恢复准备/激活都会被拒。同一个 `active` 标志也让这些只读请求互斥，期间提交/继续/开始任务失败 | `main.ts:159` 及各 handler | 运行期间无法看文件和 Diff，连“重新检查连接”都失败。不受影响：聊天读取、任务列表/视图、本 Run 的审阅 Diff、任务/目标/记忆/定时/终端 |
| L5 | `mainRoutes()` 只取最近 20 条路由，聊天视图返回 50 条消息；提议消息存为 `kind:'note'`，第 21–50 条的回答在界面上显示成“已保存这条笔记”，更早的直接消失，截断标志不显示；`tick()` 只遍历这 20 条，之外的 committing/unknown 路由永远停住 | `ledger.ts:378–381/418/424`、`main-chat.tsx:67–70`、`chat-routes.ts:135` | 历史回答丢失；旧路由不再推进 |
| L6 | `runs()` 每项目只返回最近 50 个 Run，且**包含助手的隐藏角色 Run**（每条助手消息 2 个）；任务列表上限 100 | `ledger.ts:363/1008`、`history-app.tsx` | 约 25 条助手消息后，所有任务打开都显示“此任务尚无执行记录”；经助手继续任务失败 `RUN_NOT_CONTINUABLE` |
| L7 | 不在白名单内的错误（含瞬时 IPC 失败、`RUNTIME_BUSY`）都把发送标为“未确认”并禁用输入框；若请求实际已落库，刷新会自动解锁，否则一直锁住；“核对这次发送”实际是重发（`messageId` 幂等，安全） | `main-chat.tsx:11/36–40/78/81` | 一次抖动就锁住输入，文案还让用户以为有风险 |
| L8 | 后台循环全部 `catch {}`，路由 `tick()` 逐条吞错 | `main.ts:247/248/250`、`chat-routes.ts:135–137` | 自动化“静默不工作”时无从排查 |
| L9 | 恢复备份时关闭 Ledger 后若出错，150 ms 后直接退出且不 relaunch | `main.ts:276–297` | 窗口突然消失，用户看不到原因 |
| L10 | **任务运行时问助手会卡死**：`prepareMainRoute` 先存为 `prepared`，`submitRole` 抛 `RUNTIME_BUSY`，`tick()` 不处理 `prepared`，界面永远“正在理解请求…”且输入锁住 | `ledger.ts:419–425`、`execution.ts:86`、`chat-routes.ts:135`、`main-chat.tsx:46` | 开着一个代码任务时无法使用助手，直到任务结束 |
| L11 | **普通问答依赖页面挂着**：只有 Renderer 的 `finishFreshDiscussion`（组件存活检查、180 s 超时）会提交纯聊天路由 | `ui-model.ts:35–38` | 切换项目/页面或路由慢时，问题停在“已提议”，需手动点“确认并处理以上操作” |
| L12 | 所有 Run（含代码任务）固定 `effort:'low'` 和目录默认模型，无任何覆盖入口 | `execution.ts:268/321` | 难任务质量受限，用户无法调整 |
| L13 | **长内容丢掉成功的回答**：任一 Item 超过 16,384 字符即标记快照截断，`response()` 返回 null，CHAT 步骤变“需要核对”、路由失败 `ROUTE_MODEL_SNAPSHOT_UNAVAILABLE`；而用户 Item 就是信封（聊天预算 16k Token、任务 24k）。回答另被截到 8,192 字符，临时 Thread 无法取回其余部分 | `projection.ts:6/92`、`chat-routes.ts:26/63/70/86/88` | 上下文稍大时，模型已成功回答却显示失败 |
| L14 | 竞态：路由来源要求候选任务版本不变，任务状态变化会升版本；路由完成到提交之间（或等待 busy 时）有任务开始/结束，回答步骤失败 | `context-sources.ts:40`、`chat-routes.ts:40` | 有排队/定时任务时，助手间歇性失败 |

## 5. 建议路线

**P0（先做，1–2 周）——让它成为可用的 Agent**

1. 以 **Thread** 为唯一会话单元：一个项目多个 Thread，助手是置顶的长期 Thread，带完整多轮上下文、可读工作区；建任务、定时、记忆作为工具调用由模型发起，有副作用的才确认。发给模型的是自然语言，来源作为附加上下文。
2. 输入框加入模型、推理强度、权限模式；默认“工作区可写 + 按需审批”，复用 Codex 原生审批流；验证命令改为可选的项目设置，不要求干净工作区。
3. 去掉全局单槽：一个 App Server 连接并发多个 Thread；只对“同一工作区的可写 Run”互斥。只读查询永不因执行被拒（修 L4、L10、U11、U16）。
4. Codex 二进制只在启动时校验一次；Main → Renderer 事件推送，去掉轮询；流式渲染 Item。
5. 修 L5/L6/L7/L11/L13；Renderer 加 ErrorBoundary；统一状态文案；危险操作确认。

**P1——把工程变回可维护**

1. Prettier/ESLint 一次性格式化；`import/no-cycle`。
2. 拆 `ExecutionLedger` 为领域 Repository，Store 移入 `utilityProcess`；后台调度按到期时间驱动；后台错误统一记录并在诊断页显示。
3. 探针/Fixture 移出 `apps/desktop/src`，E2E 用 Playwright for Electron；`main.ts` 不再认识 `--smoke` 参数；运行资源随包发布。
4. 证据移出 Git；进展文档精简为 README + ADR + CHANGELOG。

**P2——在稳定主干上再做 Personal Dot**

Goal/Schedule/Source 建立在 Thread 之上（“定时向某个 Thread 发一条消息”）；记忆先采用 Codex 风格的项目说明文件 + 简单的用户记忆列表，再按需要引入来源/遗忘代。

## 6. Linux 兼容

详见 [Linux 平台适配记录](../progress/LINUX_PLATFORM.md)。概要：

- 可选服务（代码验证、终端、工作树、文件浏览）改为按前置条件探测，失败时输出错误码。
- 终端：Linux 使用本地编译的 node-pty（`pnpm setup:terminal` 记录字节哈希，启动时复核）；Shell 为 `bash --noprofile --norc -i`（无 bash 时 `sh -i`），macOS 仍为 `zsh -f -i`。
- 工作树：git 2.36 以下（Ubuntu 22.04 自带 2.34）不支持 `worktree list -z`，原先所有工作树操作都失败；现按 git 版本选择，旧版本严格解析、遇到语法外的行直接拒绝。
- git 解析、临时目录、Wayland 显示、平台化快捷键/文件管理器文案；Linux 后台模式托盘。
- `pnpm diagnose`（只读环境诊断）、`pnpm baseline:platform`（按协议一致性建立本机 Codex 二进制锁）、启动前 Electron 沙箱预检；`scripts/verify-linux.sh` 一键本机验证，Smoke 证据写入 `.local/`，不覆盖已提交的 macOS 证据。
