# M3 人工走查执行记录

计划：[完整用例与引导](M3_MANUAL_WALKTHROUGH.md)。开始日期：2026-11-03，最新更新2026-11-04。A01–A04由用户操作；用户随后授权Agent鼠标执行简单操作，结果另列“Agent UI实测”，不冒称用户操作，不把既有M3 Gate或启动预检填入本轮通过列。

## 当前进度

2026-11-04：用户确认A04三条任务均“已排队”后，明确要求简单操作由Agent鼠标执行验证。Agent已实际完成A05–A10及B/C规则聊天和记忆检查，包括跨原定时刻暂停不触发、改期、显式启用和真实到期仅排队唤醒。使用原走查进程、生产Renderer/Main/SQLite/真实PTY/Git/Finder，不替换后端，不通过Host写库模拟操作。定位`checkpoint/M3.manual-basic-ui`，见[脱敏证据](evidence/M3-manual-basic-ui.json)。

54项桌面用例 + 8组Host协助边界。**用户操作通过4（A01–A04），Agent UI实测通过27（A05–A10、B01–B08、C01–C08、D01–D05），合计31项通过，其余31项待执行；当前未解决失败0**。A04未单独由用户报告的资源UI已在A10由Agent实际观察，仍分别归属。A01首轮失败历史保留；本轮新模型请求0。

执行档案：独立 `.local/m3-manual-20261103/profile`；项目路径由该会话 `session.json` 的 `code/goal/other` 指向系统临时目录。运行数据库、完整路径清单、原始输出均留本地忽略目录；Git只收脱敏摘要。正式默认档案未被选为本轮目标。

## 准备与实际验证

- 开始前工作区干净；已阅读AGENTS、本地交接、总进展、M3执行/操作记录与相关M3专题，并逐项核对生产Renderer按钮/Host启动路径。
- 新增 `scripts/manual-walkthrough.mjs`：Node24下运行，生成3个独立公开Git项目及专用Electron档案；重复准备不重置已有项目。普通启动导入生产Main，不启用smoke/Stub后端；`--preflight`只接受无项目/业务执行/Source配置/激活恢复代的空档案，避免预检启动已有自动计划。
- `node --check scripts/manual-walkthrough.mjs`通过；`--prepare`首次及重复执行成功。三个Git项目均干净，分别实际运行Node TAP：4发现、0通过、4失败、0跳过、退出1，恰是有意保留的加法故障，不能称业务测试通过。
- `--preflight`真实Electron构建/加载/自动退出成功；实际`userData`为专用档案，sandbox/contextIsolation/webSecurity=true，nodeIntegration=false。随后只读SQLite：projects/tasks/task_runs/execution_intents均0；没有发模型任务。该检查使用真实Main/SQLite/窗口，无用户目录选择、无人工功能操作。
- 额外实际验证：重复`--prepare`保持会话清单/源码/测试哈希不变；非法参数拒绝；在空档案临时创建无秘密的空Source配置后，`--preflight`在构建/启动前拒绝，随后移除此测试文件。M3 Gate记录的71个产品实现文件哈希全部未变。
- 用例表/执行表62个唯一编号一致（54桌面、8协助），相对文档链接及启动器证据哈希检查通过，`git diff --check`通过。已用普通专用入口保持走查进程运行；Agent只读UI观察到真实窗口“Personal Agent”、空项目界面、“尚未检查连接”和“＋ 选择项目”。未点击连接/选择目录；用户确认仍待A01/A02。
- 仅新增走查工具和文档，未改产品实现/协议/生成类型；本轮不重跑586项全量检查，也不沿用其结果为本次测试。本轮验证摘要在 [evidence/M3-manual-preparation.json](evidence/M3-manual-preparation.json)。
- 走查准备提交`8e8bf60a8621bcf6379b17ff33fe61a1fd413a4a`已推送；实际`git ls-remote`核对远程`main`和`checkpoint/M3.manual-plan`在本次核对时均为该SHA。此后仅追加该远程核对回执；标签仍定位走查准备本体，人工结果仍未通过。

## 人工结果表

每项后续补：时间、操作人、实际结果、涉及ID/版本、预期是否满足、证据路径/脱敏摘要、发现/后续。用户口述与Host观察分列；待执行项的空白不表示通过。

