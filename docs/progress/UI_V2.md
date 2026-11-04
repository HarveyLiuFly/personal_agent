# 第二版桌面应用开发记录

开始：2026-11-05。用户要求先提交当前，再对照Codex/Claude仔细分析、整理设计并实现验证；无需设计后另等批准。

## 起点与范围

开始前工作区干净，main为86980b12a78b8b8047bba34db02cb800cfed04e3。已先推送checkpoint/UI-v2.baseline，实际ls-remote核对main/标签一致。没有创建空提交或覆盖用户修改。M3走查52通过/1OS通知失败/3HTTPS阻塞/1可选跳过/5等待删除确认的状态保留，不称全部通过；旧不可逆遗忘问题未获确认，不执行。

## UI-V2.design（规划/分析）

已阅读交接、阶段记录和M3专题/Renderer。使用OpenAI Docs核对官方Codex/桌面应用、审阅资料；Claude查阅官方桌面重设计、桌面文档、统一聊天与Projects说明，均实际打开。Codex旧链接重定向、Claude分批Beta已说明。本机CUA只暴露Electron，未伪称竞品账号原生验收。

主要差距：模块入口割裂、双输入不回答、按Run而非Task、底层JSON/ID暴露、资源/备份遮挡内容、目标与记忆手工搬运、深层嵌套滚动及缺少连续草稿。设计见[当前桌面交互专题](../design/08_桌面应用交互设计.md)，含14维差距矩阵、完整主/辅流程、守卫及验收要求。

计划按UI-201壳/导航→UI-202单输入助手→UI-203任务/审阅→UI-204目标/记忆/自动化→UI-205实际验收推进。保留唯一Store/Gateway、最小Intent、Unknown不重发、冻结合同、63项白名单和沙箱；新功能不以样式或合成回答替代。每完成可检视点更新实际证据、提交/推送main并核对SHA。回归只做增量。

当前未修改产品代码、未运行新检查或新模型请求；设计落盘后立即实施，不等待额外批准。

## UI-V2.implement（执行中）

已实现：紧凑应用壳/自动目录连接、任务聚合/搜索、页面内单输入助手、任务连续消息与安全正文呈现、默认折叠执行过程、内联Diff/真实验证、同屏文件面板、会话内隔离草稿、目标可读计划行与真实收据完成、直接来源化记忆保存/修订、自动化快捷时间、备份归设置。保留原63白名单与Store/Gateway；没有新增通用RPC或弱化沙箱。

初次TS发现useRef初值、可选能力字段及complete命令多余字段，修正后TS/生产构建通过。受影响组件89/89（含初始6项新UI守卫）通过；追加异步生命周期后9/9 UI专项通过，重叠不相加。17项设计合同通过，未跑全量。

真实原生CUA已在Sculptor完成：新档案自动连接、真实OpenPanel打开ui-v2-code、默认助手可输入；Shift+Enter换行未发送；助手/新任务草稿往返保留；保存待办无Run，Task仅queued；Cmd+K聚焦搜索；普通表单保存personal:ui_v2_preference并用新确认来源修订为v2，Host只读确认两版/explicit_user与真实原消息，0手抄来源/记忆键前缀。

首个真实Router Run601a72be已completed，提案单CHAT但没有自动进入Chat，暴露Host异步返回proposing而非等待最终提案的合同差异。修复为本次用户发送内只读等待同一份已启动提案、严格单CHAT才提交；不从全局轮询/重开提交历史提案。新增测试覆盖等待/超时/离页/Unknown/混合操作；原失败提案保留、未重放。原生冷重开后原提案仍待确认，证明重开没有自动提交。随后另一次明确UI发送正在复验，真实请求逐笔继续登记。

原生工具最初选到另一个空Electron默认窗口，只读PID确认测试Owner正常，关闭该空默认窗口后正确绑定独立UI V2。目录GoTo的paste不生效，改用原生typeText并核对实际路径再打开；不将输入尝试当成功，不归档私有Downloads列表。专用测试Profile/源码/原始日志均在.local/系统临时目录，不加入Git。

