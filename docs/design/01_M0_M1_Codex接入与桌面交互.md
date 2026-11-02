# M0–M1：Codex 接入与桌面交互技术方案

适用阶段：M0–M1  
实施状态：技术方案与验证要求已定义；具体用例在真实开发时与实现并行细化，应用结果另行记录。  
总体入口：[总体架构与开发规划](00_总体架构与开发规划.md)

## 1. 实施边界与输入

**目标**：完成真实 Codex 接入和可恢复的桌面代码任务闭环。

**前置条件**：Linux x86_64 开发环境、受支持的开发者授权、隔离测试仓库；M0 运行前确认必需服务/网络与凭据是否可用。

**对应工作包**：`DESK-001` 至 `DESK-006`、`RUNTIME-001`。工作包的定义与阶段 Gate 统一见总体规划。

**共用合同**：[领域接口](contracts/domain.ts)、[数据库结构](contracts/schema.sql)、[协议能力矩阵](contracts/protocol-capabilities.json)。本专题定义所属领域的语义，直接引用共用合同，不复制第二套 Schema。

**协作边界**：完整领域状态与后台所有权见[M2 Runtime](02_M2_工作台与持久执行.md)；敏感能力开放规则见[可信执行方案](05_M2_M3_可信执行与ComputerUse.md)。

## 2. Codex 集成、协议锁定与流式 UI

### 2.1 版本与能力证据

首批验证使用本机观察到的 `codex-cli 0.163.0` 作为候选。发布前必须锁定可复现的二进制来源/哈希、协议哈希、OS/架构、Feature Flags 和契约结果。上游仓库某个 SHA 不自动等于本机二进制源码 SHA。

```bash
codex --version
protocol_tmp=$(mktemp -d /tmp/personal-agent-protocol.XXXXXX)
codex app-server generate-ts --out "$protocol_tmp/stable"
codex app-server generate-ts --experimental --out "$protocol_tmp/experimental"
```

生成操作只证明 Schema 形状。`initialize` 的客户端 capabilities 是声明，不能假设响应提供通用的 `supportedMethods`。必要能力通过锁版类型与非破坏性契约验证确认；不支持的必要能力阻止对应阶段，可选能力关闭或降级。

| 能力 | 实际映射与要求 |
|---|---|
| 握手 | `initialize` 响应成功后发送 `initialized`；双向 RPC 分别处理响应、通知与服务端请求 |
| 会话与历史 | `thread/start/resume/read/list`；版本支持时使用 `thread/turns/list`、`thread/items/list` 分页；只读查看不无故 Resume |
| 执行与打断 | `turn/start`、`turn/steer`、`turn/interrupt`；Steer 核对当前 `expectedTurnId`，不隐式重发已结束 Turn |
| 角色指令 | 普通生成类型的 ThreadStart/Resume 有 `developerInstructions`；普通 TurnStart 没有同名字段 |
| Dynamic Tools | 本候选的 `dynamicTools` 只在实验版 ThreadStart 类型中观察到；M1 不依赖它 |
| 模型、Skills、MCP | 从锁版模型/工具目录与实际状态展示；不硬编码模型名称，不从一句模型陈述制造 Agent/工具 |
| Memory / Goal 扩展 | 可选且逐项验证；不替代 Personal Memory、Schedule 或业务 Goal |

适配器内部使用生成类型，领域层使用 `domain.ts`。原始 stdio stdout 仅处理协议帧；stderr 脱敏记录；限制最大帧、队列、超时、并发请求和重启次数。子进程环境由允许清单构造，保留授权方式必需的受控绑定，不直接全量传播宿主环境。配置可执行路径时验证来源、真实路径与工作目录，不拼接 Shell 字符串。

### 2.2 Item 与事件的正确处理

`(thread_id, turn_id, item_id)` 是 Item 身份，不是每条 Delta 的唯一身份。

1. 同一连接内按接收顺序追加 Delta；连续 `a / a / b` 必须显示 `aab`，不按内容哈希去重。
2. 给本地帧记录 `(connection_epoch, receive_sequence)`，用于连接内排序和诊断；它不证明跨连接上游事件的唯一性。
3. `item/completed` 的完整内容作为最终校准依据；终态 Item 不再被迟到 Delta 覆盖。
4. 断线后重新读取权威 Thread/Turn/Item 快照，替换未确认投影；不把新旧连接的片段任意拼接。
5. 业务事件按 `event_id` 去重、按单 Task `sequence` 补拉；UI Feed 使用独立单调投影序号。协议流、业务事件和 UI 投影三者分开。

