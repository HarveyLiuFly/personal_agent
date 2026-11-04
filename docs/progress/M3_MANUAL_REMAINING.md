# M3 剩余走查执行批次（2026-11-04）

起点`4f4c83e`，开始前工作区干净。用户要求Agent继续走查，全部结束后统一汇报。沿用原U/P/Q/R，不重置档案；操作通过原生CUA鼠标/键盘，Host仅只读核对当前账本。常规回归仍只做增量。

计划按B规则聊天→C记忆→D真实Router/Chat/代码/检查点→E目标/预算/验证/通知→F后台/恢复→G隐私与S协助边界执行。D/E为本轮真实模型请求，逐笔登记Run/Intent/用量，Unknown只核对不重发。S组件可针对对应文件运行，Fixture不代替真实UI/HTTPS/OS验收；缺少外部HTTPS Provider的分支如实记录阻塞。恢复前先登记完整模型/源码/验证证据，隐私不可逆操作遵循原生工具的当次确认边界，不把本轮整体授权解释为取消确认要求。

## B执行中

B01笔记真实保存并重开仍在；B02两个同名候选显示短ID，选择T2后只查询，未发普通草稿保留；B03明确T1查询及清空明确选择后依Focus查询均返回T1；B04暂停普通文本/未知ID均澄清且未隐式执行。B05 HTML惰性文字，8193个ASCII粘贴实际保留8192且未发送，随后清空。B06两种独立草稿刷新/核对后不串写，关闭重开草稿清空、已发送记录在。B07注册R并创建专用待办，R查询P的完整Task ID拒绝；回P同ID成功。以上为Agent UI观察，待本批收尾Host核对Task版本/Run/Intent。

B08原P已有Focus会优先命中，故以同时明确引用T1/T2产生新的多候选Pending（22:45:20），之后通过UI变更候选版本再选择旧候选；等价覆盖候选CAS过期，不伪称15分钟自然超时已发生。

## 阻塞、修复与下一步

UX-01仍待真实验证页复现；在E07前完成可审阅修复及增量验证，再实际复走。其余实际结果随执行更新，不用既有Gate收据替本轮通过。

## B/C本批完成及修复

B01–B08、C01–C08已由Agent真实UI执行，冷进程复走C05/C06后通过。B08通过明确两个ID产生Pending并变更T2版本；不称已自然等待15分钟。Host只读确认6条Task（P5/R1）、6个Claim版本（含language superseded v1/active English v2）、0 Run/Intent/预算预留。C08实际是sensitive + agent_inference，不伪称explicit。

发现UX-02旧祖先来源复用：新增回归先失败，UI/命令/Store按整链来源拒绝；48/48受影响Memory/Context组件通过。新增Task短ID以区分同名（UX-03），编码域明确拒绝文案（UX-04），并接通验证ID的DTO/Main/Renderer（UX-01真实验收待D07/E07）。首次TS发现DTO缺字段，补齐后TS/构建通过；修订保护最后限定用户消息来源，增量memory-commands再次通过，不将复跑累加。Source配置/签名19项组件通过，真实HTTPS尚无Provider，不能关闭S01–S03。原生菜单显式退出并以同U新Main重开；数据保留，未手改运行账本。

下一步D真实模型链路，然后E/F；G不可逆确认边界仍保留。证据见evidence/M3-manual-BC.json。

## D执行及协助检查进行中

D01真实Router完成，仅QUERY_TASK且T1保持queued/v4；D02提交查询并重复只读核对，不新增Run。首个真实Run `915f8337-8adf-4b5e-81cf-8886863e9b58` 报告15,932 Token。

D03首轮Router Run `80564a75-d7b3-408a-a11a-a6ddeed77847` 实际completed，报告16,094 Token，但返回CHAT+CLARIFY混合提案，严格校验INVALID_ROUTE_CLARIFICATION正确拒绝，未提交业务。发现UX-05：已确定无效的提案被保存为outcome_unknown，Router还把自身没有个人记忆误解为需要澄清。正在修复：明确Router只转交CHAT请求、不自行回答/读取个人记忆，CLARIFY独占；仅对实际completed且有明确校验拒绝证据的旧空提案做只读重新分类，真实Unknown不改写、不发新模型。新增隔离回归确保原Run/调用数不变；新请求仅在旧失败确定后由UI明确复走。

S07规则/Route/CAS39项、S08恢复/验证26项、S05隐私15项组件通过（实际SQLite/文件；模型/通知/故障适配器按Fixture分列）。S06目标/预算63项初次62通过/1失败：goals.test.ts固定Goal时钟为11月3日，而预算占用使用真实11月4日，修订故而选不中测试占用的UTC日；改该用例将Goal时钟对齐实际已保存Bucket的同一天，不放宽余额/Unknown断言，不改产品预算。定向复验进行中。

用户追加要求把窗口放到扩展屏：原生Window菜单只提供“移到内建视网膜显示器”，表明测试窗口已在另一显示器；通过Bring All to Front将其置前，继续在扩展屏操作，未改显示器或系统安全设置。后续冷重启还需重新确认窗口位置。

BC提交`8220c359216b148108e3685487cb95a074d5b57f`已推送；实际远程main和checkpoint/M3.manual-BC在核对时均为该SHA。无强推。

UX-05定向50/50组件通过；首次49/50中另一个失败是旧测试复制了完整旧routePrompt，改为调用实际routePrompt后恢复，不弱化幂等断言。TS/构建通过。新Main恢复后真实UI显示原提案“未通过校验，未提交任何操作”，Host只读仍2个原Run、32,026报告Token、0重发，原非法提案现failed且Run仍completed。准备通过UI另立D03复走；不是重发未决Unknown。新Main初始在内建屏，已通过原生“移到Sculptor”实际移动，菜单随后提供“移到内建视网膜显示器”作为反向核对。