| 用例 | 状态 | UI观察及操作人 | Host核对/证据 | 问题与下一步 |
|---|---|---|---|---|
| A01 | 通过（修复后人工复走） | 首轮失败；2026-11-04用户确认连续两次均显示“目录已连接 · 8 个模型” | 既有Host复验与用户反馈分别保留；本次无新模型调用 | CONN-01人工复走通过，原失败记录保留 |
| A02 | 通过 | 2026-11-04用户确认取消后没有新增项目，选择后标题walkthrough-code，项目任务/主聊天/目标与记忆入口均可见 | 按用户实际操作反馈登记；Agent未代选目录 | 继续A03；无新模型调用 |
| A03 | 通过 | 2026-11-04用户确认三项均符合：sum为a-b、test文件4个测试定义、Git没有变更 | 用户真实UI观察；本次未代操作或运行测试 | 公开故障保留用于后续代码任务 |
| A04 | 通过（用户观察+Host只读核对） | 用户确认看到3条任务，均“已排队” | 3个不同Task ID、均readOnly/queued；Run/Intent/预算预留均0，详见脱敏证据 | T3实际为“人工走查只读待办”；资源UI显示待A10，不代填用户观察 |
| A05 | 通过（Agent UI实测） | T3改为“人工走查只读任务已改名”，暂停后恢复；新建“可取消演练”并取消，取消卡片不再有开始按钮；活动可见 | T3最终queued/v6；取消项cancelled/v3；对应操作完成，0 Run/Intent | 首次输入未落入表单，曾原名保存一次；随后粘贴并确认新值再保存，额外版本如实保留 |
| A06 | 通过（Agent UI实测） | 选中T1/T2后暂停所选（2），逐项显示“操作已处理”，两项均暂停，再分别恢复排队 | 两项各一次PAUSE_TASK/CONTINUE_TASK completed，最终queued/v4，0 Run | 非合成批次；没有通过批量运行启动模型 |
| A07 | 通过（Agent UI实测） | 真实终端pwd指向P、Git无变更，调整100×30；占用时创建工作树/启动T3均明确拒绝；跨页输出保留；关闭后“已结束” | exited、100×30、0终端租约、0 Run/Intent；关闭记录exit_code=1/error_code=null，不将停止退出码称命令测试成功 | 被拒工作树没有创建；T3仍排队，未实际发送模型 |
| A08 | 通过（Agent UI实测） | 创建walk-manual-one，切换标题/分支及读取sum故障代码，切回P；检查干净后移除，恢复目录显示保留并在Finder定位 | 创建/移除均completed；managed_worktrees removed/v2；Git只登记原P，恢复源码/测试字节相同，原P干净、分支仍在 | 恢复目录及分支未清除；不是不可逆删除 |
| A09 | 通过（Agent UI实测） | 原22:31到期后仍暂停/0实例；改为22:33、截止23:33，对应14:33Z。另暂停后显式启用，真实到期显示“已结束 · v5”和唯一实例“输入已入队 · 已恢复任务排队” | queue_only，fulfilled/v5，唯一Occurrence/enqueued及Delivery/acknowledged；任务queued/v4，0 Run/Intent/预留 | 改期保存本身会启用，故另测暂停v4→启用v5；最终无活动计划需取消，不伪称执行了不可用的取消操作 |
| A10 | 通过（Agent UI实测） | 队列数与运行数分别显示；模型/未知/预留0；RSS/CPU明确仅Main。技能0项、MCP/插件/子Agent未启用，返回后状态保留 | 资源占用与只读账本一致；技能真实发现预览，没有安装/启用操作 | 未作RSS性能达标结论；不把目录发现当执行授权 |
| B01 | 通过（Agent UI实测） | 惰性笔记保存、关闭重开仍在；任务未变。 | [BC脱敏证据](evidence/M3-manual-BC.json)；0 Run/Intent/预留 | B08仅版本变化分支；C05/06修复后冷进程复走 |
| B02 | 通过（Agent UI实测） | 两个同名候选显示短ID；选T2后只查询，未发送草稿保留。 | [BC脱敏证据](evidence/M3-manual-BC.json)；0 Run/Intent/预留 | B08仅版本变化分支；C05/06修复后冷进程复走 |
| B03 | 通过（Agent UI实测） | 明确T1及清空选择后依Focus查询均指向T1。 | [BC脱敏证据](evidence/M3-manual-BC.json)；0 Run/Intent/预留 | B08仅版本变化分支；C05/06修复后冷进程复走 |
| B04 | 通过（Agent UI实测） | 普通暂停文本和未知ID均澄清，无任务控制副作用。 | [BC脱敏证据](evidence/M3-manual-BC.json)；0 Run/Intent/预留 | B08仅版本变化分支；C05/06修复后冷进程复走 |
| B05 | 通过（Agent UI实测） | HTML作为文字；8193个ASCII粘贴后AX实际长度8192，清空未发送。 | [BC脱敏证据](evidence/M3-manual-BC.json)；0 Run/Intent/预留 | B08仅版本变化分支；C05/06修复后冷进程复走 |
| B06 | 通过（Agent UI实测） | 两种独立草稿刷新/核对后不串写，关闭后草稿清空、已发记录保留。 | [BC脱敏证据](evidence/M3-manual-BC.json)；0 Run/Intent/预留 | B08仅版本变化分支；C05/06修复后冷进程复走 |
| B07 | 通过（Agent UI实测） | R拒绝查询P完整Task ID，返回P同ID成功；R专用待办仅排队。 | [BC脱敏证据](evidence/M3-manual-BC.json)；0 Run/Intent/预留 | B08仅版本变化分支；C05/06修复后冷进程复走 |
| B08 | 通过（Agent UI实测） | 因已有Focus，以同时明确引用T1/T2产生新Pending；T2暂停恢复v4→v6后旧候选被移除，未接受陈旧选择。 | [BC脱敏证据](evidence/M3-manual-BC.json)；0 Run/Intent/预留 | B08仅版本变化分支；C05/06修复后冷进程复走 |
| C01 | 通过（Agent UI实测） | remember消息仅为来源，检索尚无Claim。 | [BC脱敏证据](evidence/M3-manual-BC.json)；0 Run/Intent/预留 | B08仅版本变化分支；C05/06修复后冷进程复走 |
| C02 | 通过（Agent UI实测） | 明确私人语言记忆v1，消息/修订/引用哈希可追溯。 | [BC脱敏证据](evidence/M3-manual-BC.json)；0 Run/Intent/预留 | B08仅版本变化分支；C05/06修复后冷进程复走 |
| C03 | 通过（Agent UI实测） | 普通消息提升明确确认被拒，按未确认推断保存v1。 | [BC脱敏证据](evidence/M3-manual-BC.json)；0 Run/Intent/预留 | B08仅版本变化分支；C05/06修复后冷进程复走 |
| C04 | 通过（Agent UI实测） | 取消修订保留v1；新同键来源明确修订为English v2。 | [BC脱敏证据](evidence/M3-manual-BC.json)；0 Run/Intent/预留 | B08仅版本变化分支；C05/06修复后冷进程复走 |
| C05 | 通过（Agent UI实测） | 初见祖先旧来源候选缺口；整链保护修复后冷进程仅提供新第三值来源；引用不匹配拒绝，English仍v2。 | [BC脱敏证据](evidence/M3-manual-BC.json)；0 Run/Intent/预留 | B08仅版本变化分支；C05/06修复后冷进程复走 |
| C06 | 通过（Agent UI实测） | 同名任务选择器加入短ID后，明确T1检索命中，T2与个人域不含该记忆。 | [BC脱敏证据](evidence/M3-manual-BC.json)；0 Run/Intent/预留 | B08仅版本变化分支；C05/06修复后冷进程复走 |
| C07 | 通过（Agent UI实测） | 默认私人推断写编码域被拒；明确公开/确认后编码经验v1可检索。 | [BC脱敏证据](evidence/M3-manual-BC.json)；0 Run/Intent/预留 | B08仅版本变化分支；C05/06修复后冷进程复走 |
| C08 | 通过（Agent UI实测） | 敏感测试记忆实际保存并可检索；实际信任为未确认推断，自动注入排除另由S04核对。 | [BC脱敏证据](evidence/M3-manual-BC.json)；0 Run/Intent/预留 | B08仅版本变化分支；C05/06修复后冷进程复走 |
| D01 | 通过（Agent UI实测，修复后复走） | 真实Router仅提QUERY_TASK；提交前T1 queued/v4不变。 | [真实请求与证据](evidence/M3-manual-route-ui.json) | 首轮失败与额外复走请求分别保留 |
| D02 | 通过（Agent UI实测，修复后复走） | 提交后查询完成，多次核对无新Router或重复操作。 | [真实请求与证据](evidence/M3-manual-route-ui.json) | 首轮失败与额外复走请求分别保留 |
| D03 | 通过（Agent UI实测，修复后复走） | 首轮非法CHAT+CLARIFY严格拒绝，确定性失败分类修复且0重发；新UI请求复走后独立Chat回答English和4。 | [真实请求与证据](evidence/M3-manual-route-ui.json) | 首轮失败与额外复走请求分别保留 |
| D04 | 通过（Agent UI实测，修复后复走） | 改名→查询依赖按自身v7收据完成；初建标题丢失修复后只补测独立标题/正文创建，旧效果保留、均只排队。 | [真实请求与证据](evidence/M3-manual-route-ui.json) | 首轮失败与额外复走请求分别保留 |
| D05 | 通过（Agent UI实测，修复后复走） | 明确更正T2，原改名/创建效果保留，后续query转到T2；没有待派发项，不宣称覆盖部分撤销。 | [真实请求与证据](evidence/M3-manual-route-ui.json) | 首轮失败与额外复走请求分别保留 |
| D06 | 执行中 | 代码任务C已带固定测试入口/允许文件排队，另存自身Task私人标记用于S04 | Task ID见本批证据；尚未启动 | 启动后到独立验证结束前不覆盖构建产物 |
| D07 | 待执行 | — | — | 付费：同线程续接 |
| D08 | 待执行 | — | — | 付费：只读+新线程续接 |
| E01 | 待执行 | — | — | — |
| E02 | 待执行 | — | — | — |
| E03 | 待执行 | — | — | — |
| E04 | 待执行 | — | — | — |
| E05 | 待执行 | — | — | 不足预算应0发送 |
| E06 | 待执行 | — | — | 付费：Goal代码执行 |
| E07 | 待执行 | — | — | UX-01，需协助取真实收据编号 |
| E08 | 待执行 | — | — | OS展示/未知如实分开 |
| F01 | 待执行 | — | — | — |
| F02 | 待执行 | — | — | 仅排队唤醒 |
| F03 | 待执行 | — | — | — |
| F04 | 待执行 | — | — | 仅专用档案 |
| F05 | 待执行 | — | — | 仅专用档案，依赖无未决执行 |
| F06 | 待执行 | — | — | — |
| G01 | 待执行 | — | — | 最后执行；先核对遗忘范围 |
| G02 | 待执行 | — | — | — |
| G03 | 待执行 | — | — | — |
| G04 | 待执行 | — | — | — |
| G05 | 待执行 | — | — | 无pending不得冒称覆盖故障恢复 |
| G06 | 待执行 | — | — | 可选付费运行中遗忘，不能替Unknown改成功 |
| S01 | 待执行 | — | — | 自有HTTPS Provider尚未为本轮配置 |
| S02 | 待执行 | — | — | 同上；逐负例记录 |
| S03 | 待执行 | — | — | 依赖本轮真实Source接线 |
| S04 | 待执行 | — | — | 依赖D03/D06实际Run |
| S05 | 待执行 | — | — | 当前档案扫描与独立故障档案分开 |
| S06 | 待执行 | — | — | 时钟/通知Fixture和真实OS分开 |
| S07 | 待执行 | — | — | 独立故障注入 |
| S08 | 待执行 | — | — | 独立副本，不破坏人工档案 |

