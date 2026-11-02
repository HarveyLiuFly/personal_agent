# Personal Agent

Electron/React 桌面宿主，通过锁版 Codex App Server 驱动执行。当前开发 M0；完整聊天工作流、个人记忆与长期自治按阶段交付。

- [总体规划与技术专题](docs/design/00_总体架构与开发规划.md)
- [M0–M5 进展点与同步规则](docs/progress/README.md)
- [当前 M0 执行记录](docs/progress/M0.md)

## 环境与依赖

Linux x86_64、Node 24.19.x、pnpm 11.25.0；使用 Codex CLI 0.163.0，二进制与生成协议指纹见 `codex-version.lock.json`。

```bash
pnpm install --frozen-lockfile
pnpm exec install-electron
pnpm protocol:verify
pnpm check
pnpm dev
```

Electron 45 使用显式安装器下载运行时；安装器保留官方发行包校验。图形启动需要有效 DISPLAY/桌面环境。当前安全窗口启用 Context Isolation、Renderer Sandbox、CSP 与白名单 Preload；不使用关闭沙箱的启动参数。

## M0 调试

```bash
pnpm smoke:codex
pnpm setup:headless # 无 DISPLAY 的 Debian 13 x86_64 云环境
pnpm smoke:desktop
```

`smoke:codex` 使用现有受支持的 Codex 登录执行一次有界、只读、无工具的真实模型请求；结果写入 `docs/progress/evidence/`，失败不会被当作通过或自动重发。受限云环境需要允许启动本地子进程与访问既有代理的执行上下文。

运行状态写入独立 `sqlite_home/log_dir`，认证仍由 Codex 支持的路径处理，不复制 Token。`.local/`、依赖和构建输出不进入 Git。每次进展点完成后，先更新文档和证据，再提交、推送并同步提交号。

协议升级需重新审查二进制/Schema 指纹和契约结果；生成目录由 `pnpm protocol:generate` 管理，禁止手改类型。

`smoke:connection` 只运行原生握手与模型目录查询，不发起推理。`smoke:desktop` 无 DISPLAY 时使用带 Xauthority 的本地 Xvfb，并在结束后回收显示进程；保留 Electron 沙箱。`setup:headless` 只在 `.local/` 内解压四个锁版 Debian 包，首次下载使用官方签名索引和固定 SHA-256，不需要 sudo。缺少其他系统动态库的平台仍需先准备相应依赖。
