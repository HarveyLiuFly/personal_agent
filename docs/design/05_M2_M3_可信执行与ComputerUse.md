# M2–M3：可信执行与 Computer Use 技术方案

适用阶段：M2–M3 可选能力；执行底线从 M0/M1 贯穿  
实施状态：技术方案与验证要求已定义；具体用例在真实开发时与实现并行细化，应用结果另行记录。  
总体入口：[总体架构与开发规划](00_总体架构与开发规划.md)

## 1. 实施边界与输入

**目标**：建立可强制的执行域、Action/审批/撤销与 Browser/Desktop 驱动，并以专项 Gate 控制开放。

**前置条件**：真实 Driver 接入前拥有受保护的 Runtime/Action/Session 入口；先使用隔离桌面、测试 Profile 和模拟服务。

**对应工作包**：`CU-001`、`CU-002`、`CU-003`。工作包的定义与阶段 Gate 统一见总体规划。

**共用合同**：[领域接口](contracts/domain.ts)、[数据库结构](contracts/schema.sql)、[协议能力矩阵](contracts/protocol-capabilities.json)。本专题定义所属领域的语义，直接引用共用合同，不复制第二套 Schema。

**协作边界**：Run/Fence、Intent、恢复由[Runtime 方案](02_M2_工作台与持久执行.md)定义；角色和 Context 由[对话与记忆方案](03_M3_单主聊天_上下文与个人记忆.md)提供。

## 2. 可信执行、审批与撤销

### 2.1 实际信任域

| 域 | 最小权限与必要隔离 |
|---|---|
| Renderer/Artifact 展示 | `contextIsolation=true`、无 Node 集成、CSP、安全 Markdown、受限导航/外链；Artifact 隔离 Origin 与无主 App Token |
| Host/Runtime | 受保护二进制与配置、业务库、审批 UI；仅白名单 IPC；校验真实路径、来源、Profile 与对象权限 |
| Agent 工具执行域 | 限定工作区挂载/可读范围，环境变量白名单、资源限制；无法修改 Host/Policy/审批/凭据或直连 Driver |
| Browser/Desktop 执行域 | 专用 Profile/隔离桌面、受保护控制接口、无默认私网/宿主管理访问；MCP 不暴露任意 JS/CDP |
| Policy/Credentials/Connector | 位于工具执行域之外，独立身份与最小服务权限；真实凭据仅用于指定账号/服务的受管调用 |
| 外部服务/内容 | 按不可信输入处理，操作结果需具体证据 |

具体实现要提供 UID/命名空间、挂载、Socket 可达性、进程身份、DNS/TCP/UDP/IPv6 与代理规则。域名白名单只限制目的地，不能证明同域名请求是读取或没有泄露。仅 L4 控制无法审查 HTTPS Body；需内容控制时采用受管客户端/应用层 Broker，无法识别的敏感写入交给人工。

Sandbox 与只读 Role 不自动保证网络只读；使用通用 Shell 的只读任务也要受文件读取和网络限制。Agent 自生成脚本、绝对路径程序、浏览器 DevTools、数据下载/上传和后台子进程都在权限图中，不能只审查正向 MCP 调用。

Codex 内置 Shell/Patch 的控制方式与受管 Connector 分开：

| 执行路径 | 实际强制机制 | 取消与撤销条件 |
|---|---|---|
| Codex 内置 Shell/Patch | 锁版 Sandbox 或经验证的外部沙箱、受限挂载/网络/环境、每 Run 受控进程树、Workspace 写租约 | `turn/interrupt` 后核查后台子进程；必要时终止本 Owner 创建的进程组/cgroup，并在确认后才释放工作区 |
| 受管 MCP/Connector/Browser Action | 受保护 Gateway 校验 Grant、Action Hash、Epoch 和回执 | Session 队列、执行端屏障与在途结果账本 |
| 用户主动 PTY | 可信用户交互、Workspace 范围与受限 Renderer 通道 | 独立标记用户会话，不把它当 Agent 已获许可的自动工具 |

不假定 App Server 能给每次内置 Shell 调用注入本项目的 Grant 检查。无法逐步拦截的路径必须靠沙箱与进程生命周期收回执行能力；无法确认后台进程已停止时，保持该工作区锁定和状态未知。内置工具不接收受管服务的真实凭据或直达 Driver 的访问权，敏感外部写入只能走可信 Gateway。已发生的本地文件修改保留供用户检查，不以取消为由自动回滚用户文件。

