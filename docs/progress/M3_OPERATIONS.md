# M3 本机使用与验收范围

当前检查点 `checkpoint/M3`，实际验收见[M3记录](M3.md)和[Gate](evidence/M3-gate.json)。仅覆盖已锁版macOS arm64本地Electron Main模式。权限管理仍M5；M4尚未启动。

运行时后续改进见[M3.runtime](M3_APPSERVER_RUNTIME.md)。检查连接读取模型目录，不能当作登录/模型调用成功证明；目录、历史和只读核对由Main复用受限App Server连接，每连接初始化一次。首次启动最多等待60秒，索引未就绪按实际提示稍后再检查，不重置索引或重新复制认证。配置/认证身份变更、读取失败、隐私reset会退休旧连接；待清理未完成时不重建。真实任务仍独立进程，停止/验证与Unknown规则保留；关闭窗口保留Main连接，显式退出关闭全部受管进程。

## 主聊天与任务

`pnpm dev` 启动工作台，选择真实注册项目后打开“主聊天”。`/query`直接查Registry，`/note`保存讨论；模型提案有独立草稿与明确任务引用。生成提案会创建真实Run/Intent并消耗模型用量；先检查逐项动作/对象/依赖，再显式提交。创建任务默认排队，暂停/取消和续接分别显示真实结果。结果未知时只核对原标识，不自动改新键重发；纠错保留已完成效果。

项目任务中可读取Host检查点，并明确选择“用可信检查点在新线程继续”。检查点不是模型自称完成；代码任务仍须通过冻结测试，来源/版本/授权变更会拒绝旧检查点。未解决Action/Intent、未知用量与写入占用仍遵守既有核对门槛。

## 记忆与遗忘

记忆不是每条聊天都自动写入。先保存真实来源消息，例如原文 `/remember personal:language = 中文`；再在“目标与记忆 → 记忆 → 从原消息保存记忆”选择来源，提供逐字引用，选择推断或原消息明确确认。只有完整同键指令和原文一致才可标explicit_user。用户修订使用检索结果的“用新消息修订”，绑定新的同键消息与旧Claim版本；旧Evidence保留。

个人、任务、公开编码记忆分域。敏感内容不自动注入。Coding不默认获取personal或别的Task私域；公开用户Coding须刻意选择public、explicit_user及精确 `/remember coding:key = value`。记忆不是工具权限。

遗忘先撤销来源/派生关系与实际运行端，再清理应用管理的文件和SQLite/WAL。它会保守移除本应用的本地备份、演练和旧运行代副本；用户源码/认证保留。查看实际收据，未完成可用相同清理票据继续核对，重开仍可恢复票据。供应商留存、外置备份与系统快照不在本地删除承诺内。

## Goal 与 Source

创建Goal需目标、完成标准与Token预算，通知独立选择。计划JSON可使用 `key/text/dependsOn`；默认queue_only。显式 `dispatch: "execute_once"` 才允许条件满足后由既有Gateway自动领取一次，已有Run/Unknown不会重复领取。编码节点只支持固定 `node-test` 合同的 `target/allowedPaths`；不接受任意验证命令。计划替换先看实际前后差异；旧任务/订阅/Mandate失效。源码有用户终端占用、预算不足、来源/版本过期时不会绕过执行。

Source连接只由Host读取固定 `userData/source-connections.json`（Electron `app.getPath('userData')`），不是Renderer传URL/token。文件必须本机当前用户所有、普通文件/无符号链接、0600；不要把它加入Git。结构为 `format: 1` 与 `sources` 数组，每项包含公开 `binding`（sourceId、bindingRef、allowedActors、selfActor、eventTypes、maxAgeMs）和私有 `connection`（HTTPS url、token）。缺失配置即不启用外部Source，非法配置拒绝加载。

Provider POST请求携带Bearer、sourceId/bindingRef/cursor/nonce及X-Source-Nonce。响应是匹配sourceId/bindingRef的actorRef、events和cursor；每个event含id/threadRef/eventType/occurredAtMs/payload。X-Source-Signature为 `HMAC-SHA256(token, nonce + "\n" + 原始响应字节)` 十六进制。Host保持TLS校验、拒绝跳转/过大响应，校验Actor、范围、时间和重复事件；Source正文始终是untrusted_external数据。actionable投递不自动执行外部动作。验收使用真实自有HTTP Provider，不代表第三方账号已接通。

通知有UTC静默时段、日限额和失败熔断。Goal完成及订阅通知同事务准备，投递另有回执；OS仅实际show事件算已展示，失败或Unknown不冒称成功。当前Gate证明自有鉴权HTTP投递/去重，未证明签名发行后的OS推送送达。关闭窗口Main可继续，显式退出停止；独立Daemon和休眠执行仍未启用。
