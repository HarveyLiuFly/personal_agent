# Muse 类 Personal Agent：产品与技术研究全量总结

> **版本**：v1.2（2026-10-31；保留截至 2026-10-26 的全部正文）  
> **范围**：本轮围绕 Meta Muse、OpenAI dots、开源替代及相关技术的全部讨论，含产品、用户流程、案例、架构、实现机理、逆向研究、风险、源码与参考资料。  
> **配套文档**：《复原的技术架构设计文档.md》详细说明一套以 OpenMuse 为底座的可实施复原方案。  
> **阅读原则**：保留讨论中重要的事实、数字、示例和未解问题；对同一问题后来获得的更可靠证据，以后续核对为准；示意代码/流程不是官方源码。


> **最新增补：v1.1（2026-10-26）**。新增 §20「10 月 12–26 日产品与开源生态更新」：Muse Wonder / Muse Spark Open、Claude Duet、dot 手机端能力、OpenMuse/OpenDots/OpenBot/nanoMuse 最新公开进展，以及模型/多 Agent 选型的结论修订。**原 v1.0 章节完整保留**；原文中出现的“当前”默认指 2026-10-11 的调研基线，应结合 §20 阅读。

### 2026-10-26 快速增量索引

| 变化 | 核实级别 | 对此前结论的修订 |
|---|---|---|
| Meta 10/12 Muse Wonder / Wonder Full 发布 | [官方] | 新增 Active Memory / Active Focus **模型能力**，但不能视为公开了新的 Scheduler 或 Claims DB |
| Meta 10/15 Muse Spark Open 开放权重 | [官方] | 816B 总参 / 42B 激活 / 1M Context；可自托管但不是轻量端侧模型，且须遵守 Muse Model License |
| Anthropic 10/21 Claude Duet 产品、10/23 安全技术文档 | [官方] | 新增第三套可直接比较的长期主动 Agent 产品与凭据/审批/外发隐私方案 |
| dot 帮助中心更新 | [官方] | 支持在 iOS/Android App **创建** dot；Task 独立 Conversation；Scheduled 可管理；不能沿用“只能桌面创建”的旧口径 |
| OpenMuse/OpenDots 当前能力变化 | [代码/文档] | E2B Desktop 是**可选**后端，但它直连互联网且无统一网络强制审批；OpenBot 集成仍有待验收的部分 |
| 10/22 Anthropic Agent 架构实践 | [官方技术经验] | 不必每一种能力都开 Sub-Agent；只在上下文隔离、并行、权限差异或评测收益明确时拆分 |

**时间基线**：本次核对截至 2026-10-26。涉及仓库 main 分支的能力及配置，属于可变快照；未实际在本次工作中部署或运行云端产品，不宣称完成端到端实测。


## 0. 来源分级、信息边界与导航

本文采用以下标签：

- **[官方]**：Meta / OpenAI 官方产品、帮助或安全文档明确发布。
- **[代码]**：开源项目当前仓库 README、SECURITY、ROADMAP 或源码中可核对的实现。
- **[逆向]**：第三方研究者从运行环境、导出文件或系统指令观察到的实现，非官方稳定接口。
- **[设计]**：我们为复现产品提出的架构、算法、Schema、交互和安全要求。
- **[待核]**：材料不足、版本冲突、未经过真实生产环境验证或不能确定的行为。

必须避免以下混淆：用户产品入口 ≠ Agent Session ≠ LLM Context Window；持久化 Task ≠ 永不停止的 LLM Loop；Tool Worker ≠ 独立 Sub-Agent；Agent 自己“同意” ≠ 可信授权；Prompt 行为约束 ≠ Linux/网络层强制保护；公开功能演示 ≠ 所有地区用户可用；开源代码 MIT ≠ 第三方运行服务也采用 MIT。

### 目录

1. 产品定位与演进背景
2. Muse 用户旅程与界面
3. 官方用户案例清单
4. 购物案例完整展开
5. 云端购物、登录与付款的职责分工
6. Muse 总体架构与子模块职责
7. Hatch、Sub-Agent 和 Agent Loop
8. Browser Agent、Broker 与 Computer Use
9. Tools、Skills、CLI、Connectors
10. Secure VM、Sentinel、Authd、Privsep、Hatch Safety
11. Memory 深入机制与三张核心表
12. Goals、主动任务、Future Task 与 Scheduler
13. OpenAI dots 对比、Session 切分与 Router
14. Linux 宿主与系统改造要求
15. 开源项目生态对比与选型
16. OpenMuse 源码与运行机制
17. 未解决问题、风险、评估与实施方向
18. 技术术语对照
19. 参考链接与讨论覆盖索引

---

## 1. 产品定位与演进背景

### 1.1 Muse 是什么

[官方] Meta 于 **2026-09-08** 发布 Muse，定位为可长期陪伴用户、理解个人偏好和目标、跨应用代办、运行后台任务并主动跟进的 Personal AI Agent。它不仅回答问题，还可以在用户专属云端计算机中操作网页、执行工具、写程序、生成文件、创建定时任务，并让用户控制许可范围。

一句话概括：**从“User → Prompt → Answer”演进为“User → Goal → Agent 持续规划与执行 → 人工监督 → 新事件触发后再次行动”。**

[官方] 与只在对话时回答问题的聊天机器人不同，Muse 强调：

- 一个持续的个人 Agent 身份、可编辑记忆和个性化交互；
- 用户委派任务或建立长期 Goal；
- 云端 Secure VM、浏览器、文件、Shell、Skills、Connectors；
- 多个并发 Sub-Agents、Cron 与后台持续工作；
- Ideas（主动建议）、Goals（目标）、Activity（监督）与审批卡片；
- 对高风险行为使用独立安全服务，不能由 Agent 本身绕过。

### 1.2 自主能力的五级理解（我们的概念性分类）

| 等级 | 用户指令与触发 | Agent 行为 | 核心能力 |
|---|---|---|---|
| L1 被动问答 | “推荐耳机” | 给答案 | 查询/总结 |
| L2 一次性自主执行 | “帮我买耳机” | 搜索、比较、购物车、请用户批准 | Agent Loop + Tools |
| L3 定时自动化 | “每天检查价格” | 按日自动检查 | Cron + Durable Task |
| L4 条件触发 | “价格低于 $150 通知” | 监测事件并通知 | Watcher + 条件求值 |
| L5 Goal 驱动的主动执行 | “下月出差前准备会议设备” | 自己拆解、安排检查、发现新行动、更新计划 | Goal Manager + Proactive Engine + 权限与任务闭环 |

**主动发现、主动执行、主动通知**是三个独立能力。定时 Cron 本身并不表示“智能主动”；L5 的区别是没有被逐条预设的行动也可以在目标和上下文中被发现。所有行动依旧受授权及用户可控策略约束。

### 1.3 与普通 Agent Framework 的分界

普通框架关注 LLM → Tool → Result；Muse 类系统额外关注任务在数天至数月的生命周期、跨任务记忆、浏览器会话、后台唤醒、权限、故障恢复、任务一致性、成本、长期交互。Meta 的创新更偏**系统集成、安全边界、长期任务产品化**，不是发明了唯一的新 Agent Loop 算法。

### 1.4 地区等待名单与早期访问（聊天讨论的产品背景）

用户在 Muse App 看到“尚未在你的国家或地区开放”，邮箱收到“已加入 Muse 等候名单”。前者指向**地区可用性约束**，后者确认已经登记等待，二者不代表审核失败，也不代表有固定排队天数。[待核] 官方未给出每个账号的开放倒计时，不能承诺“一周内”或“几周内”必定开放。地区资格可能与账号、平台、实际地区和服务端资格策略有关；不能确认 Meta 精确使用哪些字段。

曾讨论 iPhone 系统地区、Apple Account/App Store 国家、Meta Account 地区和 IP 的区别。已能安装 Muse 并登记时，Apple ID 切区未必是关键；系统“语言与地区”主要影响本地化，不保证改变服务端资格。不建议伪造付款地址、身份或居住信息。应以真实资格、官方开放和客服说明为准。

---

## 2. Muse 的完整用户旅程

### 2.1 首次使用与日常交互

[官方/设计归纳] 典型路径：

```mermaid
flowchart TD
 A[进入 Muse 并设置 Agent 身份] --> B[对话建立个人上下文与偏好]
 B --> C[连接邮箱/日历/社交等应用并明确授权]
 C --> D[输入一次性任务或长期 Goal]
 D --> E[澄清缺失条件并展示计划]
 E --> F[云端自动执行、生成文件或跨站操作]
 F --> G{遇到敏感操作?}
 G -- 是 --> H[独立审批卡片/用户接管/认证]
 H --> I[继续或停止执行]
 G -- 否 --> I
 I --> J[结果、Activity 与可复用 Artifact]
 J --> K[Goal 更新/未来任务/主动建议与通知]
 K --> F
```

用户侧的典型入口：

| UI / 交互 | 用户所做的事 | 系统职责 |
|---|---|---|
| Main Chat | 连续交代新任务，追问旧任务 | 长期个人交互入口与路由 |
| Side Chats | 专题交流、与主对话相对隔离 | 上下文隔离/专题回顾 |
| Goals | 设定与检查长期目标及里程碑 | Goal 状态、计划、评估 |
| Ideas | 审阅主动建议、接受/拒绝 | 基于已授权观察给出建议 |
| Activity / Computer | 看 Agent 进度、网页操作、历史 | 操作可见、日志、接管 |
| Permission / Approval | 批准特定发送、付款等动作 | 可信授权，不经 LLM 口头裁定 |
| Library / Artifacts | 文档、报表、交互页面、工作文件 | 文件与可视化结果的生命周期 |
| Identity / Memory | 查看、修改、纠正 Agent 记忆 | 长期个人上下文维护 |

[待核] 具体 UI 字段、某些主动性滑杆及平台布局可能随产品灰度变化；这里是产品概念与官方说明的集合，不是所有账号在同一天一致的页面截图。

### 2.2 三类用户任务循环

1. **即时循环**：提交任务 → 自主执行 → 结果/审批。
2. **长期 Goal 循环**：建立目标 → 拆分行动 → 设定未来触发 → 复查进度与重规划。
3. **主动服务循环**：事件/时间到来 → 判断重要性 → 低风险自动处理 → 必要时提醒用户。

Muse 的重要产品变化是把聊天当作统一入口，Activity 负责监督，Goals 负责长期状态，Ideas 负责发现机会，审批界面负责确定性授权；不是把全部生命周期塞进一个无限长对话。

---

## 3. Meta 官方披露与演示的用户案例

需区分**官方演示/提出的使用场景**和**真实用户或内部人员反馈**，也不可将未来集成当成已开放功能。

### 3.1 家长准备孩子开学事务（官方内部真实案例）

[官方] 产品设计负责人 Mona Sarantakos 描述的案例：学校与学区的邮件/网站变动、开学日程、家庭日历、用品列表、采购购物车、打折卫衣、开学晚餐安排，并在体育选拔报名截止约 12 小时前发现紧急事项主动提醒。

典型链路：**长期 Goal → 邮件/学区网页持续观察 → 日期和事实提取 → 日历/购物/预订 Tool → 发现意外截止时间 → 主动通知。** 注意：官方披露个例不等于所有第三方站点操作均可靠。

### 3.2 官方产品示例场景总表

| 领域 | 代表需求 | 技术特征 |
|---|---|---|
| 旅行 | 目的地研究、日本旅行、行程与预订 | Browser + Calendar + Goal |
| 购物与账单 | 搜索比价、加入购物车、支付审批、账单协商/价格观察 | Browser + Authd + Sentinel |
| 二手交易 | 协助出售汽车，寻找更合适报价 | 多站研究/沟通 |
| 聚会 | 从 Instagram 收藏食谱制定购物清单，兼顾朋友饮食限制与邀请 | 社交 Connector + Memory |
| 个人健康/训练 | 根据日程调整训练计划 | Goal + Memory + Calendar |
| 天气 | 预警可能的下雨时机 | Watch + Notification |
| 个人分析 | 消费跟踪器、睡眠 Dashboard | Files + Code + Artifact |
| 学习 | 交互学习资料、目标跟踪 | Artifact + Memory |
| AI 眼镜 | 识别货架商品/海报/学校用品清单并采取行动 | 多模态环境上下文 + Cloud Agent（分批/规划） |

官方视频：
- Field Trip：<https://about.fb.com/wp-content/uploads/2026/09/Muse_FieldTrip.mp4>
- Japan：<https://about.fb.com/wp-content/uploads/2026/09/Muse_Japan.mp4>
- Relationships：<https://about.fb.com/wp-content/uploads/2026/09/Muse_Relationships.mp4>
- Shopping：<https://about.fb.com/wp-content/uploads/2026/09/Muse_Shopping.mp4>
- AI Glasses：<https://about.fb.com/wp-content/uploads/2026/09/02_Bringing-Muse-to-AI-Glasses.mp4>

### 3.3 Small Business 场景

[官方] 2026-09-29 介绍 Muse for Small Business：企业主从邮件、日历、新闻中筛选紧急事项，广告活动效果分析、下一轮营销策划，销售数据和费用异常分析、年度计划、持续邮件草稿等。官方提及 Mulholland Grocery 店主 Tom Mulholland 的早期体验；这是客户反馈，不等于公开了生产业务指标、独立评测或量化节约工时数据。

### 3.4 Creator Stories

官网曾展示 Ryan Serhant（Pumpkin）、Ashley Graham（Lux）、Teyana Taylor（AunTEY）、Ally Love（Mango）等创作者与其 Agent 的故事。应视为产品场景与营销资料，不等同于稳定可靠的技术验收数据。

### 3.5 AI 眼镜的产品意义

眼镜采集视觉/语音/环境上下文，用户不必逐项描述视觉内容，例如看见货架上的耳机，问“这款值得买吗？”→ 识别型号与售价 → 云端检索 → 手机上的详细对比与付款审批 → 眼镜简短播报。该完整流程是工程化延展示例；眼镜集成的具体操作权限与平台支持必须以实际上线为准。

---

## 4. 完整购物案例：从指令到售后

案例约束（虚构示例，不是实时商品与价格）：购买**黑色、全新、头戴式 ANC 耳机**；舒适度优先，兼顾会议；**含税费预算不超过 $200**，希望**本周五之前收到**，**付款必须人工批准**。

### 4.1 用户可见的八阶段