### 2.2 Action 审批合同

Action Canonical Hash 覆盖：任务/执行身份与版本、能力、目标服务/账号、接收方、规范化正文/附件、商家/SKU/数量、最终税费/运费/金额/币种、目标版本和有效期。金额以整数字符串最小货币单位表示，不用浮点数。规范化方式需统一并测试，审批关键字段由可信组件读取并展示。

高风险提交先产生 Proposal，再由可信 UI 显示、受保护服务签发单次 Receipt。回执仅在指定 Action、Payload Hash、策略代与期限下有效；模型的一句“已批准”不提供执行权。用户改了参数、账号或目标版本就重新提案。

DLP 与动作许可分别检查：有发信能力不意味着允许把任意私人内容发给任意收件人。秘密、私人附件与截图依据来源、目的、收件人和用户授权范围处理；认证所需密码仅在 Credential Broker 的受管通道使用，不通过模型可见正文或日志传递。

### 2.3 原子预占与实际派发

每个 Computer Session 有一个受保护的串行执行器。它使用 Runtime/Task/Workspace/Policy/Privacy/Control Epoch 和有效 Lease，在实际派发边界校验 Grant，而非信任请求体中自报的 ID。

短事务预占 Action 与回执：条件更新 `uses_remaining=1 AND state='granted' AND 未过期`，同时校验 Hash 与 Epoch → 消费回执 → Action `reserved` → 提交。受保护执行器在最终可撤销边界复查控制代，写 `dispatched` 后调用 OS/Provider。两者之间崩溃仍可能结果未知，由账本对账，不能重置已消费回执并重发。

不在 SQLite 写事务中等待用户审批、模型、OS 或网络。凭据注入、批准和派发都由可信服务处理；Agent 只收到必要的状态或收据引用。服务账号、Socket 和可执行入口本身也要受强制访问限制。

### 2.4 接管与全链路撤销

`request takeover/revoke → 提升 control/policy Epoch → 清除未派发队列 → 中止可中止动作/释放按键 → Driver 屏障确认 → 记录在途状态 → 向 UI 确认控制权转移`。

接管确认之后不得新派发旧 Epoch 的输入；在请求前已交给 OS/远端的动作可能已生效，不能宣称撤回。Driver 无法确认屏障时 UI 保持“正在停止/状态未知”，而不是显示已安全接管。交还控制必须重新获取 Observation、核对当前许可并获得新 Epoch，不自动恢复旧动作队列。

取消 Goal/Task 或撤销账号时，事务内停止计划/订阅/新 Operation、撤销未消费授权并提升相关代；向实际执行进程发送撤销并取得确认。撤销请求、执行端确认和在途完成是三个可观察状态。Profile/凭据变更不能跨身份复用旧 Grant。

## 3. Browser 与 Linux Computer Use

### 3.1 Browser 设计

首选受管 Playwright MCP/Driver：Accessibility Snapshot → 受限语义动作 → 新 Snapshot；只有语义不足时使用截图。工具依赖锁定具体版本，避免 `@latest` 成为可复现安装说明。

Snapshot/Frame 绑定 Session、Page、Window、URL、时间、布局和 Revision。导航、DOM/窗口关键变化后旧 Ref/Frame 失效，重观察后重新决策，不能直接重试点击。异步网页无法保证仅凭本地 `pageVersion` 排除所有 TOCTOU；高影响提交使用可信 Connector 或人工完成。

`navigate/snapshot/screenshot` 是观察类工具形状，但导航带 Cookie、URL 动作、下载或页面脚本仍可产生副作用，不能以工具名称自动认定低风险。M2 实验只开放受控测试源；真实账号 Profile 在凭据/出口/审批验收后单独开放。

Browser Broker 管理 Profile、标签页、弹窗、观察、下载、操作与回执；不将任意 CDP Endpoint 交给 LLM。上传仅来自授权目录；下载进入隔离区，校验名称、路径、MIME、大小和扫描状态。验证每次导航、重定向、解析结果与最终 IP，阻止未经授权的宿主、私网、环回和 Metadata；测试站点的环回访问使用明确的测试专用范围。

### 3.2 Desktop Driver

首个验证平台为 Linux x86_64、Ubuntu X11、单屏、独立测试桌面和 Calculator/Text Editor Fixture。XTest/AT-SPI2 提供输入与语义观察，截图作补充；不把用户日常桌面的全局输入作为默认开发环境。