UI-V2.core本点完成：本次发送生命周期修正后，原生一次Enter实际自动接续独立Chat，回答8+4=12并引用v2偏好。原首轮提案重开仍待确认，0自动提交。当前3笔真实请求全部completed/finalized，归属报告45,432 Token，Unknown预留0；逐笔角色/策略Hash见evidence/UI-V2-core.json。最终92/92受影响组件、TS/构建/17合同通过。辅助旧合成GUI探针已迁移导航/模式/续接选择器但本轮未执行，不计为通过。下一步以当前构建冻结真实代码合同，完成UI-204/205原生验收；本点不称完整V2 Gate通过。

## UI-V2.goal-flow：原生续接缺口与修复中

可读Goal表单/计划行在真实Q项目完成：预览时Goal0Task且全局3Run；明确选择代码范围和“计划生效后执行一次”并提交，唯一Task8187e76f/Run c9269eb0自动执行，模型只将math减号改为加号，结束为needs_review，尚未称独立验证完成。

原任务输入框直接续接产生Run043defed，但在verification_contract阶段RUN_GRANT_EXPIRED，实际0 Intent/0 native policy event/0 Thread或Turn派发，原生UI保留Unknown并阻止再发。只读核对未擅自改状态。根因是beginContinuation的INSERT没有写goal_plan_version；首Run为2、续接为NULL，而Goal仍active/plan2。新增实际SQLite/Node/stdin受控服务器回归先失败，实际重现同错误；修复为准入前检查当前Goal计划且续接Run继承计划版本，不修补旧Run、不放宽授权/Verifier Hash。

增加受支持的显式只读核对：仅历史“Goal续接+缺计划版本+RUN_GRANT_EXPIRED+0任何Intent/0服务请求+当前Task Fence和隐私策略一致”可依据本地未发送事实确认为failed/0用量，保留原NULL和审计；任何Intent、其他错误或策略变化均保持Unknown，不发模型、不修复旧资格。普通历史核对不变。隔离历史Fixture模拟原缺口，不写当前走查库。49/49受影响预算/核对/续接/新UI用例及TS通过，新增计划继承回归原失败收据保留。

原生实测同时暴露两处显示缺口：Task请求在Context wrapper内仍有第二层JSON；运行中代码任务输入区错误显示只读。已补精确识别Host Task请求文本的呈现测试与真实状态显示；不改变提交正文。此时原代码合同已冻结，不绕过校验继续旧构建；下一构建需让原失败记录经UI显式核对、取消原演练Goal保留其历史，并在仍有公开故障的R项目重新验证完整Goal/续接/验证链。Q源码保持真实修复结果，不重置或改旧验证Hash。

修复后原生显式点击“核对执行结果”，原043defed保持0Intent/原计划NULL，确认为failed/RUN_NOT_SENT，两桶预留均按0结算；没有新Run、Thread、Turn或资格修补。旧Q演练Goal随后由UI取消，源码修复和原失败历史保留。

R新独立Goal复走完整通过：可读行编辑/预览/明确一次执行→80d8965d真实代码→原任务输入直接续接1321dce1，同Thread/不同Turn，12项冻结字段全部一致、两个Run均plan2。Host独立验证dd2918a2实际4发现/4执行/0跳过/passed，Artifact Hash一致，Task才completed；点击“核验并完成目标”直接完成Goal，无JSON编辑/复制ID。当前7个Run记录，其中1个已证明未发送、6个实际模型Turn；归属报告241,622 Token，Unknown预留0。证据evidence/UI-V2-native-goal.json；新的失败不被旧Gate或模型自述替填。

132/132相关组件最终联合批次通过（不是全量）；上一49批次与其重叠，不相加。后续仅做辅助页面和布局检查，不再发送模型。原生过程还发现Run结束标题可能显示“已完成”，已改成代码“待验证”/只读“已回复”，仅可信Task completed显示“已验证完成”，有新增呈现负例；Goal计划差异改为标题而非UUID。待类型/构建与原生辅助页复验，完整V2交付尚待收尾。

UI-V2.goal-flow本点完成。修复与原生完整业务证据已落盘，最终TS/构建/11项UI呈现专项通过（与132批次重叠）；代码已验证任务不再提供新任务模式或误用续接，明确本地未发送失败显示新建后续入口。继续辅助页、文件并置、布局和最终无重发审计，不再新增模型。UI-V2.core提交4df7ca30156e8018fd9af9121ed54b406822b360已实际推送，远程main/对应标签核对一致。