| 阶段 | 用户看到什么 | Agent/系统行为 |
|---|---|---|
| 1 需求 | 输入目标和约束 | Intent Parser 形成结构化 Task |
| 2 补问 | 头戴式还是入耳式等问题 | 只补问影响决策的必要信息 |
| 3 搜索 | 任务执行状态 | 跨网站导航、读取库存、配送、政策 |
| 4 比较 | 候选 A/B、推荐依据 | 证据核对、排除不合条件项 |
| 5 准备 | 用户选择候选 A | 加购物车、选择规格、核对结账金额 |
| 6 审批 | 独立付款卡片 | 审批与具体商家、金额、商品绑定 |
| 7 下单 | 支付结果、订单号 | 受控提交、记录回执，未知状态时不重复付款 |
| 8 售后 | 可授权物流/降价跟踪 | 新 Watch/Task 和主动提醒；不应默认无限追踪 |

示例候选 A $169、B $179、审批总额 $182.52（税 $13.52、运费 $0）都是**交互演示数字**，不可当成实际报价。用户说“选 A，帮我下单”意味着开始准备交易，但不能代替独立付款审批。

### 4.2 失败与异常

| 异常 | 正确行为 |
|---|---|
| 缺货/配送不合约束 | 重新筛选，提出替代品 |
| 结账价格变动 | 重新展示最终准确总额并审批 |
| 验证码/Passkey/2FA | 暂停自动化，用户安全接管 |
| 用户中途更改预算 | 更新 Task 版本，废弃旧约束推导 |
| 付款超时、结果不确定 | 进入 OUTCOME_UNKNOWN，先对账，不自动重试 |
| 用户拒绝付款 | 保留可修改任务，不做交易 |
| 用户撤销凭据 | 中止所有依赖该凭据的未决能力 |
| 恶意商品页注入 | 把网页视为不可信输入；强制层审查外发请求 |

### 4.3 完整购物时序（功能与安全双控制线）

```mermaid
sequenceDiagram
 autonumber
 actor U as 用户
 participant APP as 手机App
 participant H as Hatch/Main Agent
 participant BA as Browser Sub-Agent
 participant BR as Browser Broker
 participant WEB as 电商网站
 participant AU as Authd
 participant SE as Sentinel
 participant PAY as Stripe Link/支付服务
 U->>APP: 买符合预算和时限的耳机
 APP->>H: 创建任务/约束
 H->>BA: 搜索和比较
 loop 页面执行
  BA->>BR: 受控快照/动作请求
  BR->>WEB: 网页访问
  WEB-->>BR: 页面/价格/库存
  BR-->>BA: 语义页面结果
 end
 BA-->>H: 候选及来源
 H-->>APP: 推荐
 U->>APP: 选择A并继续
 APP->>H: 确认商品
 H->>BA: 加购物车、结账准备
 opt 网站需要登录
  BA-->>APP: 需要用户认证
  U->>APP: 在安全登录界面输入
  APP->>AU: 直接安全提交凭据
  AU->>BR: 受控填入/建立登录会话
  Note over BA,BR: 注入或人工接管时暂停 Agent
 end
 BA->>BR: 请求结账页面与交易摘要
 BR->>WEB: 进入Checkout
 WEB-->>BR: 商家/商品/总价
 Note over BR,SE: 交易受强制审批约束
 SE->>APP: 显示交易审批卡片
 U->>APP: 批准或拒绝
 APP->>SE: 独立授权结果
 alt 拒绝
  SE-->>H: 拒绝/任务等待修改
 else 批准
  opt 需要临时支付凭据
   SE->>PAY: 发起受约束支付凭据流程
   PAY-->>BR: 受保护的一次性支付信息
  end
  SE-->>BR: 对本次符合条件的动作放行
  BR->>WEB: 提交订单
  WEB-->>BR: 订单成功或未知结果
  BR-->>BA: 页面结果
  BA-->>H: 订单状态和回执
  H-->>APP: 结果/后续处理建议
 end
```

**抽象边界说明**：图是已披露安全角色的工程化组合，不是 Meta 公开的逐条 RPC 时序；支付实际资金结算由商家及支付体系进行，代理只在已授权范围内完成购买操作。Stripe Link 的一次性卡设计可限制商家、金额、期限，具体可用范围受当前产品与商家集成约束。

---

## 5. 云端账号登录、付款与凭据保护

**网页自动化/订单提交在用户的云端浏览器环境中进行；用户手机主要承担发起任务、确认、认证、观察和接管。**“在云端提交付款请求”不等于 Meta 自己转账。

- **已有商家支付方式**：浏览器处于已登录账号，进入 Checkout，Sentinel 在购买前要求确认具体交易。
- **需要新的支付方式**：可结合 Stripe Link 的一次性受约束卡能力；真实卡号及原始 Token 不暴露给主 Agent。
- **网站账号登录**：客户端安全 UI 收集密码 → 直接交由 `hatch-authd` → 在需要时受控输入/注入到 Chromium；注入期间 Browser Agent 暂停。
- **API Connector 登录**：通过 OAuth 获得受限 Scope，真实 Token 在 Authd 安全域；Agent 通过 Connector/代理 Token 操作，不直接读取敏感 Token。
- **网站登录与 OAuth 并不等价**：网站 Session 可能允许更多交互；OAuth Scope 更细，但也取决于 Provider 实现。

重要安全结论：**已登录身份 ≠ 已获得任意授权**。Agent 可以在授权范围内读网页、操作购物车，但不应因为保存了 Cookie/银行卡而拥有任意支付能力。账号会话可能需要 2FA、Passkey、重新登录或因数据中心 IP 触发风控，持久 Browser Profile 不能保证永远可用。

---

## 6. Muse 云端整体架构和模块边界

### 6.1 从设备入口到执行环境

```mermaid
flowchart TB
 U[用户：iOS/Android/Web/未来眼镜] <-->|安全传输| VM
 subgraph VM[每位用户的专属 Linux Secure VM]
  subgraph CELL[不可信 Runtime Cell：systemd-nspawn]
   H[Hatch 主 Agent]
   SA[General Sub-Agents]
   BA[Browser Sub-Agent]
   CLI[CLI / Skills / 自生成程序]
   WS[用户工作目录/Memory 文件]
   H --> SA
   H --> BA
   H --> CLI
   H <--> WS
  end
  subgraph HOST[独立 Host Security Services]
   SEN[Sentinel：唯一的动作与网络出口权限裁决]
   AUTH[Authd：凭据存储/代理替身]
   PRIV[Privsep Connector Workers]
   BROKER[Browser Broker/CDP]
   SAFE[Hatch Safety]
   PG[(PostgreSQL 持久应用状态)]
   PROXY[Inference/Telemetry Proxies]
  end
  BA --> BROKER
  CLI --> PRIV
  H <--> PG
  H --> PROXY
  BROKER --> SEN
  PRIV --> SEN
  SEN <--> AUTH
  PROXY --- SAFE
 end
 SEN --> WEB[外部网站及API]
 PROXY --> MODEL[Muse Spark 推理服务]
```

[官方] Muse 为每位用户分配一个独立 Linux VM，里面有 Browser、CPU/内存/存储，可运行代码、多 Agent 和 Cron；VM 是文件和凭据的主要记录环境，推理及遥测中必要信息可经代理离开 VM。Runtime Cell 是不可信域，安全服务在 Cell 外执行。**不要把每个模块都想成一台独立 VM。**

### 6.2 职责对照

| 模块 | 输入 | 关键操作 | 输出 | 是否是 Agent Loop |
|---|---|---|---|---|
| Hatch | 用户指令、Goal/Memory/事件 | 推理、工具编排、子任务派发 | 任务与回复 | 主 Loop |
| General Sub-Agent | 子任务目标、权限和上下文 | 自主子任务执行 | Artifact/结果/阻塞 | 是（具体生命周期未公开） |
| Browser Sub-Agent | 网页目标与页面语义状态 | 观察-决策-动作循环 | 网页结果 | 是 |
| Browser Broker | 网页操作请求 | 受控 CDP/Accessibility 接口 | Chromium 动作与快照 | 否 |
| Connector/Privsep | 类型化业务操作 | 受保护服务 API 调用 | Provider 结果 | 否 |
| CLI/Skills | 工具规范、命令 | 程序执行/生成工具 | 文件/结果 | 否（由 Agent 调用） |
| Authd | 认证和凭据请求 | 保存、ACL、受控注入与代理替身 | 安全认证能力 | 否 |
| Sentinel | 操作/网络请求/策略 | Allow/Ask/Deny、网络出口检查 | 放行/拒绝/审批 | 独立安全代理/策略引擎 |
| Hatch Safety | LLM/外部内容 | 风险及注入分类器 | 告警/阻断信号 | 非通用业务 Agent |
| Scheduler | Cron、事件、等待条件 | 定时/事件唤醒 | Task Run | 否 |
| Memory | 对话、文件、事实 | 存储、检索、整合 | 有出处的相关事实 | 否（或后台受控 Agent Job） |
| PostgreSQL | 持久业务事件与状态 | 事务读写 | 可恢复状态 | 否 |

### 6.3 Hatch 名称

**hatch** 普通英语有“孵化/孵出”“策划/酝酿”“舱门/小窗口”等含义。Meta 官方安全文档脚注明确指出 **Hatch 是 Muse 的内部代码名**，而非给出的正式中文词源。技术文档应称 **Hatch（主 Agent Harness/运行时）**；把它理解为“任务孵化器”仅是隐喻。

---

## 7. Hatch、Main Agent 与其他 Sub-Agent

### 7.1 主 Agent 的执行循环

```mermaid
flowchart TD
 TR[User Goal / Event] --> C[加载目标/记忆/当前 Task State]
 C --> LLM[模型推理]
 LLM --> ACT{下一动作}
 ACT -->|Reply| OUT[回复/结束本轮]
 ACT -->|Tool| TOOL[受控 Tool Gateway]
 ACT -->|Delegate| SUB[Spawn/Resume Sub-Agent]
 ACT -->|Wait| P[持久化 WAITING/触发器]
 TOOL --> U[更新 Task State] --> LLM
 SUB --> U
 P -->|未来事件/审批/用户输入| C
```

[官方] Hatch 作为 Daemon 运行在 Runtime Cell，能够使用 Shell、CLI、Skills、文件、调度器与多 Agent。**推理调用是有限长度的 Run，Goal/Task 生命周期可以更长。** Hatch 的具体 prompt 编排、进程协议、调度器、上下文压缩阈值和并发公平策略未完全公开。

### 7.2 General Sub-Agent 的最小契约

一个子 Agent 至少需要 Goal、上下文范围、可用工具与权限、执行预算、终止条件、结构化结果/证据、状态及 Run ID。按任务动态创建是自然设计；但不能断言官方存在固定的 Research/Coding/Data Agent 进程。官方已确认并发子 Agent；“Research、Coding、Data Analysis、Background Task”等是**按任务角色的合理拆分**。

- **Task-scoped**：Spawn → Execute → Return → Destroy，资源友好、容易隔离。
- **Persistent**：Create → Work → Idle → Reuse，适合长期工作，需长期身份与上下文管理。
- [官方相邻产品] Muse Code 描述了异步持久子 Agent 和事件日志；不应把 Muse Code 的细节直接归于消费版 Muse。

### 7.3 典型子 Agent 并行购物

Main Agent 可委派 Browser Agent 比较网店实时信息，另一个通用 Research 子任务检索第三方评测，再汇总候选，用户选定后让 Browser Agent 继续结账；Sentinel 单独约束付款。**不需要为每一类工具都建立一个持久 Agent。**

---

## 8. Browser Sub-Agent、Broker 与通用 Computer Use

### 8.1 Browser Sub-Agent = 独立逻辑操作循环

[官方] Muse 使用特别的 Browser Sub-Agent，由 Muse Spark 1.3 执行网页目标：**读页面 → 理解状态 → 决定浏览器动作 → 通过 Broker 执行 → 再次观察**。它的独立性是任务/上下文/循环层面，不代表官方公布了专属进程、专用模型实例或每个网站独占进程。

```mermaid
flowchart LR
 GOAL[网页目标] --> OBS[Accessibility Snapshot]
 OBS --> DEC[LLM 网页决策]
 DEC --> API[受控 Browser API]
 API --> BR[Broker/CDP]
 BR --> CH[Chromium]
 CH --> OBS
 DEC -->|任务完成/阻塞| RET[向 Hatch 回报]
```

Accessibility Tree 示例（示意）：

```text
Document: Product Detail
 heading "Wireless ANC Headphones"
 text "$169.00"
 text "In stock"
 combobox "Color" → Black
 button "Add to Cart"
 link "Shipping Information"
```

[官方] Browser Agent 不直接访问 raw DOM、不执行任意页面 JavaScript、不能直接持有完整 CDP；Broker 在 Runtime Cell 外控制 CDP；密码填入或用户接管时暂停自动控制。Browser 输入还经过额外的安全分类器，可拦截或要求人工查看。

### 8.2 与截图驱动的 Computer Use 对比

| | Muse 消费版 Browser Sub-Agent | Muse Spark Computer Use API |
|---|---|---|
| 观测 | Accessibility Tree | Screenshot |
| 执行 | 受控浏览器动作 | 结构化 `computer_call` 鼠标键盘等动作 |
| 浏览器 | 云端 Chromium / Broker | 开发者自行准备 Driver 与执行环境 |
| 安全 | 浏览器专属分类器及 Sentinel | 开发者实现执行层安全 |
| 适用范围 | 网页交互 | 通用 GUI 亦可 |

截图驱动更适合无良好无障碍接口的图形应用，但视觉定位及动作成功率受分辨率、动画和 UI 变化影响；语义快照通常更省 token、易约束，但不适合所有视觉任务。可采用双模：Accessibility 优先，截图只在受控许可的降级路径使用。

### 8.3 Browser 会话管理与接管

Browser Profile 保存 Cookie/LocalStorage 与站点状态；Credential Store 保存高价值认证信息；Session Ownership 表示哪个用户拥有 Session；Control Ownership 表示当前由 Agent 还是人操作。典型状态：`BOT_CONTROL → HUMAN_REQUESTED → HUMAN_CONTROL → RESUME_REQUESTED → BOT_CONTROL`。Agent 接回时必须重新观察当前页面，不能基于旧快照继续点击。

---

## 9. Tools、Skills、CLI、自生成能力、Connectors

**Skill** 侧重指导 Agent 如何做；**Tool** 是有执行结果和权限的动作接口。Muse 模型针对 CLI/Skill 的零样本工具调用、长轨迹指令和多 Agent 协作做过训练。[官方]

### 9.1 典型流程

能力缺口 → 找到 API/CLI 或编写脚本 → 沙箱测试 → 注册版本化 Skill/Tool → 后续按需加载 → 在权限系统约束下执行。官方确认 Agent 可编写代码、生成自定义连接器，但具体发布测试门槛/注册格式未公布。建议增加 `DRAFT → TESTED → APPROVED → ACTIVE → DEPRECATED`，不要允许生成的代码自行提升凭据权限。

### 9.2 Connector 的职责