## 问题单

| 编号 | 发现方式/状态 | 复现与影响 | 决定 |
|---|---|---|---|
| UX-01 | 记录ID投影/展示已实现；真实验收待D07/E07 | 验证页只显示结果/计数/Diff，Goal完成表单却要求verificationId。用户不能仅靠界面取编号。 | E07由Host只读提供真实收据并分列结果；人工独立闭环不判通过，后续修复与复走。 |
| UX-02 | C05真实UI复现，修复后冷进程复走通过 | 修订v2时v1旧来源曾重新成为候选；新增回归首次实际失败。 | UI/命令/Store均按整条修订链拒绝复用来源；48项增量通过，新消息仍可明确恢复旧值。 |
| UX-03 | C06真实UI复现，修复后通过 | 任务记忆下拉仅标题，同名任务无法区分。 | 标签新增Task短ID，T1/T2/personal实际分域复走。 |
| UX-05 | D03真实复现，修复后复走通过 | Router混合CHAT+CLARIFY被校验拒绝，却错误标为未知；Router误把无个人记忆当澄清理由。 | 明确只转交CHAT；实际completed且明确无效的空提案从原证据归类失败，真实Unknown保持；新请求复走成功。 |
| UX-06 | D04真实复现，修复后补测通过 | CREATE_TASK未把提案独立title传入账本，标题变成正文。 | 有界可选title独立于text，纳入命令Hash；真实新UI创建标题/正文分别正确。旧错误Task保留。 |
| UX-04 | C07拒绝文字缺口，已调整 | 私人推断写coding被正确拒绝，但显示未知泛化提示。 | 增加明确公开/确认要求的错误文案；原拒绝与真实公开保存均保留。 |
| CONN-01 | 修复完成，Agent验证与用户人工复走均通过 | 首轮initialize 15002ms超时；真实冷启动需17615ms。原专用索引自然恢复；用户于2026-11-04确认连续两次目录连接8模型。 | 关闭本问题的人工复走项，失败历史保留；不将目录读取当作推理成功。 |