## D01–D05完成与标题修复

D03独立Chat实际返回最新确认English及4，Router/Chat不同Run；真实Manifest确认Router无Claim、Chat只装个人有效Claim，不含敏感/T1/T2私域，各Run有native_policy_verified事件。D04三步按依赖完成，T3 v7；发现独立title未透传（UX-06），增加Task create可选有界title并绑定幂等Hash，43/43增量及TS/构建通过。保留首次正文当标题的Task，另建“路由新增待办复走”真实UI补测标题/正文分别正确，仅排队。D05更正T2，效果不撤回不复制；没有未派发项不冒称部分撤销。当前6笔真实请求全部已结算、无Unknown占用，逐笔ID/用量见evidence/M3-manual-route-ui.json。

代码Task C `7ad2d7de-29cb-4317-9e1c-f40cb16a8325` 已按固定test/math.test.mjs、只允许src/math.mjs创建为queued/v2；通过UI保存本Task私人标记WALK_M3_CODE_OWN，稍后实际Coding Manifest与T1/T2私域做对照。代码启动到独立验证完成前不再覆盖构建产物，以免改变冻结Verifier Hash。下一步D06–D08，然后E/F及G/S。

## D06–D08与E01–E05实际完成（继续执行）

代码C首Run `71ee660d-5fdf-4017-a3d7-6b5166d57a60` 只改src/math.mjs减号为加号，真实UI先看Diff，模型结束仍待审查、未有验证收据。D07新Run `0b315ab5-e815-4350-be65-2e2e0fb11a89` 使用thread_resume，复用原Thread `01a1a72f-ac01-7562-88e0-bb00a2666b81`，不同Turn，继承全部冻结字段（仅specId/runId/createdAt换新）。Host原生独立验证4 discovered/4 executed/0 skipped/passed，发布收据`a228f336-3b92-4c53-bad8-fb9ff09be4b1`，文件Hash与账本一致，Task才completed。实际UI已显示完成核验记录ID，UX-01展示子项通过，完整Goal复制提交待E07。审计初次误将新specId/runId/createdAt也要求相同，随后逐字段核对冻结合同全部一致；初次把验证产物根猜为execution/artifacts，实际只读定位为U/verification/artifacts并完成Hash核对，均是审计断言修正而非产品失败。

D08 H Task `98b1c566-cabd-4922-bd34-f8aec9426fa3`，真实首Run只读回答12；仅点击可信检查点按钮，第二Run新Thread，binding generation1 invalidated/validated_context_rollover→generation2 active，两个真实Run均结束，UI再次回答12。Host业务Checkpoint businessCompletionClaimed=false，没有以模型回答关闭业务。S04真实Coding两Run仅选public coding:walk_rule及本Task walk_code；T1/T2私域和personal均未混入，前述真实Chat/Router分域亦通过。

E01 G0创建前预算未确认按钮disabled，确认后active/v1/plan1/预算100000/通知未允许，Host无Goal Task/Run。E02四类负例（非法JSON、自依赖、重复key、未登记Source）均拒绝且无可提交预览。E03预览0→2，关闭重开仍0Task；明确提交后创建两Task，首项queued，依赖项waiting_trigger，目标v2/plan2，无模型。E04替换为draft2单节点，新增/移出ID可见；旧任务保留并paused/阻止派发，暂停目标v4/plan4→恢复v5/plan4，没有重跑旧任务。

E05修订预算为1、确认后Goal v6/plan5暂停旧计划；提交隔离execute_once只读计划后active/v7/plan6。15:41:15Z与15:42:36Z两次只读核对：全局10 Run且全部空闲，本Goal 0 Run，预算1，任务仍queued，排除全局忙导致的假阻塞。随后UI取消Goal，v8/plan7，新旧任务停止且无模型。来源页实际“尚未登记来源”，S01缺配置分支有真实UI结果，真实HTTPS Provider仍不可得。

`checkpoint/M3.manual-route-ui`本体`eab243fb9e6cb50497e259a28a814bf077f75e2a`已推送；远程main/标签均实际核对相同SHA。当前继续E06–E08独立Q目标，然后F后台/恢复与G/S收尾；未运行全量回归。

## E06–E08与D/E收据归档（2026-11-05）

Q Goal唯一真实代码Run5553b7c0结束，实际只改math；假ID拒绝时Goal仍active/v2且0通知。Host固定验证4/4/0后，Agent直接从UI取得b41d3e97并提交，Goalcompleted/v3/plan2，UX-01完整闭环。实际通知52b27941终态failed/providerRef=null，未见OS横幅；不猜失败原因，不改系统权限。发现UX-08：刷新实际记录仅刷新Goal/Task，没有重新读取已选通知；再次点查看任务与通知才显示失败。UX-07假ID通用文字亦保留待F06后修正，防止构建覆盖旧冻结合同。

11笔Run全部completed/finalized，累计归属314,436；C续接121,615为累计快照，减78,720基线后是42,895，未重复累计。未知预留0。P/Q仅math有变更，R无变更，真实代码/Goal收据与Context分域摘要见evidence/M3-manual-code-goal.json。

F02新任务后台排队唤醒已安排16:10Z/queue_only，16:06:03Z原生关闭窗口，此后到期前不做CUA观察，避免activate重新建窗。16:06:40Z只读核对Main94509/Owner12同实例、11Run、schedule active/v1，任务等待触发。初次审计列名next_due_at_ms不存在，按实际schema next_fire_at_ms修正；未写库。旧E06暖关窗时模型已完成，不能作为运行中关窗证据。