例如 Gmail、Calendar、Instagram、Facebook 或其他第三方 API，必须有参数 Schema、Scope、操作等级、版本/授权策略、执行回执。Gmail 包含 OTP、密码重置链接、Magic Link 等高价值秘密，Meta 官方提及对内置邮箱 Connector 的这些内容进行过滤和分类，不应自动向 Agent 直接暴露。

---

## 10. Secure VM 与四类安全服务

### 10.1 容器与宿主双安全域

[官方] Runtime Cell 使用 `systemd-nspawn` + User Namespace；容器 Root 对应 VM 非特权用户；单独 Debian 根文件系统、veth、系统调用过滤（例如禁用 `io_uring`）、禁用 `CAP_SYS_PTRACE`/`CAP_NET_ADMIN` 等。Host 侧 `systemd` 服务包括 `hatch-safety`、`privsep`、`hatch-authd`、Sentinel、Postgres、推理/遥测代理。跨边界通过 Unix Domain Socket，`SO_PEERCRED` 绑定 Linux 核验的对端进程身份，不用可被 Agent 偷取的 IPC 共享密钥。

### 10.2 Sentinel：唯一的权限裁决与强制出口控制

Sentinel 是独立的 host-side agent，负责 Connector 动作及网络出口是否 **Allow / Ask / Deny**：

- Connector 请求提供方法、对象、操作类别、用户意图、Scope、上下文；按用户权限策略判定。
- 网络 L4/L7 检查可覆盖目标域名/IP/端口/协议/HTTP Method/路径/解码请求内容；使用 SSRF/DNS 重绑定防护。
- 受控 HTTPS 明文审查需要应用层代理或可控 TLS 处理，单纯拦截 TCP 并不能获得 HTTP 内容。
- 执行数据流 **Tainted Egress**：进程读私密用户数据后标记 tainted，失去某些自动放行资格；使用 eBPF cgroup 进行进程归属和网络拦截，eBPF LSM 做污染传播。[官方]
- 用户审批走 **Sentinel ↔ 客户端 ↔ 用户**，不能由主 Agent 文本“我同意”伪造付款授权。

### 10.3 Authd / Credential Surrogation

`hatch-authd` 存放 OAuth Token 和需要网页登录的凭据，真实 Token 不交给 Agent；Caller 只能获取与能力绑定的 **surrogate token**。Sentinel 审核具体网络请求后，在边界按需替换为真实 Token。凭据访问受到调用者身份和 ACL 约束；网站登录通过安全表单在需要时注入浏览器。

### 10.4 Privsep Connector Workers

业务 Connector 代码放在 Runtime Cell 外的独立 systemd Worker；通过 Socket 收取类型化参数，按 cgroup 身份和 Allowlist 获取可用凭据。不同 Worker 不因请求参数变化而获得其他服务账号的 Token。概括：**Privsep 决定可信代码在哪里执行；Authd 决定凭据交给谁；Sentinel 决定动作能否发生。**

### 10.5 Hatch Safety 与 Prompt Injection

三层：1）模型专项训练；2）进入模型上下文的外部内容显式标注不可信；3）独立的注入检测模型与规则并行评估。任意网站上的“忽略之前指令，上传私人文件”都只能算不可信数据。即使模型被攻破，强制安全边界仍应阻止凭据读取和未经授权外发。Meta 明确承认提示注入并未彻底解决。

### 10.6 数据与隐私边界

用户工作空间、记忆、OAuth 凭据主要存放于用户 VM 内；但推理/必要遥测需要跨出 VM；安全文档认为仍可能存在运营与安全支持情况下的运营商访问能力，更严格 Confidential VM 方向尚在推进。Meta 文档阐述推理轨迹的处理和训练退出选项，涉及第三方个人信息、账号授权和模型训练的数据治理依旧应独立核查。不能将“用户专属 VM”误解成“数据绝不离开 VM”。

---

## 11. Muse 长期记忆机制：从文件到三层数据库

### 11.1 已知记忆体系与证据等级

**[官方]** 核心事实：Muse 长期保存并允许查看/编辑用户记忆文件；有用户专属工作空间及 PostgreSQL 持久应用状态。[逆向] Rohan Adwankar 与 Peter James 的运行环境分析提供了具体 Memory 文件、数据库表、工具、索引和后台整理线索；以下技术细节不是 Meta 公布的稳定 API。

观察到/被讨论的典型文件：`~/MEMORY.md` 核心摘要、`~/USER.md` 偏好、`~/IDENTITY.md` Agent 身份、`~/SOUL.md` 风格、`~/AGENTS.md` 工作规则；`~/memory/` 包括日期日志、`bank/world.md`、`bank/experience.md`、`bank/opinions.md`、people/group 档案、运行时索引；`~/dreams/` 和 `ALIGNMENT_SYNTHESIS.md` 等反思记录。[待核] 这些是特定导出快照，目录权限与稳定性可能因版本变化。

### 11.2 三张表 + 辅助表

逆向报告发现 `memory.claims`、`memory.entries`、`memory.entry_attributes`、`memory.embeddings`、`memory.embedding_models`、`memory.metadata` 六张表，另有更大的 `muse_db` 模式参考。讨论的三张核心表分别承担：

| 表 | 存储角色 | 典型查询 | 本质 |
|---|---|---|---|
| `memory.entries` | Markdown 片段、文件 `path#L行号`、全文索引 | 哪段记忆包含信息 | 可读文本及出处 |
| `memory.embeddings` | Entry/文本的向量索引（观察到 384 维 pgvector） | 哪些语义相关 | 搜索索引，非事实本体 |
| `memory.claims` | 可验证的事实陈述、证据、状态、历史关系 | 当前事实是什么、为何记住 | 事实演化与追溯 |

[逆向] 观察到的 Embedding 方案为 ONNX `all-MiniLM-L6-v2`（参考包名 `Qdrant/all-MiniLM-L6-v2-onnx`），向量维度 **384**，Pgvector + PostgreSQL `tsvector` 混合检索，Jina Reranker v1 Turbo 重新排序候选，较大模型不必用于每一次记忆相似度计算。第三方报告提到模型文件约 91MB 和 153MB；这些版本、容量及推理位置是环境观察，不能保证未来一直如此。

### 11.3 Entry、Embedding、Claim 为什么不能混成一张表

- **Entry** 存源文和位置。一段“我每天乘地铁一小时，买耳机重视 ANC 和舒适度”可被分块为一个 Entry。
- **Embedding** 为该 Entry 生成向量，可随模型升级重建，不应让向量代替原文。
- **Claim** 抽出至少两个事实：每日通勤约一小时、买耳机重视降噪和舒适度。单个 Claim 可能有多个 Entry 和原始消息证据；一段 Entry 也可支撑多个 Claim。

**建议复现时新增 `claim_evidence` 多对多关联表**：`claim_id ↔ evidence_id ↔ entry_id / raw_message_id`。必须明确这是复现 Schema，而不是官方列名。

### 11.4 Claim Supersession、时间与置信度

逆向观察有 `supersedes_claim_id`，用于新事实取代旧事实。例如 C001“过去优先最低价”→ C002“现在更重视质量和售后”。但“未来两个月预算紧”可能只是临时约束，不应覆盖长期偏好。建议 Claim 存储 `subject/predicate/object/fact_text/source/trust/confidence/status/valid_from/valid_until/recorded_at/supersedes_claim_id`，其中大多数是设计建议而非确认列名。

建议使用**双时间模型**：`valid_from` 表示现实中生效日期，`recorded_at` 表示 Agent 何时得知；否则无法区分“事情何时改变”与“系统当时是否知道”。`confidence` 是证据可信度/抽取质量指标，不是模型输出的真理概率。对推断/外部网页内容降低信任等级。

### 11.5 写入流程

```mermaid
flowchart TD
 M[用户消息/工具结果] --> CAP[保存原始不可变证据]
 CAP --> EXT[提取候选长期事实]
 EXT --> D{稳定且值得记忆?}
 D -- 否 --> SHORT[只更新当前 Task State]
 D -- 是 --> CHECK[查找既有 Claim/来源]
 CHECK -->|新增| NEW[新增 Claim/Memory]
 CHECK -->|修正| RECON[标记取代/纠错/有效期]
 NEW --> FILE[Markdown 文件/细粒度记录]
 RECON --> FILE
 FILE --> IDX[FTS/Embedding 增量更新]
 IDX --> RET[供未来检索]
```

Prompt 可以指导立即记录用户明确偏好；后台 Consolidator 可批量审阅、去重、核对证据、整理 Memory Bank。索引更新应异步但幂等。Entry 行号可能因编辑漂移，复现时需存 `file_revision`、`content_hash` 与行范围，并保留不可变原始消息出处。

### 11.6 检索流程

```mermaid
flowchart TD
 Q[当前用户问题/Task Goal] --> FTS[关键词检索 PostgreSQL FTS]
 Q --> EMB[Query Embed 384d]
 EMB --> VEC[pgvector 相似度检索]
 FTS --> FUS[候选融合]
 VEC --> FUS
 FUS --> RR[Jina Reranker]
 RR --> CLAIM[Claim 有效性/证据/时间过滤]
 CLAIM --> GET[读原文与来源]
 GET --> CTX[Context Builder]
 CTX --> LLM[Muse Spark]
```

第三方提及 `memory_search`（找候选）、`memory_get`（取具体内容）、`memory_explain`（解释证据链），但检索 Top-K、向量融合权重、Reranker 阈值、事实校验调用顺序尚未完全公开。

为何 Hybrid：语义搜索能召回“舒适度”与“长时间佩戴”，关键词适合型号/订单号/联系人/精确短语。Reranker 排序相关性；Claim 层防止**高度相关但已过时**的事实被当作当前真值。

### 11.7 后台 Dream / Reflection 与人物档案

[逆向] 部分研究观察到 hourly Claim Audit、日期/主题 Memory Bank 更新、`people/` 与 `groups/` 档案（Facts、History、Relationship、In common、Open threads、Strengthening），以及后台 Dream/Alignment Synthesis。反思主要是总结长期交互偏好、改进 Agent 行为，不是为每位用户训练私有模型权重。研究也提醒：梦境/反思文件存在不等于一定被注入后续 Prompt。对第三方人物（未使用 Muse 的朋友、同事等）存储资料存在隐私风险。

### 11.8 记忆删除与清理

删除聊天消息不必然同步删除已提取 Memory。Forget 应追溯相关 Memory 文件、Claims、Entry、Embedding、摘要及派生索引，同时尊重适用备份/保留策略；长期目标与 Future Task 还应检查是否引用已撤销事实。用户可在身份/记忆与 Data Controls 查看、纠正、下载或重置 Muse 数据，具体按钮可能变化，以官方帮助文档为准。

### 11.9 Memory、Context 与任务状态分离

| 数据 | 生命周期 | 示例 |
|---|---|---|
| Personal Memory | 跨所有任务 | 喜好/人物关系 |
| Episodic Memory | 事件/历史 | 一次过去的购物及其结果 |
| Task State | 当前/长时任务 | 付款等待/下一唤醒时间 |
| Conversation Summary | 某一对话上下文压缩 | 某任务已做出的决定 |
| Workspace / Artifact | 文件/项目资产 | PDF、脚本、网页成果 |

“`memory_search` 成功”不等于事实被认证，更不等于第三方网页能写入高信任级的用户偏好；Memory Pro­venance/Trust Level 需要与权限体系打通。

## 12. 主动任务执行：Goals、Future Tasks、Scheduler

### 12.1 Goal 不是 Cron

[官方] 用户建立 Goal/Task 后，Muse 可根据计划时间或相关事件继续工作，适时通知用户，VM 支持 Cron 和并发工作。公开资料**没有给出** Agent 自主注册每个 Cron、事件 Watcher 的完整内部 API、阈值和容量限制。

核心模型：

```mermaid
flowchart LR
 G[长期 Goal] --> PL[Planner]
 PL --> FT[Future Task Registry]
 FT --> SC[Scheduler/Event Watcher]
 SC -->|未来触发| AG[Agent Run]
 AG --> T[Tools/Sub-Agents]
 T --> EV[Goal Review]
 EV -->|增删改后续任务| FT
 EV --> G
```

例如“下个月日本旅行尽量节省开支”：价格监控（每天）、酒店库存（阈值/定时）、出发前 14 天清单检查、出发前 3 天天气、航班变更事件等。**这些是根据能力构造的示例，不代表所有 Watcher 均为 Muse 内置。**

### 12.2 四种触发与五个关键逻辑单元

| 触发 | 例子 | 系统实现 |
|---|---|---|
| Cron/时间 | 每早看邮件 | Scheduler，无须长时占 GPU |
| 事件 | 新邮件/订单状态变化 | Webhook/Event Bus |
| 条件 | 价格低于阈值 | Poller + Rule |
| 目标驱动 | 出差提前导致采购计划失效 | Relevance Model + Planner |

关键模块：Goal Store、Event Detector、Relevance Evaluator、Task Registry、Notification Policy。系统应在长时间 `WAITING` 时释放 LLM 推理资源，事件发生时重建有限上下文。Agent 可以使用 `schedule_task`、`update_scheduled_task`、`cancel_scheduled_task`，同时 Runtime 应有确定性 Hook 检查“承诺未来继续”是否已有可执行 Future Task。

### 12.3 System Prompt 的作用与边界

此前讨论的 Letta Code 系统指令含类似“工作跨越当前会话时，必须主动安排未来再次调用”的要求；OpenClaw Heartbeat 默认更保守，不应仅凭旧聊天不断衍生新任务。**Prompt 决定行为倾向；Tools、Scheduler、存储、权限与恢复机制决定实际能力。** 相同模型和工具，仅改 Prompt 就可能改变主动程度，但无法保证任务不会重复创建、忘记取消或绕过审批。Letta 在 Memory/跨会话身份和自我唤醒方面值得研究，不能仅凭一句 Prompt 认定其 Runtime 全面优于 OpenClaw。

### 12.4 Goal 完成与取消条件

需要 Goal→Tasks→Triggers 的稳定关系。机票买好后取消监控；出差日期提前时更新相关 Future Tasks；用户暂停 Goal 时停止相关触发；目标已满足时不要继续浪费 Token。真正的长期 Agent 必须具备目标完成条件、权限、预算上限、计划版本、更新机制与反复失败止损。

---

## 13. OpenAI dots：对照、连续主对话、Task 与 Context Window

### 13.1 dots 与 Muse 有哪些相同点

[官方] OpenAI dots 于 2026-09-29 公布，基于自己的 Cloud Computer，能够跨聊天与工作工具执行任务、长期持续工作、使用持久记忆与自动化任务、审批和受保护网站登录；个人可与 dot 在 ChatGPT 聊天/通话、Slack/Teams 等渠道联络。Muse 则更强调消费生活与 Meta/WhatsApp/眼镜环境和公开的 Linux 安全机制。