## 走查任务别名（公开测试数据）

| 别名 | Task ID | A04实际标题 |
|---|---|---|
| T1 | 8eb2c9d2-4aac-4a83-b1be-ba38cc7ed616 | 人工走查待办 |
| T2 | a3a189ff-cfbf-4d21-b407-b7fdb7845034 | 人工走查待办 |
| T3 | cd6fad39-9798-428f-b35c-f750566ba3bc | 人工走查只读待办 |

A05后T3当前标题为“人工走查只读任务已改名”。新增取消演练Task `396b4b93-28ad-4b66-95d4-104e9b16df33` 已取消；时间计划演练Task `be3932a6-9c04-497c-aa47-51810a78ca2c` 已由唯一计划实例恢复排队。当前共5条Task（4排队、1取消），均未创建Run。

本点收尾再次只读核对实例/投递各1条，Run/Intent/预算预留均0，没有重复唤醒。证据JSON、62个用例ID唯一且与计划一致、10通过/52待执行统计、文档相对链接及脱敏路径检查通过，`git diff --check`通过；未运行单元或全量回归。

走查本体提交`2abd099a63971f0eee745115b088325410e978f2`已推送；实际`git ls-remote`核对当时远程`main`与`checkpoint/M3.manual-basic-ui`均为该SHA。此后仅追加本远程核对回执，标签仍定位走查证据本体。