事件 Reducer 必须覆盖文字、工具、文件变更、Plan、Sub-Agent、审批与 Turn 终态。未知 Item 类型保留结构化引用并降级展示；不能因无法识别而标记任务成功。消息列表虚拟化，大日志分页或保存 Artifact，限制渲染与 IPC 背压。

## 3. 桌面 UI、IPC 与最小执行账本

界面最少包含项目/Thread 导航、消息与工具流、审批/补问、Composer、Diff 和运行状态。Renderer 只发送类型化命令并订阅 Host 投影；Markdown、Artifact、外链和 IPC 调用来源均需校验。多窗口对同一审批只有一个决定 Owner，其余为状态镜像。

Composer 在 Idle 时创建 Turn，运行中按锁版能力 Steer/Interrupt，断开时保留草稿且不自动重发。任务列表、完整 Item 与错误状态由服务端结果/持久账本重建。大型历史分页、长日志限制和渲染背压从 M1 实现。

当前首次发送路径为只读消息，每条新消息建立一个持久 Task/Run/Thread，结束只进入待验证；既有 Thread 的续接在对应交互/恢复工作包验收后开放。Renderer 仅传项目 ID、正文及稳定提交键；Host 先写入 Intent/RPC ID，再发送 stdio。项目选择和任务导航持久化，目录身份每次派发复核；任务列表只传摘要，按所选 Run 获取单个有界显示快照，不逐帧传原始 RPC。

产品 UI 的所有模型发送都走账本，M0 无账本调试按钮不作为产品入口保留。M1 运行进程关闭 Apps/Plugins/Hooks/自治与 Browser/Computer 功能；继承的手动 MCP 通过线程配置逐项 disabled。工具目录可以保留配置行，只有空目录或每行都明确 disabled 且 tools 为空时才允许 Turn；未知连接状态或任何可用外部工具均阻断。本阶段不因此宣称外部 Connector 可安全使用。

只读历史先经 Host 原生目录选择注册真实路径及目录身份，Renderer 仅用项目 ID 请求。Thread 必须来自该项目的已校验列表，Turn 必须来自该 Thread 的列表；读取内容前再次核对元数据 cwd。分页游标由 Host 兑换为绑定项目/Thread/Turn 的不透明句柄，不接受任意路径、原始 RPC 或跨范围游标。

历史读取按 `historyMode` 选择：`paginated` 使用 `thread/turns/list` 与 `thread/items/list`；`legacy` 只在范围校验后读取有界完整快照并本地分页。完整帧上限 1 MiB，超限明确拒绝；禁止用 Resume 隐式迁移或执行。新空 Thread 可能尚未物化，服务端拒绝时保留“暂不可读取”，不能推断没有执行过。只读浏览的可用性与真实模型恢复验收分别记录；开放创建/发送之前必须接入下述最小账本。

最小存储使用共用 Schema 中的 Profile/Dot、Project/Workspace、Task/Run、Thread Binding、ExecutionIntent、审批映射和验证相关表；尚未实现的 Goal/Source/Memory 服务关闭。Run/Intent 的状态语义由 Runtime 方案定义，M1 只实现前台单任务所需路径，不另造一种临时恢复语义。

前台账本采用 Node/Electron 内置 SQLite，直接初始化共用 SQL（当前 Revision 2），启用外键、WAL、FULL 同步与有界 busy timeout。已有未知/旧版非空库明确拒绝，不覆盖初始化。目录身份保存设备号/inode，重新派发前复核；任务/Run/Intent 状态变更、Thread 绑定、单任务事件序号与 Outbox 在同一短事务提交。暂不启用后台 Outbox 投递服务。