| 对比 | OpenAI dots | Meta Muse |
|---|---|---|
| 定位 | 工作、项目、协作与个人 Agent | 日常生活/目标/购物/眼镜延伸 |
| 模型 | GPT-6 Astra（此前讨论的发布版本） | Muse Spark（包括 1.3） |
| 执行环境 | Dot Cloud Computer；可选授权本地电脑路径 | 每用户 Secure Linux VM 为主 |
| 长期执行 | Scheduled Tasks、Proactive Research、任务委派 | Goals、Ideas、Cron、事件、Sub-Agents |
| 安全审查 | Auto-review、Secure Sign-in 等 | Sentinel、Authd、Privsep、Browser Broker |
| Agent 内部模块公开度 | 相对少 | 对 Linux、安全组件披露更详细 |
| 连接 | Plugins、企业工具、Codex/Work 协同 | Connectors、Skills、CLI/自生成工具 |
| 眼镜 | 未正式确认对应集成 | 宣布视觉环境集成方向 |

**不能因两者模块名字不同，就断言安全能力孰优；功能存在不意味着同等强度。** dots Proactive Research 的无新用户指令背景研究有明确只读限制；已授权、已配置的定时/执行任务可按正常执行权限工作。Muse 也非无限制行动，付款必须独立审批。

### 13.2 “一个 dot 始终在一个窗口聊天，上下文不会爆炸吗？”

**前台主 Conversation ≠ 每个 Task 的 Conversation ≠ 每次 LLM Run 的 Context Window。** OpenAI 帮助中心明确指出“Each task has its own conversation and doesn’t automatically receive every conversation you’ve had with your dot.” 这确定**Task 级会话隔离**，但不公开主对话具体 Compaction 阈值、Router 算法、Memory 召回实现。

```mermaid
flowchart TB
 U[长期主聊天窗口] --> ROUTER[Task/Conversation Router]
 ROUTER --> A[任务A：研究 OpenMuse 的 Task Conversation]
 ROUTER --> B[任务B：Android 开发的 Task Conversation]
 ROUTER --> C[任务C：旅行的 Task Conversation]
 ROUTER --> MAIN[普通主聊天]
 A --> RUN1[每次有限 Context 的 Agent Run]
 B --> RUN2[独立 Agent Run]
 C --> RUN3[未来自动触发的 Run]
 MEM[(长期个人记忆)] --> RUN1
 MEM --> RUN2
 MEM --> RUN3
```

主聊天持续半年不意味着模型每次都收到半年所有文字；通常会采用**完整持久历史 + 最近消息 + 摘要/Compaction + 相关 Memory 检索 + Task State**组装有限长度的 Context。OpenAI Agents SDK 提供 Compaction 机制，但不能因此推断 dots 产品采用完全相同实现。

### 13.3 Conversation Router 如何实现（详见设计文档）

动作类型：`CHAT`、`CREATE_TASK`、`QUERY_TASK`、`RESUME_TASK`、`UPDATE_TASK`、`CANCEL_TASK`、`CLARIFY`，生产可增加 `APPROVE_ACTION`、`MULTI_ACTION`。例如用户连续提到 OpenMuse、Android 项目和日本旅行后说“上一个项目进度如何”，Router 不应该直接凭最近一个后台 Worker 猜任务，而应结合 UI 焦点、显式任务引用、待回答问题、最近提及任务、语义检索和必要澄清。

推荐优先级：**显式 Task ID / Reply-to → 待回答问题 → 当前 Focus → Top-K Task 索引 + 小模型结构化匹配 → 无法唯一确定则澄清**。模型只在真实授权 Task ID 范围内选择，Dispatcher 再验证账号和状态；Schema 约束只能保证格式，无法保证语义正确。

`Conversation Router` 只判定消息归属，不直接承担 Browser/Research 执行；`Context Builder` 决定本次 Run 看哪些片段；`Task Service` 持久化长期生命周期。后台 Cron 既已绑定明确 Task ID，就无须再次语义路由。

### 13.4 `dot_id`、Conversation、Task、Run、Memory 分开

```text
dot_id
  main_conversation_id → many messages
  task_A → task_conversation_A → run_01, run_02, ...
  task_B → task_conversation_B → run_03, run_04, ...
  shared_personal_memory
  goal_registry / scheduled_tasks
```

单一前台聊天消息可通过“关联表”展示于主聊天与 Task 视图，避免复制两份不一致的原始消息。前端显示的一致性与 Context 累积机制应严格区分。

---

## 14. Linux 是否需要改造？

### 14.1 准确结论

**复现功能层面的 Muse 通常不需要修改 Linux 内核源码**。Agent Runtime、浏览器、Memory、Cron、CLI、Connector 等可以在普通 Linux 用户态实现。要对齐 Muse 的安全隔离，需要配置/启用 Linux Namespace、cgroup v2、seccomp、Capabilities、KVM、eBPF、LSM、nftables/网络代理，并开发受保护用户态服务。

| 功能 | 是否通常需要改内核源码 | 关键依赖 |
|---|---|---|
| Hatch/Sub-Agents/Scheduler/Memory | 否 | Node/Python/Kotlin、DB、Queue |
| Browser Broker | 否 | Chromium/CDP、代理进程 |
| Authd/Privsep | 否 | systemd、UDS、SO_PEERCRED、ACL |
| Runtime Cell | 否 | systemd-nspawn、User/PID/Mount/Net NS、seccomp |
| Sentinel 基础版 | 否 | Tool Gateway + Proxy + nftables |
| eBPF 网络拦截 | 需内核支持，通常不改源码 | cgroup BPF、BTF/权限 |
| Tainted Egress 精细追踪 | 可能 | BPF LSM 及部分额外 Hook；标准 Hook 够不够仍待验证 |
| Confidential VM | 依平台 | TEE/远程证明/密钥供应/可信计算 |

Meta 技术文档提及“attached to Linux Security Module hooks we added”，不能据此断言完全无需定制 Hook，也不能断言它一定维护了定制内核。采用已存在 BPF LSM Hook 的实现可不改内核；精准复刻需要实测能力缺口。

### 14.2 典型建议环境与检查

开发期可参考 Ubuntu Server 24.04 LTS 或较新的 Debian，较新稳定内核（如 6.6+，非官方要求）；确认 `CONFIG_USER_NS`、`CONFIG_SECCOMP_FILTER`、`CONFIG_CGROUP_BPF`、`CONFIG_BPF_SYSCALL`、`CONFIG_BPF_LSM`、BTF、cgroup v2、KVM（如果自己管理 VM）。

```bash
uname -r
systemd --version
cat /sys/kernel/security/lsm
cat /sys/fs/cgroup/cgroup.controllers
sudo bpftool feature probe kernel
```

需区分物理宿主/Hypervisor 与用户 VM 里的 Linux；`systemd-nspawn` 只是 VM 内不可信 Runtime Cell 的一层隔离，不能作为恶意多租户的完整 VM 替代。

---

## 15. 开源框架：路线、比较与许可证

### 15.1 普通个人 Agent / Runtime 候选

| 项目 | 适用重点 | 关键能力与限制 | 仓库 |
|---|---|---|---|
| OpenClaw | 快速个人助理 | Gateway、Cron、Heartbeat、Skills、Sub-Agents、浏览器；Goal 与未来调度的完整闭环仍要集成 | <https://github.com/openclaw/openclaw> |
| Letta Code | 长期自主与身份记忆 | MemFS、Self-scheduling、Wake/Cron/Monitor、持久 Agent；具体自托管定时生命周期需确认 | <https://github.com/letta-ai/letta-code> |
| Hermes Agent | 自我调度/自动工具 | Cron、Skills、记忆、子任务；自主 Cron 需审查默认权限（如 `cron.allow_agent_scheduling`） | <https://github.com/NousResearch/hermes-agent> |
| LangGraph + Temporal | 商用可控执行 | Checkpoint、Interrupt/Resume、Durable Workflow、Timer/Signal；需要自建完整产品 | <https://github.com/langchain-ai/langgraph> / <https://temporal.io/> |
| Browser Use | 浏览器智能 Loop | 自动导航和操作；不负责完整个人 Agent、凭据安全平台 | <https://github.com/browser-use/browser-use> |
| Skyvern | 商业网页流程 | 网页表单与工作流；完整个人记忆/Goal 仍需外接 | <https://github.com/Skyvern-AI/skyvern> |
| Agent Zero | Shell/Code 自治 | 动态工具/子 Agent/浏览器与 Docker；隔离和生产安全需加强 | <https://github.com/agent0ai/agent-zero> |
| Kortix（原 Suna） | 云端 Agent Sandbox 与任务 | 完整度高，Elastic License 2.0 存商业托管限制，非通常意义 OSI 开源 | <https://github.com/kortix-ai/suna> |

**选型校正**：Letta 更积极的“跨时间工作必须主动安排未来唤醒”的 System Prompt，不足以说明其底层 Runtime 必然优于 OpenClaw。必须在同模型/近似 Prompt/相同工具权限下评价 30 天的 Goal 维护、恢复成功率、调度正确性和成本。OpenClaw 更强在已现成可用的个人助手工具生态；Letta 更值得深挖记忆与持久 Agent 身份；商用长期执行需要单独考虑 Temporal 一类工作流基础设施。

### 15.2 新出现的 OpenMuse/OpenDots 同名项目

| 仓库 | 方向 | 关键边界 |
|---|---|---|
| **CopilotKit/OpenMuse** | Expo iOS/Android/Web + AG-UI + Durable Task + Browser + Computer + Goals/Ideas | **优先研究对象**，Alpha，Adaptive Goal Planning/自动付款仍不足 |
| **CopilotKit/OpenDots** | 多个 Dot/Coworker + Spaces/Pages + Slack/语音/Computer | 多 Dot 自主协作能力与部署仍需核查；Intelligence 许可依赖 |
| **nano-muse/nanoMuse**（原 OpenMuseAgent/OpenMuse） | Phone/PC/Cloud/Relay，Android proot，MCP/Skills，Markdown Goal/Memory | 跨设备 Agent 值得参考，非 Meta 云 VM 直接复刻 |
| **diggerhq/opendots** | Coordinator + Topic Worker + OpenComputer Serverless Agents | 清晰任务/Topic 会话隔离，依赖 OpenComputer 平台 |
| **Anil-matcha/open-dots** | 编程/沙箱/Telegram/Web/定时/审批 | 较偏代码执行场景 |
| **tahodev/openmuse** | 一次性审批 Token、HMAC 审计、凭据隔离 | 更适合研究 Sentinel/Authd 的部分安全思想 |

地址：
- <https://github.com/CopilotKit/OpenMuse>
- <https://github.com/CopilotKit/OpenDots>
- <https://github.com/nano-muse/nanoMuse>
- <https://github.com/OpenMuseAgent/OpenMuse>（旧版）
- <https://github.com/diggerhq/opendots>
- <https://github.com/Anil-matcha/open-dots>
- <https://github.com/tahodev/openmuse>

同名项目不可混淆，Star 数是时间点快照，不能证明可靠性。OpenMuse/OpenDots 的 MIT 仓库不意味着 CopilotKit Intelligence、托管 Computer、模型调用等第三方运行能力也获得相同开源授权。CopilotKit/OpenDots 的托管/本地评估/许可自托管选项应以其当下文档确认。

### 15.3 推荐技术路线

1. **快速 Muse 原型**：OpenMuse（前端/任务/基础设施）+ Browser Use + 强化审批。
2. **长期自主研究**：Letta Code / OpenClaw 对比 + 独立 Goal Manager + Future Task Registry。
3. **商用控制与恢复**：自建 Orchestrator 或 LangGraph，Task/Workflow 交给 Temporal 或可靠的 DB 调度；独立 Permission Gateway、Credential Broker、安全 Sandbox。
4. **眼镜、手机、云端**：借鉴 nanoMuse 的 Relay/多设备执行，不要让云端自动拿到手机/眼镜全部个人信息。

---

## 16. CopilotKit/OpenMuse 源码级研究

### 16.1 项目现状与实际部署

[代码] 当前仓库为 Alpha。核心栈：**Expo/React Native + Web、CopilotKit/AG-UI、Hono API、TanStack AI Model Agent、PGlite/PostgreSQL、Playwright/Chromium Browser Worker、Docker Linux Computer（可选 E2B Desktop 后端）**。主要面向单 Owner。Render 示例是 API + Static Web + 私有 Browser 三服务。Rich Threads 依赖 CopilotKit Intelligence 项目密钥，属于独立服务和条款；模型、Google OAuth、外部 Computer 能力按需要配置。README 和 SECURITY/Computer 文档对图形桌面当前状态的表述可能版本不一致：**以已配置且通过实际测试的版本为准**，不能因某个安全文档列出 E2B 选项就视为所有发行配置默认提供完备 Desktop。

### 16.2 两条 Agent 执行路径

```mermaid
flowchart TD
 UI[Expo/Web 客户端] --> API[Hono API + CopilotRuntime]
 API --> CA[ConversationAgent 交互式 Loop]
 CA -->|delegate_task| SERVICE[AgentService]
 SERVICE --> DB[(records / Task State)]
 WORKER[TaskWorker] <--> DB
 WORKER --> MODEL[executeModelTask: 后台模型 Loop]
 MODEL --> TOOLS[Browser/Computer/Gmail/Calendar/Artifacts]
 CA --> TOOLS
```

- **ConversationAgent** 接主聊天和工具，可调用 `delegate_task`、`create_goal`、`watch_page`、`agent_status`、`remember_fact`、`browse_web`、`search_web` 等。
- **TaskWorker** 领取持久化 Task，调 `executeModelTask` 建一个新的 TanStack AI Loop；任务的状态/Checkpoint 持久化，模型上下文不等于永续存活。
- **Agent Backend** 存在 `sample`、`model`、`agui`，外部 AG-UI Runtime 适配可替换交互式后端；**后台 Model Task 的执行器不能因此自动同步替换**。

### 16.3 Task Worker 机制

先前源码审查时观察到的默认参数：扫描约 **1s**、本机最大并发 **3**、Lease **60s**、续期 **20s**、数据库 CAS 领取、`AbortController` 取消、持久 Run Events/Checkpoint、Lease Fencing。后台模型任务示例 `maxSteps:16`、单次运行超时约 **5 分钟**。这些数值属于那次检视时的源码配置，可能随 commit 更新，不能当成产品不变的 SLA。

Task 典型状态：`QUEUED/RUNNING/WAITING_INPUT/WAITING_APPROVAL/SCHEDULED/SUCCEEDED/FAILED/CANCELLED/PAUSED`。数据库有 JSONB `records(owner,kind,id,data,updated_at)`，Task/Goal/Ideas/Monitor/Memory/Action 等以 `kind` 区分。优点是 Alpha 快速扩展，缺点是正式外键、跨对象一致性、复杂查询和多租户性能需要增强。