## 模型与未决记录

当前实际新请求6（5 Router、1 Chat），均模型Run completed，报告Token 96,401，Unknown预留0。D03原非法提案业务失败保留，后续修复复走为新请求；不能把模型Run完成当业务验证。后续每笔登记用例、角色、Task/Run/Thread ID、实际终态、已报告用量、保留预留与是否核对；路由与Chat分开，禁止把子请求遗漏。尚未开始真实业务，不能宣称本轮模型成功。

## 下一步

A01–C08全部完成，接续D类真实Router/Chat/代码/检查点，再完成E/F/G及S边界；用户要求全部结束后统一汇报。A05–A10真实UI和Host只读结果分列，详见[本点证据](evidence/M3-manual-basic-ui.json)；本点未改产品代码，未运行单元或全量回归，以实际六项增量UI验收及副作用核对为准，没有模型调用。后续回归默认增量，全量仅用户明确要求时运行。UX-01仍待E07修复/复走；Source尚未准备生产HTTPS Provider，不把既有HTTP Fixture称本轮第三方账号通过。

## CONN-01 排查与修复过程（2026-11-03）

用户实际反馈A01连接未完成。Agent只读读取UI错误码并执行同参数原生探测，initialize在15秒超时；进一步只在内存读取并脱敏stderr，确认启动等待回填状态、30秒后退出。最初“本机Codex历史索引运行中”的说明经只读SQLite细化：共享主档案为complete，专用sqlite_home为running，更新水位停留；未把它误判成认证失败，也未修改共享档案。