Wayland 采用 xdg-desktop-portal RemoteDesktop/ScreenCast、PipeWire 与所选 Compositor 支持的授权接口；具体调用顺序、窗口选择和恢复能力需实测，缺失时显示不可用，不通过绕过系统权限补齐。

坐标映射统一截图像素、桌面逻辑坐标、物理屏幕及窗口局部坐标，处理 DPI、缩放、旋转、多屏负原点。Observation 带 `displayId/size/scale/rotation/windowId/frameId`；窗口焦点和显示布局变更使旧坐标失效。用户输入、锁屏、Portal 撤销和会话结束触发控制权处理。

### 3.3 密码、接管与敏感操作

人工登录通过可信 UI/受管浏览器完成，期间暂停 Agent 输入和敏感观察。Browser Cookie/Profile 与主 LLM 隔离；Passkey、验证码和 2FA 交给用户。登录成功只返回状态；退出或凭据撤销后相关任务等待重新授权。

API/CLI/Connector 能可靠完成时优先使用；其次 Browser 语义，再是截图与 Desktop。任意 GUI 无法可靠绑定具体交易参数时保留人工提交，不承诺完整自动付款。截图与 Accessibility 可能泄露密码重置链接、通讯和健康资料；只捕获授权范围，按模型数据流授权和保留期处理。

GUI 原型建议有单步超时、总时长、动作次数和无进展阈值，例如 50 次输入、10 分钟总时长作为初始可调参数；实测后调整，不能当作安全证明。无变化时 Replan/Ask；Unknown 操作先对账，Control Revoked 不自动夺回权限。

## 4. 能力开放顺序与验收

| 能力 | 开放前证据 | 未取得证据时 |
|---|---|---|
| M1 受限代码工具 | 上游 Sandbox/审批真实有效，路径/IPC/日志范围可控 | 阻止该执行能力，不能通过自动批准演示 |
| 测试 Browser | 专用无真实账号 Profile、测试 Origin、受管观察/动作与结果计数 | 只开展离线/Stub 验证 |
| 隔离 Desktop | 明确屏幕/窗口/进程范围、坐标与权限探测、接管屏障 | 不控制用户日常桌面 |
| 登录态与敏感外部动作 | 凭据隔离、出口/参数/回执、单次消费、撤销与对账验收 | 人工完成受保护提交或关闭能力 |

先实现观察与受限输入，再实现 Session Queue、Epoch/Grant、回执原子消费、Driver 屏障和对账。前置检查到实际派发之间的竞争窗口必须用故障注入触发，不能只测串行成功路径。

交付 ComputerActionEnvelope、Observation/Frame 元数据、Session 状态、可信 Action Receipt 和可审计的控制权确认。接口形状以 domain.ts 为准；Driver 若无法确认停止，就返回未知/等待，不能伪造已接管。

测试使用模拟发送/付款、假 Cookie 与隔离网络；拒绝路径要证明目标端点未接收到请求、旧 Epoch 未派发新输入。Prompt 中写“禁止越权”和模型口头拒绝不是强制边界测试的替代证据。

## 5. 开发验证要求

以下只规划 对应能力开放前 必须覆盖的验证范围与验收证据。具体输入、步骤、Fixture、故障注入方式和自动化实现，在对应工作包真实开发时并行细化。当前不宣称已经形成完整用例库或通过应用验收。

| 验证方向 | 必须覆盖 | 验收证据要求 |
|---|---|---|
| 执行域与旁路 | Shell/绝对路径/Socket/CDP/URL/上传以及身份与文件边界 | 强制访问控制与目标端点记录 |
| 批准与回执 | 参数/账号/Hash/期限变更、重复消费与未知提交结果 | 单次预占、真实 Receipt/Unknown，不复填授权 |
| 撤销与接管 | 授权后/派发前/派发后撤销、旧队列、Driver 屏障与恢复观察 | 接管确认后无旧 Epoch 新派发；在途结果明确 |
| Browser | Snapshot/Ref 过期、导航副作用、重定向、受控文件和 Profile | 页面/动作版本与隔离证据，模型口头拒绝无效 |
| Desktop/隐私 | 窗口/DPI/布局改变、锁屏/Portal、密码注入和截图范围 | 真实驱动/平台证据与脱敏记录；模拟器单列 |

每项实际验证记录正常/失败/拒绝/恢复结果，区分真实组件、Stub、模拟器和外部阻塞；执行状态与证据格式遵循[总体规划](00_总体架构与开发规划.md)的开发验证规则。