### 16.4 Goals / Monitor / Ideas 的真实程度

已见 Goal 类型含 `id/title/description/category/status/milestones/createdAt` 等。**缺少成熟的 Goal 成功准则、Trigger Registry、Task DAG、预算与自适应 Replanner**。Ideas 由邮件特定关键词/Goal 状态等规则生成，通过去重/刷新周期决定建议，尚非完整 LLM Goal Reasoner。`Monitor.condition` 可为 `change`、`contains`、`price_below`，有 `intervalMinutes`、`nextCheckAt`、页面基线、Hash、去重、退避及失败暂停。价格从 `$`/`USD` 文本提取的策略脆弱，非稳定商品结构化价格源。

### 16.5 Browser Worker 与 Browser Sub-Agent 的明确边界

OpenMuse `apps/worker` 的 Playwright Service 提供 `/sessions`、`navigate`、`read`、`screenshot`、`input` 等受控 API。Browser Worker 是**网页执行服务**，不代表其自身含专用多轮 LLM Browser Loop；OpenMuse Agent 模型调用当前可能只通过部分工具读取公共网页，用户可以 Take Control。此前代码审查提到最大活跃会话约 3、持久 Profile 约 20、空闲回收约 30 分钟、端口默认 8790、`WORKER_TOKEN`。文档同时说明对公共 HTTP(S)、IP/DNS 有基础校验，不是 Meta 等级的恶意多租户隔离。

### 16.6 Computer 双后端与 E2B 风险

- Docker Computer：非 Root、只读根文件系统、受限命令、持久 Volume、终端默认禁网，适合文件/Python/PDF/CSV。
- 可选 E2B Desktop：图形桌面、截图与键鼠动作，但其 Linux VM 可直接联网、用户可能有 sudo；网络流量**不自动被 OpenMuse ActionService 审批**。SECURITY 文档提醒公开的桌面流及端口可能被访问，桌面访问 URL 必须视为敏感凭据。这里的模型 Loop 是上层 `executeModelTask`，不等价于专用 Browser Sub-Agent。

### 16.7 ActionService：成熟且值得复用

当前审查覆盖 `email.send`、`calendar.create/update/delete` 等结构化外部写入；流程：Schema 验证、账号/版本绑定、待审内容 Hash、有限审批有效期（先前观察约 30 分钟）、`awaiting_review`、用户批准、原子领取执行权、Connector 调用、`succeeded/failed/outcome_unknown` 回执。用户拒绝不执行；已外发但超时的调用不能盲重试。**并未覆盖任意 Shell/E2B 浏览器外发及购物支付**。

### 16.8 OpenMuse Memory 的当前差距

`AgentMemory` 曾见简化定义 `id/text/source/createdAt`，`remember_fact` 写普通 JSONB Record，后台 Run 序列化注入 Prompt；尚未看到对标 Muse 的 `entries + embeddings + claims`、来源多对多、Hybrid Retrieval、Dream/自动 Claim Audit 完整链路。可保留 API/UI，重做 Memory Service。

### 16.9 其他值得保留的功能

- PDF 学校许可表：邮件→读附件/填 PDF→用户补充→准备邮件→ActionService 审核→发出回执。
- Finance：CSV → 消费分类/汇总与交互表。
- AG-UI：消息/工具流/富结果卡/Activity/Approval。
- Optional Jev：官方水族馆 Field Trip 演示中 Typesafe Jev 负责受限选项决策，另一段 Agent 行为为脚本化以保证可重复性；**这不是证明 Jev 已替代整个 Agent Loop**。
- Telemetry：CopilotKit SDK 可能默认向 PostHog 汇报运行数据；真实私人数据部署必须查看关闭/采样配置和 CopilotKit Intelligence 数据条款。

### 16.10 推荐源码阅读入口

| 顺序 | 文件 | 关键问题 |
|---|---|---|
| 1 | `apps/server/src/agent.ts` | Backend 模式、AG-UI 接口 |
| 2 | `apps/server/src/engine/conversation.ts` | 主对话 Loop、工具注册 |
| 3 | `apps/server/src/engine/model.ts` | 后台 Agent Loop、工具、步骤上限 |
| 4 | `apps/server/src/engine/worker.ts` | Lease、Checkpoint、重试和恢复 |
| 5 | `apps/server/src/engine/service.ts` | Goal/Monitor/Ideas/Tasks |
| 6 | `apps/server/src/db.ts` | JSONB、CAS 和持久化 |
| 7 | `apps/server/src/actions.ts` | 审批、Hash、Account 绑定、回执 |
| 8 | `apps/worker/src/browser.ts` | Chromium/Playwright Session/动作 |
| 9 | `apps/server/src/computer-tools.ts` | Docker/E2B 执行 |
| 10 | `packages/domain/src/agent.ts` | 类型合同 |
| 11 | `ROADMAP.md`、`SECURITY.md`、`docs/COMPUTER.md` | 缺项、边界和部署风险 |

源码基准仓库：<https://github.com/CopilotKit/OpenMuse>。复现时应先锁定 Git Commit/Tag 再跑验收，以免今天查到的参数随 main 分支改变。

### 16.11 最小运行与依赖

当前 README 的基线：Node.js 24 LTS，pnpm 11.19.0，CopilotKit Intelligence 项目密钥，Sample 模式可不用模型、Google 或 Docker。

```bash
git clone https://github.com/CopilotKit/OpenMuse.git openmuse
cd openmuse
pnpm install --frozen-lockfile
cp .env.example .env
npx copilotkit@latest login
npx copilotkit@latest project select
# .env: CPK_INTELLIGENCE_API_KEY=...
pnpm dev
# 新终端
pnpm dev:web
```

Web 默认 `http://localhost:8081`，API 健康检查默认 `http://localhost:8787/api/health`。真实模型需要 `AGENT_BACKEND=model`、`MODEL` 与对应 Provider Key；Browser Worker 需要 Playwright Chromium 安装、`WORKER_TOKEN`；不同进程共享 DB 时用 PostgreSQL，不能多个进程同时打开同一 PGlite 实例。Host 必须维持运行才能处理后台任务。安全做法：先 Sample/虚构邮箱/本地沙箱，后再连接真实账号。

---

## 17. 尚未解决的技术问题、风险和下一步研究

### 17.1 完整的 12 项工程研究地图

| 优先级 | 技术主题 | 核心问题 |
|---|---|---|
| P0 | Durable Agent Execution | 断网/重启/重复 Tool Call 如何恢复且不重复付款？ |
| P0 | Event Bus 与 Task 状态一致性 | 用户改变预算时，旧 Worker/子 Agent 如何不覆盖新版约束？ |
| P0 | Capability Security | 不能依赖 Prompt 允许操作，权限如何强制落到 Tool/凭据/网络层？ |
| P0 | Browser Session/身份连续性 | Cookie、2FA、Passkey、接管、登录风控如何处理？ |
| P0 | Context/Memory Integrity | 如何防止错误事实、来源混乱、网页注入长期记忆？ |
| P1 | Goal-driven Proactivity | 怎样从目标和事件自行创建/修订/取消未来任务？ |
| P1 | Model Routing/Inference | Router/分类小模型与主规划 LLM 如何分工、控成本？ |
| P1 | Dynamic Skill Lifecycle | 工具生成后如何测、审、登记、升级、撤销？ |
| P1 | Artifact Runtime | 如何生成隔离的动态网页/Dashboard 而不污染主 App？ |
| P1 | Observability & Replay | 为什么行动、哪条证据、哪个审批、如何回放？ |
| P1 | Computer Lifecycle & Cost | VM/浏览器高资源占用，如何休眠/唤醒/配额？ |
| P2 | Multi-device Context | 眼镜/手机/云端如何共享最少必要上下文与授权？ |

**强制测试项**还应覆盖：第三方账号撤权、不可确认的外部写入、任务订阅去重、Agent 自编代码能力隔离、Prompt Injection、跨用户数据访问、长时间价格/网页监控及错误通知。

### 17.2 对 Browser 与安全特别重要的失败模式

- Agent 从网页看到恶意“新系统指令”，不能把它当权限。
- Chromium 被网站要求使用 Passkey/验证码，用户接管期间 Agent 不准继续动作。
- 浏览器提交订单成功但响应丢失，不应再点一次付款。
- E2B 或 Agent 自写脚本可以联网，不代表 ActionService 能拦截所有发送；这需要更深层的网络 Capability Gateway。
- L4 阻断并不自动实现对加密 HTTP 正文的审核。
- Gateway/Agent 崩溃不能使已审批凭据变成永久可复用凭据。

### 17.3 经济和隐私议题

长期 VM、浏览器和多 Agent token 成本可高；需区分免费产品的补贴与可持续 SaaS 成本。用户控制数据、训练退出、敏感记忆与第三方非用户档案、商业推荐是否公平、生成工具/动态代码的供应链风险、日志保留与用户删除范围等，都是系统设计问题。不可把“独立 VM”理解成运营方对数据在技术上绝对零访问。

### 17.4 推荐研究顺序与选择

- **OpenMuse 优先**：完整产品 UI/AG-UI、Durable Task、Browser Worker、ActionService。作为产品底座，而非不可替换的 Agent 内核。
- **Letta/ OpenClaw 并行对照**：Prompt 约束之外的跨时间身份、Memory、Future Tasks、工具生态。
- **第一阶段补齐**：Conversation Router + Task Context Builder + 事件/状态一致性。
- **第二阶段**：Goal Replanner + Future Task Registry + Memory Claims。
- **第三阶段**：独立 Browser Agent、Credential Broker、Permission/Egress Gateway。
- **第四阶段**：多用户、VM 生命周期、眼镜/手机本地与云端路由、完整可重复测试。

---

## 18. 技术术语速查

| 英文术语 | 中文建议 | 重要区别 |
|---|---|---|
| Personal Agent | 长期个人智能体 | 超越单轮聊天 |
| Hatch / Agent Harness | 主 Agent 运行时 | 协调 Loop/Tools/Sub-Agents |
| Goal | 长期目标 | 不等于一次性 Task |
| Task / Run | 任务 / 单次执行 | Task 可跨越多个 Run |
| Main Conversation | 主对话 | 用户长期入口，不等于 Task Context |
| Task Conversation | 任务对话 | 不自动继承主对话全部历史 |
| Context Window | 模型当前上下文窗口 | 有 Token 上限，按需构造 |
| Compaction | 上下文压缩 | 与长期 Memory 不同 |
| Sub-Agent | 子代理 | 与无推理的 Tool Worker 不同 |
| Browser Broker | 浏览器操作代理 | 隔离高权限 CDP |
| Accessibility Tree | 无障碍语义树 | 非 raw DOM/截图 |
| Authd | 凭据管理服务 | 受保护、非 Agent 可编辑 |
| Privsep | 特权分离 Worker | 独立可信服务域 |
| Sentinel | 独立权限审查代理 | Tool/网络出口授权，不是普通 Prompt |
| Tainted Egress | 污染状态驱动的出口控制 | 读取私密数据后收紧自动放行 |
| Surrogate Token | 代理替身凭据 | 不是外部服务真实 Token |
| Approval / Capability | 审批 / 可行使能力 | 应绑定参数、时间、对象、次数 |
| Lease / Fencing | 租约 / 所有权防护 | 防止旧 Worker 越权写回 |
| Idempotency | 幂等 | 多次重试不产生重复副作用（需外部配合） |
| OUTCOME_UNKNOWN | 结果不确定 | 必须对账，而非无脑重试 |
| Claim | 可追溯事实主张 | 不必然是真理，不等于 Entry |
| Entry / Embedding | 文本片段 / 向量索引 | 值与索引分离 |
| Dream / Reflection | 后台反思整理 | 非每用户模型权重训练 |
| AG-UI | Agent 与 UI 事件协议 | 流式消息、工具状态等 |
| Jev | 受约束决策机制 | 在 OpenMuse 演示中不是整个 Agent Loop |
| PGlite / PostgreSQL | 内嵌/服务端关系库 | 多进程 Worker 建议共享 PG |
| systemd-nspawn | Linux 容器运行器 | 不等同独立 Linux VM |

---

## 19. 参考资料、证据索引和问题覆盖表

### 19.1 主要官方资料

1. Meta 产品介绍：<https://about.fb.com/news/2026/09/introducing-muse-personal-ai-agent>
2. Meta 安全架构（Secure VM / Hatch / Browser / Sentinel / Authd / Privsep）：<https://research.meta.ai/blog/security-and-safety-for-ai-agents-our-approach-with-muse>
3. Muse 设计与真实案例：<https://introducing.muse.ai/>
4. Muse 产品：<https://ai.meta.com/muse/>
5. Muse Spark Computer Use：<https://dev.meta.ai/docs/computer-use>
6. Muse 数据管理：<https://www.meta.com/help/artificial-intelligence/2225571704857152/>
7. OpenAI dots：<https://openai.com/index/introducing-dots/>
8. OpenAI dots 用户指南：<https://help.openai.com/en/articles/20001530-getting-started-with-your-dot>
9. OpenAI dots 安全/隐私：<https://openai.com/index/how-we-build-safety-security-and-privacy-into-dots/>
10. Muse Code：<https://research.meta.ai/blog/introducing-muse-code-and-muse-spark-1-2>
11. Muse for Small Business：<https://about.fb.com/news/2026/09/introducing-muse-small-business/>

### 19.2 第三方逆向与开源仓库

12. Rohan Adwankar 的 VM/Memory 分析：<https://rohanadwankar.github.io/posts/sandbox2.html>
13. Peter James 的 Muse Runtime Export：<https://mouse.dev/blog/muse-runtime-export>
14. OpenMuse：<https://github.com/CopilotKit/OpenMuse>；[ROADMAP](https://github.com/CopilotKit/OpenMuse/blob/main/ROADMAP.md)、[SECURITY](https://github.com/CopilotKit/OpenMuse/blob/main/SECURITY.md)
15. CopilotKit OpenDots：<https://github.com/CopilotKit/OpenDots>
16. nanoMuse：<https://github.com/nano-muse/nanoMuse>
17. diggerhq OpenDots：<https://github.com/diggerhq/opendots>
18. Letta Code：<https://github.com/letta-ai/letta-code>
19. OpenClaw：<https://github.com/openclaw/openclaw>
20. Hermes Agent：<https://github.com/NousResearch/hermes-agent>
21. Agent Zero：<https://github.com/agent0ai/agent-zero>
22. Browser Use：<https://github.com/browser-use/browser-use>
23. Skyvern：<https://github.com/Skyvern-AI/skyvern>
24. Kortix：<https://github.com/kortix-ai/suna>
25. LangGraph：<https://github.com/langchain-ai/langgraph>
26. Temporal：<https://temporal.io/>
27. tahodev/openmuse：<https://github.com/tahodev/openmuse>
28. Anil-matcha/open-dots：<https://github.com/Anil-matcha/open-dots>