独立**真实锁版CLI**冷启动验证：新sqlite_home用60秒initialize期限，17615ms完成initialize，20846ms完成8模型目录，0Thread/Turn/推理。新增initialize专用默认60秒预算；普通请求原15秒/执行原30秒及显式期限不变。仅匹配固定回填stderr标记，将initialize的超时/进程退出显示为CODEX_STATE_INDEX_PENDING；取消、其他方法的Unknown语义不被改写，没有自动发送/重试。UI展示索引未就绪与首次等待提示，不把“检查连接”称登录成功。

组件验证17/17（真实Node子进程，合成stdio的慢启动、分片stderr/退出/超时/不重发等；不是模型）。常规pnpm check首轮571通过、18失败，全为本机沙箱禁止loopback监听/ps（EPERM）；授权环境复验588通过、1个既有终端强杀用例TERMINAL_WAIT_TIMEOUT。终端文件单独复验11/11，随后完整复跑**589/589、0失败/跳过，747协议类型、严格TS、17合同及构建通过**；保留前两次失败轨迹，不把重跑描述成从未失败。

原专用索引等待期间由原生路径自然恢复complete；随后该原路径initialize/模型目录实际3024ms、8模型、0Thread/Turn。专用Electron冷重开后Agent只读UI见“目录已连接 · 8 个模型”，0项目/Task/Run/Intent；运行中只有一个持有该专用入口的Main。没有手改updated_at/status、没有删除索引、没有更换CLI哈希/复制凭据；产品后续变更与准备阶段71文件未变的历史核对分开记录。脱敏结果见[evidence/M3-manual-connection-fix.json](evidence/M3-manual-connection-fix.json)。

上述全量已在用户最新指令前结束。用户随后明确要求“后续回归检查不需要全量，只要增量；除非要求全量”，已写入AGENTS和交接；今后默认增量，不因本次采用pnpm check而沿用全量策略。

协议核对：[官方App Server文档](https://learn.chatgpt.com/docs/app-server)说明stdio/initialize/thread与turn接口；运行路径仍是Electron Main → 锁版CLI承载App Server → Codex Core，检查连接只做initialize/initialized/model-list，并不调用login或创建模型任务。

## 运行时架构核对（用户追问，2026-11-03）

用户质疑官方桌面客户端是否依赖CLI、当前方案是否偏离。按OpenAI Docs核对[App Server协议与启动示例](https://learn.chatgpt.com/docs/app-server)和[官方平台集成说明](https://developers.openai.com/blog/codex-as-a-platform)：官方推荐富客户端通过App Server管理认证、历史、流式事件和审批，示例本身以spawn("codex", ["app-server"])启动服务。这里是二进制承载的服务模式，不是启动终端交互界面/解析终端文字，也不是每次用codex exec提交任务。公开资料可支持集成路线，不足以证明官方桌面端所有私有生命周期实现。

本项目静态核对：read-connection/inspectConnection使用短连接，ForegroundExecution为执行会话创建StdioRpcClient，存在重复初始化；二进制优先来自项目.local内受哈希/版本校验的官方发行物，另有显式配置/PATH解析。认证沿用受支持的本机登录，SQLite/日志目录独立。CONN-01说明冷启动/索引就绪管理存在实际缺口，不能把“官方推荐协议”当作产品成熟度证明。

CONN-01修复提交`17a7d5fbbcb14c830523736dd6db367c89776dd5`已推送；实际核对远程`main`和`checkpoint/M3.manual-conn`在本次核对时均为该SHA。随后只追加本远程核对回执；人工A01仍待用户复走。

结论：保留App Server协议路线；后续架构审查应聚焦初始化就绪、状态迁移，以及**按角色/权限/隐私边界**的进程复用。不能直接将Router/Chat/Coding合成单一常驻进程，更不能为缩短等待共享私有状态或复制认证。本轮只完成已验证的连接修复和事实记录，没有擅自进行运行时重构；人工走查仍保留当前执行进度。

后续用户明确授权的运行时实现已另在[M3.runtime](M3_APPSERVER_RUNTIME.md)完成；上述“本轮”指CONN-01当时范围。当前下一步A01复走：点击检查连接，应见8模型，再次点击应保持可用；用户确认后进入A02取消目录框/选择P。模型请求仍0。