Electron Main 取得 OS 单实例锁后才提升 Owner Epoch；数据库 Epoch 仅拒绝旧写入，不能替代进程互斥。新 Owner 将旧活跃 Run 保留为 Unknown 并阻止派发：`sending` Intent 转 Unknown，`prepared` Intent 标记尚未发送的拒绝，已接受回执保留。接收 ID 前不发下一请求，重复提交键仅返回原 Run；Unknown 不生成替代 Run。显示快照存于已有 Checkpoint 表，仅是有界缓存，Run 结束后 Task 仍等待独立完成验证。

每次服务端 Request 绑定 Runtime Epoch、Connection Epoch、RPC ID 与 Thread/Turn。连接已失效的审批不在新进程重新放行。发送请求前保存 Intent；接收结果丢失时按 Runtime 的核查合同处理，无法证实就保留 Unknown。

实现顺序：版本与环境探测 → 安全窗口/IPC → 双向 RPC → 第一条真实 Turn → 最小执行账本 → 流式 Reducer/历史 → 审批/停止 → Diff/验证 → 故障恢复。协议 Stub 用于确定性故障用例，真实模型闭环单独执行。

## 4. VerificationSpec 与完成收据

任务开始时创建可审计验证合同：基线 Commit、目标、命令 argv、允许修改范围、验证器哈希、必要 Target/Case、实际运行要求及证据。可信 Host 负责运行与收集，Agent 不能通过改验证命令或自述完成直接取得通过。

- 代码：保留真实退出码、测试发现/执行/跳过/失败数、Target、时间和当前 Run 结果引用；零测试、全跳过、错误 Target、陈旧缓存均不能替代必要执行。测试修改是否允许由任务合同明确决定。
- 文档/研究：覆盖清单、可访问来源与产物完整性；模型评分可作辅助，必要时进入 `needs_review`。
- 外部动作：可信 Provider Receipt 或确定对账证据；网页成功文案和模型回答不能单独确认。
- Goal：所有必要子任务已验证、无未解决外部 Unknown、成功条件满足，才能完成并停止其计划与订阅。

## 5. 交付与阶段验收

**M0 Gate**：固定环境和协议，取得真实 Thread/Turn 与完整最终结果；生成类型、空窗口或 Stub 成功都不单独构成通过。缺少合法授权/额度/网络时记录具体阻塞，不伪造模型结果。

**M1 Gate**：在受控代码 Fixture 中修复已知 Bug，完成审批拒绝、中断、历史重建、丢响应核查和完成验证。验证器固定目标、基线与允许修改范围；零测试和错误 Target 的退出码 0 不能通过。

交给 M2：协议/二进制锁、能力矩阵、RPC/Item Fixture、最小账本、审批请求映射、真实执行及验证证据。交接数据包含实际状态，不能把 Unknown 当可重试失败。

## 6. 开发验证要求

以下只规划 M0/M1 必须覆盖的验证范围与验收证据。具体输入、步骤、Fixture、故障注入方式和自动化实现，在对应工作包真实开发时并行细化。当前不宣称已经形成完整用例库或通过应用验收。

| 验证方向 | 必须覆盖 | 验收证据要求 |
|---|---|---|
| M0 环境与能力 | 可执行来源/版本、必要协议、合法授权/网络可用性与缺失能力降级 | 环境/能力记录；真实运行或具体阻塞 |
| M0 双向通信 | 握手顺序、请求/响应/服务端请求、坏帧、退出和重连 | 协议事件及明确错误，真实调用与 Stub 区分 |
| M1 消息与历史 | 重复文本 Delta、完成校准、分页、断线回填与状态重建 | 完整 Item/Turn 与 UI 投影一致的证据 |
| M1 审批与交互 | 允许/拒绝、超时、旧连接回复、Steer/Interrupt、多窗口 Owner | 受控操作与请求映射，拒绝后无副作用 |
| M1 UI/IPC 边界 | 不可信 Markdown/Artifact、外链、路径、参数范围与越权 IPC | 实际阻断结果；不能只验证界面提示 |
| M1 恢复与完成 | 发送后丢响应、重启、真实代码任务、错误 Target/零测试/陈旧结果 | 最小账本、Unknown/对账与可信完成收据 |

每项实际验证记录正常/失败/拒绝/恢复结果，区分真实组件、Stub、模拟器和外部阻塞；执行状态与证据格式遵循[总体规划](00_总体架构与开发规划.md)的开发验证规则。