### 19.3 本次讨论主题逐项覆盖

| 历次问题 | 主要文档位置 |
|---|---|
| 等候名单多久开放、邮件/地区状态、改 Region | §1.4 |
| Muse 是什么、用户流程、Main/Goals/Ideas | §1–2 |
| 官方案例：开学/旅行/关系/购物/企业/眼镜 | §3 |
| 购物案例具体展开、云端付款、网站账号登录 | §4–5 |
| 完整购物时序（手机、Agent、Broker、网站、Authd、Sentinel、支付） | §4.3 |
| Browser Agent 是否独立 Loop、Accessibility/CDP/Computer Use | §7–8 |
| 云端有哪些 Sub-Agent | §6–7 |
| Hatch 含义与 Harness | §6.3 |
| 账号安全、HTTPS、Credential Surrogation、LSM | §10 |
| Linux 需要改内核吗 | §14 |
| dot 与 Muse 的差异 | §13.1 |
| 主动任务、Goal 自动创建 Future Task、Prompt 是否是关键 | §12 |
| OpenClaw 与 Letta 谁更适合自治 | §12.3、§15 |
| Muse Memory、三表 Schema、Hybrid Search、Dream、Forget | §11 |
| OpenMuse/OpenDots 候选项目 | §15 |
| OpenMuse 深入源代码分析 | §16 |
| dots 主对话/Task Session/Context Window 切分 | §13.2 |
| Conversation Router 具体设计 | §13.3；配套架构文档 |
| 其他易忽略技术：状态、安全、事件、成本、眼镜 | §17；配套架构文档 |

---

**总体结论**：复原 Muse 类 Personal Agent 应把“长期关系/主聊天入口”与“可恢复的独立 Task/Run”、把“模型自主决策”与“强制可信执行”、把“记忆内容”与“事实证据/检索索引”、把“长期 Goal”与“Future Task/Trigger”分开。OpenMuse 是较好的产品与 Task Runtime 底座，但完整的 Goal 自主闭环、Memory Claim 体系、Browser Sub-Agent、安全出口控制、多用户执行环境仍需明确开发。

> **对应实现方案**：参见《复原的技术架构设计文档.md》。


---

## 20. 2026-10-26 追加研究：Personal Agent 的最新产品、模型、开源与架构趋势

> **增量性质**：此章对截至 2026-10-11 的章节作时间更新，不覆盖旧版的购物案例、Hatch、安全、Memory 三表、Router 和 OpenMuse 源码解析。`[官方]` 是厂商正式材料；`[代码]` 是公开仓库文档/代码；`[研究判断]` 是我们对复现的推论。

### 20.1 关键进展时间线（2026 年 10 月）

| 时间 | 项目 | 已核实事实 | 不能据此推断 |
|---|---|---|---|
| 10/12 | Meta Muse Wonder / Wonder Full | 面向个人及职业 Agent 的新模型；Wonder 经 Model API / Muse Code 提供，Wonder Full 面向 Muse Code 订阅者 | 消费者 Muse App 已全面切换新模型 |
| 10/13 前后 | OpenAI dots | 官方帮助文档现支持在 iOS/Android 内直接创建 dot，管理 Scheduled Tasks；跨应用与本地/云计算机协作 | 主会话内部 Router、压缩算法已开源 |
| 10/14 | Anthropic Claude Platform | 宣布 Managed Agents / Messages API / SDK 的 OpenTelemetry 导出 | 一定等同于 Claude Duet 内部事件结构 |
| 10/15 | Meta Muse Spark Open | 开放权重，MoE 816B 总参数、42B 激活、1M Context，多模态输入、文本输出 | 816B 等于 42B 内存占用；无需强隔离就安全 |
| 10/21 | Anthropic Claude Duet | 美国 Pro / Max 用户 waitlist 研究预览，iOS/Android/Web 入口，Opus 5.5，主动早报与持续任务 | 已对全球开放、所有第三方网站均能自动化 |
| 10/22 | Anthropic Agent 设计建议 | 过多子 Agent 可能导致上下文损失和时延；提倡 Skills / Tools 渐进披露、按测量结果拆分 | 所有复杂 Agent 都应收敛成一个 Loop |
| 10/23 | Anthropic Duet 安全披露 | 独立审查、敏感信息分类、云端凭据隔离、逐笔审批及受约束的一次性付款卡 | 其机制完全复制 Meta Sentinel 内部实现 |
| 10/21–26 | nanoMuse / OpenDots / OpenMuse | nanoMuse 公布 2k Stars 和跨设备迭代；OpenDots 文档列出 Learning / OpenBot；OpenMuse 当前仍为 Alpha | OpenMuse 已经有自动购物/生产级多租户/完整 Goal Replanner |

来源： [Meta Muse Wonder](https://research.meta.ai/blog/muse-wonder)、[Muse Spark Open](https://research.meta.ai/blog/muse-spark-open)、[dot 帮助中心](https://help.openai.com/en/articles/20001530-getting-started-with-your-dot)、[Duet 发布](https://claude.com/resources/articles/claude-duet)、[Duet 安全](https://claude.com/resources/articles/claude-duet-safety-privacy-and-security)、[Agent Loop 设计经验](https://claude.com/resources/articles/building-agents-when-to-fold-subagents-into-your-main-agent-loop)、[nanoMuse](https://github.com/nano-muse/nanoMuse)、[OpenDots](https://github.com/CopilotKit/OpenDots)、[OpenMuse Roadmap](https://github.com/CopilotKit/OpenMuse/blob/main/ROADMAP.md)。

### 20.2 Muse Wonder：Active Memory 与 Active Focus 是什么

[官方] 10 月 12 日 Meta 发布 **Muse Wonder** 与 **Muse Wonder Full**。官方将能力总结为：领域知识（法律、财务、健康）、Active Memory、Active Focus、前沿代码能力。发布时 Muse Wonder 通过 Meta Model API 与 Muse Code 提供，Wonder Full 通过 Muse Code 订阅提供；对消费者 Muse App 的表述是**即将推出，订阅用户优先**，不应写成“所有 Muse 用户已升级”。

**Active Memory**：跨对话携带重要背景，并在当前任务相关时主动检索。它回答“模型能否识别现在应该调出哪段历史”这个问题。**尚不能推出** Muse 的 `entries/embeddings/claims` 三表、Dream 频率或事实合并算法随之更改；这些是持久数据层，模型能力与存储体系应分开评价。

**Active Focus**：在目标长期推进中遇到障碍时尝试替代路径，适应新信息，必要时澄清，并在重要行为前确认。它回答“模型能否持续推进困难任务”这个问题，但并不自动提供 durable state、Crash Recovery、Scheduler、Action Idempotency。官方提及 **FocusBench** 和 **SWE-Marathon** 作为相关能力评估方向；分数是厂商测试，不是对特定个人 Agent 工作流的上线保证。

官方演示增补：理解保险理赔问题、理解租约、设计可运行应用，结合个人 Instagram 照片设计并订购定制纪念品，依约束安排婚宴席位等。上述属于产品与模型展示，不能替代真实账户、付款、权限审查的业务验收。

**架构结论**：`Memory Store`（保存事实）→ `Context Builder/Retriever`（选出上下文）→ `Wonder-style Model`（使用上下文持续推理）→ `Durable Task Runtime`（保障跨时间执行）是四层不同的责任。不应让 Active Memory 或 Active Focus 成为删除这四层的理由。

### 20.3 Muse Spark Open：开源模型的真正价值和部署边界

[官方] 10 月 15 日 Meta 发布 **Muse Spark Open** 权重（注意应称 *open-weight*，并非 Apache/MIT 许可证的完整开源软件）。主要参数：

| 项 | 公布值 | 工程含义 |
|---|---|---|
| 模型 | 816B 总参数、约 42B/Token 激活 | 稀疏 MoE；计算激活量较小不等于完整权重可不加载 |
| 上下文 | 1,048,576 Tokens | 提供大窗口，但上下文长不意味着单轮任务状态持久或费用低 |
| 模态 | 文本、图片、音频、视频输入；文本输出 | 可作为云端多模态任务引擎 |
| BF16 Checkpoint | 约 1.65 TB | 官方示例 8×B300、显存另需预留 KV 与运行开销 |
| NVFP4 Checkpoint | 约 537 GB | 官方示例 4×B300 Blackwell，或特定多 Mac Studio 联合部署 |
| Runtime | vLLM、SGLang、MLX、TensorRT-LLM、Transformers 等 | 可通过模型适配层替换推理服务 |
| 授权 | Muse Model License + Acceptable Use Policy | 商业部署应单独核查条款；不能按 Apache 2.0 理解 |

官方文档提到两台 512GB 统一内存 M5 Ultra Mac Studio 的 MLX 配置；但这不等于普通 PC、手机或智能眼镜可直接加载模型，也不能根据“42B 激活”推断只需容纳 42B 权重。模型推理部署、Token/带宽成本、批处理策略都需做专项测算。来源：[规格与硬件](https://dev.meta.ai/docs/muse-spark-open)、[构建指南](https://dev.meta.ai/resources/blog/build-with-muse-spark-open)、[官方发布](https://research.meta.ai/blog/muse-spark-open)。

作为边缘/本地研究对照，Meta 此前的 **Muse Glimmer（30B，Apache 2.0）** 更适合在 24–32GB 级消费级 GPU/高内存 Mac/PC 上运行；官方描述约 4-bit 量化模型可将语言权重缩至 20GB 以下，并配合草稿模型做推测解码。**Glimmer 也不是能直接塞进眼镜芯片的轻量模型**。对眼镜/手机应继续采用小型感知模型与意图模型，将复杂推理路由至手机高性能设备或云端。来源：[Muse Glimmer](https://research.meta.ai/blog/introducing-muse-glimmer-open-agentic-model)。

### 20.4 第三位重量级竞品：Claude Duet

[官方] Anthropic 在 10 月 21 日发布 Claude Duet，10 月 23 日发布独立安全设计文档。它是面向专业人员/小企业主的 proactive agent，基于 **Claude Opus 5.5**，研究预览首先开放给**美国 Claude Pro / Max** 等候名单。通过独立移动 App 和 claude.ai 访问；后台检查消耗现有 Claude 用量，并不构成独立无限量套餐。产品公开宣称拥有 **6,000+ Connectors / Plugins**（应按厂商对生态的统计口径理解）。

**典型 UX**：早晨跨应用生成简报；白天低频检查相关事项，仅在值得关注时提示；用户可交付会议安排、催收/发票、合同、仪表盘、预测与原型开发任务；单条长期主对话承载交互。部分内部用户案例包括在日程中发现看房预约日期错误、交付晚间任务成果等。[来源](https://claude.com/resources/articles/claude-duet)。

**Duet 安全机制**的重要增量：

1. **双重外发检查**：独立于执行模型的安全分类器对准备发送的消息做敏感信息识别。最严格一档包括账号密码、完整卡号、政府证件号等；另一些私人信息（如健康、财务）需明确同意才共享。敏感信息过滤不等于自动准确的 DLP，仍需评估误报漏报。
2. **真实账号凭据隔离**：密码、Cookies、登录 Token 不进入主模型上下文；用户在 App 输入密码，由单次密钥加密至受保护的云端浏览器机器，再由浏览器注入网站。厂商提出将来支持 1Password，但不能把计划当已上线。
3. **独立操作审查**：外部分类器核对即将发生的动作是否符合用户意图；交易、发送敏感信息、删除操作需明确审批，一些行为即使用户批准也禁止（证券交易、转移银行资金、使用他人账号等）。
4. **付款方案**：通过 Link 等钱包生成商家、金额受限的一次性付款卡；用户在 Link 审批具体交易。**不要让 Agent 直接获得真实银行卡资料**。
5. **Anti-Prompt Injection / 网站识别**：声明特殊 User-Agent 与可公开的浏览器源 IP，以便网站判定是否接受该 Agent；这和模仿普通用户浏览器以躲避检测是不同策略。
6. **审批疲劳控制**：Duet 强调频繁审批会导致用户机械通过，必须在保证必要强制关口的同时减少无价值提示。

```mermaid
sequenceDiagram
    participant U as 用户
    participant A as Duet App
    participant L as 主 Agent
    participant G as Trusted Gate / Review
    participant V as Secure Cloud Browser
    participant W as Website / Link
    U->>A: 发起任务
    A->>L: 下发目标及授权上下文
    L->>V: 受控操作网站
    V->>W: 浏览与准备结账
    L->>G: 提交拟外发内容/高风险动作
    G->>G: 意图匹配 + 私密信息检查
    G-->>A: 展示明确操作/收件人/商家/金额
    U->>A: 审批或拒绝
    A-->>G: 可信审批回执
    G-->>V: 在批准范围内放行
    V->>W: 执行已批准动作
    W-->>L: 返回结果
```

*上图是公共功能逻辑的工程抽象，不代表 Anthropic 的 RPC 调用顺序。* 来源：[Claude Duet 安全白皮书](https://claude.com/resources/articles/claude-duet-safety-privacy-and-security)。

### 20.5 dots 的最近产品状态：重要使用路径已变化

[官方] OpenAI 的帮助中心现在写明：**iOS/Android ChatGPT App 可直接创建 dot**，Windows 桌面端可设置，移动网页不支持；Slack / 短信等消息渠道的连接需要桌面端配置。此前“dot 只能桌面创建”的描述属于发布早期状态，不应作为 10/26 的现行说明。

关于 Task/Conversation：官方仍明确表示**每个 Task 有独立 Conversation，并不会自动取得与 dot 的全部聊天记录**；Scheduled Tasks 可在 dot 活动页及 ChatGPT 的 Scheduled 页面查看、编辑、暂停等。dot 能在没有收到新消息时利用已连接应用做主动研究，但并不因此能越过原有 App、权限与 Auto-review 约束。云端 Computer 与本机 Computer 属不同执行资源；后者需用户单独授权，切换电脑**不会迁移已有 Task**。来源：[dot 使用帮助](https://help.openai.com/en/articles/20001530-getting-started-with-your-dot)、[dot 权限 FAQ](https://help.openai.com/en/articles/20001529-dots-privacy-security-and-safety-faqs)。

**内部实现边界仍未知**：主聊天真正的 Conversation Router、Context Compaction、Task Reattach 协议、子 Agent 数量和生命周期均未完全公开。不要把我们设计的 `Task Retrieval + Focus + RouteDecision` 记成 OpenAI 已确认算法。

### 20.6 OpenMuse 当前基线：功能演示与产品空白必须一起记录

截至 10/26，可从 [OpenMuse README](https://github.com/CopilotKit/OpenMuse)、[ROADMAP](https://github.com/CopilotKit/OpenMuse/blob/main/ROADMAP.md)、[COMPUTER](https://github.com/CopilotKit/OpenMuse/blob/main/docs/COMPUTER.md)、[SECURITY](https://github.com/CopilotKit/OpenMuse/blob/main/SECURITY.md) 核对的核心事实：

| 模块 | 已披露可用 | 尚未宣布完成或不能默认安全 |
|---|---|---|
| 交互 | Expo/Web、AG-UI、Rich Threads、活动、Goals/Ideas、基础记忆 | 不代表独立 Goal Replanner 已实现 |
| 持久任务 | TaskWorker、SQL Lease/Checkpoint、暂停/恢复/审批记录 | 必须做真实第三方写入的端到端结果核验 |
| 浏览器 | Playwright/Chromium Worker、页面阅读、截图、持久 Profile、人工接管 | 独立 Browser LLM Loop、全自动预订/付款仍非产品既有承诺 |
| Computer | Docker 无网络工作区；**可选 E2B Desktop** 有 `use_desktop` 图形操作 | E2B 的网络出口**不经过统一的强制审批**；公开端口/串流链接需视为敏感能力 |
| Google Connector | Gmail/Calendar OAuth Adapter、ActionService 审批 | 官方验证文件仍区分模拟测试与真实账户验收 |
| OpenBot | 已有 OpenBot HTTP 适配/桥接方向 | Roadmap 仍写“需验收”，不能把联通当作默认可用 |
| Goal | Goals、里程碑、Monitor、价格阈值检查 | Adaptive Long-term Plans 仍列 Product Extensions |
| 多用户 | 单 Owner / 访问密钥模式 | 不是恶意多租户环境下可直接使用的成熟隔离方案 |

**代码动态的证据纪律**：GitHub PR 页面可查到 10/20–22 日围绕 BoxCompute VM、补问保存及 OpenBot 的 PR，但“PR 已打开”与“已合入 main”是两回事。本次未取得足以逐条确认 **10/25–26 已合入的 Commit SHA** 的官方证据，因此不把“10/25–26 完成某项修复”记作已确认版本功能。上线前请锁定 commit SHA，核对合并状态、测试和实际运行结果。

**关于 E2B 看似矛盾的文档**：README 总览对交互式桌面的产品化支持较保守，而 `docs/COMPUTER.md` 详细描述可选 E2B Desktop 驱动。因此准确口径是“代码/配置提供可选 E2B Desktop 方案，但尚不等于生产级受控浏览器采购能力”，而不是简单写成不存在或完全成熟。特别是 E2B `use_desktop` 的截图-操作循环仍由 Model Task 驱动，不自动形成独立 Browser Sub-Agent。

### 20.7 OpenDots、OpenBot、nanoMuse 的增量研究

**CopilotKit/OpenDots** [代码/文档]：当前 README 更明确写出每个 Dot 的独立角色、权限、Spaces/Pages、与 OpenBot 连接的专属 Computer、WebRTC 语音、Slack Channel、每 Dot MCP/Composio 访问控制。新增/明确的 **Automatic Learning**：每 Dot 有 Learning 容器、对话证据路由与经过发布的 Skill 交付。但项目同时注明 **云端 Schedule、相关对话计数及已发布 Skill 的连通验证尚待完成**，其 Routines 是原会话上的周期性指令，**不是完整 Goal/Event Trigger 生命周期**；多 Dot 群聊、自动委派仍属后续扩展。CopilotKit Intelligence 的托管/本地版本、模型 Provider、Composio、Parallel Search 等引入不同的数据流和许可证依赖。来源：[OpenDots](https://github.com/CopilotKit/OpenDots)。

**CopilotKit/OpenBot** [代码/文档]：定位为可把计算机（Browser、Files、Shell）交给 AG-UI Agent 的独立执行组件，强调操作前判断、操作后记录；应单独作为 Computer 基础设施候选审查，不能把 OpenMuse 和 OpenDots 对它的集成视为完全相同。来源：[OpenBot](https://github.com/CopilotKit/OpenBot)。

**nanoMuse** [代码/文档]：10/9 宣布 1.0.0，10/21 README 记载 GitHub 2,000 Stars，并继续发布 1.0.x 系列；面向手机、桌面、Web 与可自托管 Relay 的多设备个人 Agent。它特别适合研究多端会话同步、不同设备上的 Hands/GUI、权限卡片与跨设备可见的任务状态；作者自述“1.0”的兼容性并不等于达到 Muse 安全基准。请对真正要接入的 Android/iOS、PC 和 Relay 逐版验收。来源：[nanoMuse README](https://github.com/nano-muse/nanoMuse)、[Releases](https://github.com/nano-muse/nanoMuse/releases)。

**Letta Code、OpenClaw 的更新原则**：这两者依旧是“状态化 Agent”与“可交付个人助手生态”的优先参考，但仅凭 Prompt 写了“必须自我唤醒”或有 Cron/Heartbeat，就不能得出长期 Goal 闭环已完备。真正要评测的是 `Goal→Future Task→Trigger→Resume→Replan→Cancel` 的正确率、权限撤销和失败恢复；项目实际实现以锁定版本的文档及源码为准。[Letta Code](https://github.com/letta-ai/letta-code)、[OpenClaw](https://github.com/openclaw/openclaw)。

### 20.8 重要架构趋势：Sub-Agent 并非越多越好

Anthropic 10 月 22 日发布的[工程实践文章](https://claude.com/resources/articles/building-agents-when-to-fold-subagents-into-your-main-agent-loop)提出：随着模型能力增强，“单个主 Agent + 渐进加载的 Skills/Tools”在部分企业任务上优于按部门/领域分割的庞大子 Agent 网络，原因包括上下文交接损失、更多 Token 与时延、冲突 Prompt、调试复杂度。其经验并不意味着 Browser / General Sub-Agent 失去价值。适合保持独立子 Agent 的情况包括**高并行需求、真正需要独立上下文、隔离权限、独立验证**。

建议在个人 Agent 上比较三组配置，而不是仅看架构图：

- **A**：单主循环 + 工具查询/Skills 逐步披露；
- **B**：Main Loop + 专用 Browser Sub-Agent + 通用 Task Workers；
- **C**：完全拆开的 Research/Coding/Data/Browser 专业子 Agent。

以相同测试集和权限边界评估任务完成率、事实正确性、越权率、平均/尾部时延、工具调用轮数、总成本及 Context Handoff 损失。固定安全服务（Approval、Credential、Network Gate）无论选哪种模型拓扑都必须独立。

### 20.9 Muse / dots / Duet / 开源底座：新增安全对比

| 维度 | Meta Muse | OpenAI dots | Claude Duet | OpenMuse Alpha |
|---|---|---|---|---|
| 执行环境 | 用户 Secure VM + 受控 Host Services | 独立云电脑，可选本机访问 | 独立云电脑及凭据机器 | 本地 Docker / 可选 E2B |
| 凭据处理 | Authd / Credential Surrogation | Secure Sign-in + 外部权限审查（内部细节未完全公布） | 单次密钥传密至浏览器；模型不见密码/Cookie/Token | API 端加密 Connector Token；E2B 另有风险 |
| 高风险审批 | Sentinel，付款专项审批 | Auto-review + 用户批准 | 独立分类器 + 用户批准 | ActionService 针对受管理 Connector 写入 |
| 外发隐私 DLP | Hatch Safety / Sentinel 的多层防线 | 安全监控 + Auto-review | 额外公开两档敏感内容检查 | 尚不能视为同等 DLP |
| 网络出口 | 官方公开强制代理/eBPF/LSM | 未公开完整低层拓扑 | 浏览器机器和模型环境隔离 | E2B 可直接出网，未统一强制审查 |
| 开发者可替换 | 核心官方闭源 | 官方闭源 | 官方闭源 | MIT 源码，外部服务有额外依赖 |

**不能根据披露细节更多就断言哪家安全“绝对更强”**；不同威胁模型、业务约束和实测才是可比依据。[Meta 安全](https://research.meta.ai/blog/security-and-safety-for-ai-agents-our-approach-with-muse)、[dots FAQ](https://help.openai.com/en/articles/20001529-dots-privacy-security-and-safety-faqs)、[Duet 安全](https://claude.com/resources/articles/claude-duet-safety-privacy-and-security)、[OpenMuse Security](https://github.com/CopilotKit/OpenMuse/blob/main/SECURITY.md)。

### 20.10 对原技术结论的正式修订（Errata）

| v1.0 的语境/容易误读的说法 | v1.1 更准确的口径 |
|---|---|
| “Meta 当前基础模型就是 Muse Spark 1.3” | 这是 10/11 消费端与基础架构讨论基线；10/12 已发布 Wonder，计划优先面向订阅用户升级 Muse；不能直接写已全量切换 |
| “只有 Muse / dots 两个主要竞品” | 10/21 起应将 Claude Duet 纳入直接竞品阵营 |
| “OpenMuse 已有完整云端 Browser Agent” | Browser Worker/Computer 工具 ≠ 独立 Browser LLM Loop，且真实付款不可绕过可信 Gate |
| “开源权重即可在设备上运行” | Spark Open 816B 需要大型部署硬件；Glimmer 30B 才可作为高性能 PC 边缘方案，二者均非眼镜端直接部署 |
| “长期 Focus 由更强模型自然解决” | Active Focus 的模型能力与持久任务、调度、幂等和权限仍是分开的设计问题 |
| “dot 只能从电脑端创建” | 官方帮助中心已允许 iOS/Android App 内创建 |
| “OpenMuse 的最新 PR 全部已在 main 生效” | 必须按 SHA 验证合并、Feature Flag 与真实服务验收；本轮不对 10/25–26 的 PR 合并做无证据声明 |

### 20.11 截至 10/26 的产品与工程方向判断

Personal Agent 的竞争已经从“谁有聊天机器人 + 工具调用”，转向五条并进的能力轴：

1. **主动关系维护**：适时、少打扰的主动通知/晨报，且独立于当前 Chat 的上下文长度。
2. **持久执行**：跨天任务、后台自动化、状态恢复、外部副作用对账。
3. **主动记忆与聚焦**：真正按当前任务抽取历史事实，处理冲突，遭遇障碍后调整策略。
4. **可信自主性**：凭据隔离、收件人与外发信息检查、不可绕过的审批/网络策略。
5. **计算环境可替换**：云电脑、Docker/VM、专属浏览器、可选本机执行；大模型与轻量模型按任务路由。

对“AI 眼镜 + Phone Host + Cloud Agent”项目，建议优先顺序仍是 `Task Runtime → Goal/Trigger → Memory/Context → Browser/Permission → Device Event Gateway`，但应新增三项：**模型层 ModelCapability/ContextPolicy 的显式适配；Duet 式外发隐私双层审查；单循环 vs 多子 Agent 的 A/B Evals**。

### 20.12 本轮新参考资料（官方优先）

- Meta Research, [Muse Wonder / Active Memory / Active Focus](https://research.meta.ai/blog/muse-wonder), 2026-10-12。
- Meta Research, [Muse Spark Open 发布](https://research.meta.ai/blog/muse-spark-open), 2026-10-15。
- Meta Model API, [Muse Spark Open 规格、Checkpoints、License](https://dev.meta.ai/docs/muse-spark-open), 2026-10。
- Meta Developer, [Build with Muse Spark Open](https://dev.meta.ai/resources/blog/build-with-muse-spark-open), 2026-10-15。
- Meta Research, [Muse Glimmer](https://research.meta.ai/blog/introducing-muse-glimmer-open-agentic-model), 2026-08-10；本轮补充核验。
- Anthropic, [Introducing Claude Duet](https://claude.com/resources/articles/claude-duet), 2026-10-21。
- Anthropic, [Claude Duet Safety, Privacy, and Security](https://claude.com/resources/articles/claude-duet-safety-privacy-and-security), 2026-10-23。
- Anthropic, [Building agents: When to fold subagents into your main agent loop](https://claude.com/resources/articles/building-agents-when-to-fold-subagents-into-your-main-agent-loop), 2026-10-22。
- Anthropic, [Agent observability with OpenTelemetry](https://claude.com/resources/articles/agent-observability-on-the-claude-platform), 2026-10-14。
- OpenAI, [Getting started with your dot](https://help.openai.com/en/articles/20001530-getting-started-with-your-dot), 检查日期 2026-10-26。
- OpenAI, [Dots privacy/security FAQ](https://help.openai.com/en/articles/20001529-dots-privacy-security-and-safety-faqs), 检查日期 2026-10-26。
- CopilotKit, [OpenMuse README](https://github.com/CopilotKit/OpenMuse)、[ROADMAP](https://github.com/CopilotKit/OpenMuse/blob/main/ROADMAP.md)、[Computer](https://github.com/CopilotKit/OpenMuse/blob/main/docs/COMPUTER.md)、[Security](https://github.com/CopilotKit/OpenMuse/blob/main/SECURITY.md)，检查日期 2026-10-26。
- CopilotKit, [OpenDots](https://github.com/CopilotKit/OpenDots)、[OpenBot](https://github.com/CopilotKit/OpenBot)，检查日期 2026-10-26。
- nanoMuse, [Repository](https://github.com/nano-muse/nanoMuse)、[Releases](https://github.com/nano-muse/nanoMuse/releases)，检查日期 2026-10-26。

### 20.13 仍未得到官方充分披露的关键问题

- Muse Wonder 在消费者 Muse App 内真正切换的用户范围、模型策略及版本；和其外部 `Memory Bank` 数据层关系。
- dots 的内部 Conversation Router、Context Compaction、任务重连与多模型路由具体实现。
- Claude Duet 的云端计算机任务状态协议、浏览器 Agent Loop、外发分类器阈值及其可复现评价数据。
- OpenMuse 最新特定 PR 的合并 SHA、真实外部账号与支付端到端验收、多租户身份与 Secure Browser Gateway 完整度。
- OpenDots Automatic Learning 的 Learning 容器如何进行证据治理、技能版本化与真实生产权限审查。

**版本结论**：2026 年 10 月，Muse / dots / Claude Duet 已形成相近产品方向；但“模型更强、支持长 Context、可以自主浏览网页”和“系统有完整长期自治、可审计安全与可靠状态恢复”仍然是不同的事情。复现的技术核心依旧是控制平面和可信执行平面的协作，而不是某个产品名或某条 System Prompt。

---


## 2026-10-31 增量修订：DeepSeek Super-Agent 对 Dot / Muse 复现的架构影响

> **修订类型**：经项目调研触发的非破坏性架构修订；保留本文件此前全部正文。此前与本章冲突的 Dot Control Plane 建议，以本章为准。**Codex Core → 桌面 Codex → 桌面 Dot → 手机/眼镜入口 → 正式登录及商业化（最后）**的路线不变。

### A. 结论与不变项

1. **不替换 Codex Core**：既有 Agent Loop、Thread、Turn、Tools、Sandbox、Compaction、Memory 和 App Server 仍是首选执行基础。DeepSeek Harness 作为隔离验证的可插拔替代 Executor，而不是生产主线强制依赖。
2. **升级 Dot Control Plane**：将原来的 `Conversation Router + Task Registry + Scheduler` 扩展为 `Source → Immutable Trigger → Evaluation/Admission → Mandate → Ticket → Assignment → Executor`，并加入 `Thread Subscription Registry`。
3. **保持两层不同的“Thread”**：`source_thread_ref` 指 GitHub Issue、PR、邮件线程或 Dot 主聊天的外部关联；`codex_thread_id` 指 Codex Agent 的执行上下文。两者绝不能混用。
4. **长任务不等于常驻 LLM**：Ticket 可 WAITING，相关事件命中 Subscription 才重新创建 Assignment；Codex Turn 的自动续接只负责一次执行窗口内的进展。
5. **安全边界不退化**：Mandate 记录来源、理由、范围和策略版本，实际写操作仍由 Permission Gateway 独立审批；密码、OAuth、付款、网络出口的强制限制不能只依赖 Prompt 或 Ticket 元数据。
6. **开发先后顺序不变**：桌面 Codex M1/M2 不引入此复杂度为阻塞依赖；M3 的单主聊天、M4 的主动任务优先集成，之后才扩展跨设备入口。

### B. 领域术语及旧模型映射

| 新概念 | 职责 | 旧模块的处理方式 | 边界 |
|---|---|---|---|
| Source | 事件源配置、身份和回调 | 扩充 Gateway/Connector | 不能默认为可信用户授权 |
| Trigger | 不可变的外部事件事实 | 统一 Message/Event 表，追加入库 | `(source_id, source_event_id)` 幂等 |
| Source Thread | 外部消息串/Issue/PR 关联 | Task Alias + Message Links | 不是 Codex Thread |
| Eval / Admission | 判断忽略/新建/关联/澄清 | 升级 Conversation Router | 本身不执行高风险工具 |
| Mandate | 任务可做之事的来源与范围 | 从 `autonomyPolicy` 独立出来 | 不替代实时 Policy Decision |
| Ticket | 长期稳定待办/工作目标 | 映射原 `Task`，迁移时保留 ID | 一个 Ticket 多个 Assignment |
| Assignment | 某次派工、租约和执行身份 | 分离原 `Run` 和 Agent 归属 | 过期租约必须 Fencing |
| Subscription | Ticket 对未来事件的确定性订阅 | 新增注册表 | 命中不自动扩大授权 |
| Executor Session | 实际 Agent 执行上下文 | Codex Thread + Turn/Run | 可替换、可恢复、可迁移 |

```mermaid
flowchart TD
  UI["Dot 唯一主聊天"] --> GW["Unified Source Gateway"]
  EXT["GitHub / 邮件 / 日历 / Timer / 眼镜"] --> GW
  GW --> LOG[("Immutable Trigger Log")]
  LOG --> SUB["Subscription Matcher"]
  SUB -->|命中| T[("Existing Ticket")]
  LOG --> EVAL["Eval / Admission + Conversation Router"]
  EVAL -->|新建或归属| T
  EVAL -->|无关| SKIP["记录忽略原因"]
  T --> M["Mandate / Policy Snapshot"]
  T --> AS["Assignment + Lease + Fencing"]
  AS --> EX["Executor Router"]
  EX --> CX["Codex Core / App Server"]
  EX -.-> DSH["DSH Harness 实验适配器"]
  CX --> SEC["Independent Permission Gateway"]
  DSH --> SEC
  SEC --> TOOLS["Browser / Computer / Connectors"]
  TOOLS --> LOG
```

### C. 必须遵守的业务不变量

- **ID 不变量**：`message_id`（原始输入）、`trigger_id`（规范化事件）、`ticket_id`（原 Task）、`assignment_id`（派工）、`codex_thread_id`（执行上下文）各自唯一且不互相替代；一条用户消息只保存一份原文，通过关联表可以影响多个 Ticket。
- **幂等**：外部 Source 的重复回调不应产生第二个 Trigger 或第二次不可逆外部写入；索引 `UNIQUE(source_id,source_event_id)` 并配合 Action Receipt 和外部 Idempotency Key（如支持）。
- **并发**：同一个 Ticket 的可写 Assignment 需要乐观版本、Lease、Fencing Token；过期 Worker 不能继续提交 Checkpoint。外部已发送但结果不明确的 Action 进入 `OUTCOME_UNKNOWN`，禁止盲目重试。
- **安全**：只能从显式可审计来源建立 Mandate，推断/长期授权需限制在低风险行动；审批凭据绑定 Action 参数哈希、任务版本、一次性使用/到期时间、操作身份和目标商家或服务。
- **Event Subscription**：准确匹配来源及远端线程后，优先直接路由到已订阅 Ticket；只有未命中时才进入语义检索和轻量 Eval。多目标匹配可路由多 Ticket，但不得静默共享私有上下文。
- **撤销**：用户取消 Goal/Task 或撤销权限时，Subscription、Future Trigger、未开始 Assignment 和未消费授权同时失效；已经外发的行为记录结果，不宣称能够撤回。
- **保留 Task Context**：Codex Thread 可 Compaction 或 Rollover，但 Ticket State、Evidence、授权范围、待补问和事件订阅不应被清空。

### D. 核心接口合同（TypeScript 示例：本项目新设计）

```typescript
type Admission =
  | { kind: 'ignore'; reasonCode: string }
  | { kind: 'create'; goalId?: string; mandateRequest: MandateRequest }
  | { kind: 'route'; ticketIds: string[] }
  | { kind: 'clarify'; candidateTicketIds: string[]; question: string };

interface IncomingTrigger {
  triggerId: string; sourceId: string; sourceEventId: string;
  sourceThreadRef?: string; actorRef?: string;
  occurredAt: string; receivedAt: string;
  payloadRef: string; payloadSha256: string;
}
interface MandateRequest {
  originTriggerId: string; policyVersion: string;
  grantedBy: 'user'|'system-policy';
  allowedCapabilities: string[];
  expiresAt?: string;
}
interface TicketAssignment {
  ticketId: string; assignmentId: string;
  executor: 'codex'|'dsh-experimental';
  executionThreadId?: string;
  ticketVersion: number; leaseToken: string;
  leaseExpiresAt: string;
}
interface ThreadSubscription {
  subscriptionId: string; ticketId: string;
  sourceId: string; sourceThreadRef: string;
  eventTypes: string[]; active: boolean;
}
```

### E. 建议的数据库迁移（SQLite 原型；非官方 Schema）

```sql
CREATE TABLE IF NOT EXISTS agent_triggers (
  trigger_id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  source_event_id TEXT NOT NULL,
  source_thread_ref TEXT,
  occurred_at TEXT NOT NULL,
  payload_ref TEXT NOT NULL,
  payload_sha256 TEXT NOT NULL,
  UNIQUE(source_id,source_event_id)
);
CREATE TABLE IF NOT EXISTS agent_mandates (
  mandate_id TEXT PRIMARY KEY,
  ticket_id TEXT NOT NULL,
  origin_trigger_id TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  capabilities_json TEXT NOT NULL,
  granted_by TEXT NOT NULL,
  revoked_at TEXT,
  expires_at TEXT
);
CREATE TABLE IF NOT EXISTS agent_subscriptions (
  subscription_id TEXT PRIMARY KEY,
  ticket_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  source_thread_ref TEXT NOT NULL,
  event_types_json TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  UNIQUE(ticket_id,source_id,source_thread_ref)
);
CREATE TABLE IF NOT EXISTS agent_assignments (
  assignment_id TEXT PRIMARY KEY,
  ticket_id TEXT NOT NULL,
  executor_kind TEXT NOT NULL,
  codex_thread_id TEXT,
  ticket_version INTEGER NOT NULL,
  lease_token TEXT NOT NULL,
  lease_until TEXT NOT NULL,
  state TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

> 迁移原则：**保留原 `tasks` 表与 Task ID**，先加 `ticket_id = task_id` 兼容视图和 Adapter，再将新的 Admission、Subscription、Assignment 逐阶段切流。新表设计与旧版 `task_runs` 可能存在语义重叠，必须在代码中选定唯一事实源，禁止双向写入导致状态分叉。

### F. Dot 前台单对话与 GitHub 后台事件的两个样例

```mermaid
sequenceDiagram
  autonumber
  actor User as 用户
  participant UI as Dot Chat
  participant GW as Event Gateway
  participant SM as Subscription Matcher
  participant EV as Eval Router
  participant DB as Ticket Store
  participant W as Assignment Worker
  participant CX as Codex App Server
  User->>UI: “继续之前的 Android Bug”
  UI->>GW: message + messageId
  GW->>SM: normalize trigger
  SM-->>GW: 无明确订阅
  GW->>EV: candidates + focus + history
  EV-->>DB: route to existing Ticket
  DB->>W: 创建 Assignment/Lease
  W->>CX: thread/resume 或 thread/start; turn/start
  CX-->>W: events + result
  W->>DB: versioned checkpoint
  DB-->>UI: linked progress + taskId
```

```mermaid
sequenceDiagram
  autonumber
  participant GH as GitHub Webhook
  participant GW as Event Gateway
  participant SM as Subscription Registry
  participant T as Ticket Store
  participant W as Worker
  participant CX as Codex Core
  GH->>GW: PR review comment (eventId)
  GW->>GW: 幂等保存 Trigger
  GW->>SM: match(PR thread/eventType)
  SM-->>T: 匹配已订阅 Ticket
  T->>W: create new Assignment
  W->>CX: 恢复关联 Codex Thread
  CX-->>W: PR 修改/测试结果
  W->>T: 保存结果并更新 Subscription
```

### G. 与 OpenMuse / DSH 的开源实现取舍

- **DSH 概念复用，不是强依赖**：优先抽取 Trigger、Admission/Eval、Mandate、Ticket/Assignment、Subscription 的行为与接口，不直接搬运研究原型的单仓库身份假设或无逐步审批的 Shell 权限模型。
- **OpenMuse 定位调整**：OpenMuse 可继续用作 UX、TaskWorker/ActionService 对照参考；**目前主实施基线仍是 `Codex Core + 自研 Desktop Host + Dot Control Plane`**，不应出现两个相互竞争的主运行时。
- **多引擎策略**：先将 Executor Router 接口稳定化、完成 Codex Adapter；DSH Adapter 只在独立实验分支中测试，不参与前期 M1/M2 验收。
- **完整个人 Memory、Browser/Computer Use、Authd-like Credential Broker、Sentinel-like Permission Gateway** 仍需按照既有独立文档实现。DSH Super-Agent 的研究原型不证明这些能力具备生产安全。

### H. 增量开发任务与验收

| ID | 阶段 | 任务 | 验收 |
|---|---|---|---|
| DSH-01 | M2-Spike（非阻塞） | 锁定 DeepSeek 两仓库 Commit 和 License | 可重现 checkout、构建、测试结果 |
| DSH-02 | M2-Spike | 复现 Issue→Ticket→Executor→PR→Review | 事件与任务一一可追踪 |
| DSH-03 | M2-Spike | 对照 Codex Executor、统计耗时与失败 | 形成证据矩阵，不凭印象切换 |
| DOT-AD-01 | M3 | Trigger 规范化、去重、审计 | 重复 webhook 仅一个业务 Trigger |
| DOT-AD-02 | M3 | Source Thread Subscription | PR 新评论确定性关联原 Ticket |
| DOT-AD-03 | M3 | Eval 与 Conversation Router 分离 | `create/route/ignore/clarify` 有日志 |
| DOT-AD-04 | M3 | Task/Ticket 与 Assignment 解耦 | 崩溃恢复 + 无双重活动写租约 |
| DOT-AD-05 | M3 | Mandate 版本与撤销 | 超范围动作被 Gateway 拒绝 |
| DOT-AD-06 | M4 | Goal→Subscription/Future Trigger 关联 | Goal 完成后自动终止关联订阅 |
| DOT-AD-07 | M4 | 多事件合并、主动通知限流 | 无重复通知与循环任务创建 |
| DOT-AD-08 | M5 | Device Source 复用 | 手机/眼镜事件有明确来源及授权 |

**非阻塞原则**：以上设计不应阻止 Codex Desktop 的第一阶段功能验证，也不能将正式 OAuth、多用户账号和计费提前到 M1/M2。**但本地沙箱与敏感操作的有效审批始终是底线。**


### I. 产品研究的新增结论与证据边界

DeepSeek Super-Agent 带来的价值不是证明已经存在一个“完全开源的 Muse/dots”，而是提供长期任务的**领域建模、事件准入、外部 Thread 订阅和任务授权范围**的研究样本。它的研究原型主要面向 GitHub/可选飞书事件下的单仓库协作；`Ticket/Assignment` 的术语不能直接替换 Muse、dots 官方未公开的架构事实。

竞争格局更新：`Codex Core` 负责可修改的执行 Harness；`OpenMuse/OpenDots` 提供产品与工作流参考；`Letta/OpenClaw` 提供记忆和长期主动性的比较基线；`DeepSeek Harness/Super-Agent` 提供插件化 Harness 与事件 Ticket 组织的比较基线。**不存在单一项目已证明完整包含 Muse 级 Credential Broker、强制网络出口、Personal Memory、Browser/Computer User Takeover、长期 Goal 自动重规划和多租户安全**。


### 参考来源与证据等级（截至 2026-10-31）

- [代码/项目声明] [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) — Developer Preview；版本和运行接口需锁定 Commit 后逐项实测。
- [代码/研究原型] [DSH Super-Agent Prototype](https://github.com/deepseek-ai/dsh-superagent-prototype) — Research Prototype，聚焦 GitHub/飞书软件工程事件，并非成熟的通用个人助手。
- [架构] [Domain Model](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/docs/001-domain.md)、[Authorization](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/docs/002-authorization.md)、[Execution](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/docs/003-execution.md)、[Architecture](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/docs/007-architecture.md)。文档路径可能随版本变化，应以锁定的源 Commit 为准。
- [当前主线] [OpenAI Codex 开源仓库](https://github.com/openai/codex)，[App Server 协议](https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/src/protocol/common.rs)。

**证据限制**：开源项目宣称实现的功能不等于已在本项目完成部署或安全验收；本修订所有 `personal-dot/*` 类型、Event/Subscription/Mandate 表和迁移脚本均为本项目新设计。严禁将 Mandate 当成支付、网络出口或凭据使用的最终授权凭证。
