# DSH Conductor：后台常驻与 TUI 兼容计划

状态：已完成（2026-11-04）。基线提交：`162d691`，计划定档提交：`6541210`。项目名称采用 **DSH Conductor**，主包 `dsh-conductor`。

## 必须实现的行为

用户在 dsh-tui 中指挥专用 Host，Host 识别、拆分和路由任务；每个 Worker 继续受 workers.json 中的并发与能力白名单约束。退出、关闭、断开 TUI 均不得取消 Host 或 Worker。再次连接后能看到同一任务、报告和 Host 对话。

## 结构决策

- **编排核心**：保留现有持久化任务图、调度器、Session 工厂与报告闭环，去除 webServer 硬依赖。公开稳定的任务服务，适配器不直接操作 SQLite 或内部对象。
- **daemon**：独立 DSH profile 加载核心与 daemon 入口，拥有唯一 Runtime 和 stateDir 锁。提供版本化 loopback HTTP API、认证和状态/对话更新订阅。连接信息保存在 stateDir；TUI 只读连接信息，不打开数据库。服务关闭与客户端断线是不同事件。
- **Web**：独立可选入口保留旧管理路由和界面；没有 webServer 时核心仍可运行。
- **TUI**：单独的轻量 bundle `dsh-conductor-tui`，只安装客户端适配器，不在 TUI 进程中创建 Runtime。使用 dsh-commands 注册 `/conductor`；使用 tuiCommandTrees 补全；全屏 scene 提供 Host 对话、任务/Worker 总览和指令输入；状态行与实验性侧栏作为可用时启用的增强。使用宿主 React/UI。
- **其他客户端**：复用公开客户端和版本化 API，无需安装完整 TUI 或访问模型工具。

## 接口与生命周期

1. API 返回 Host ID、健康状态、Worker 目录、任务图及 Host 对话快照。输入有结构校验、错误码和请求 ID；模型输入使用现有去重投递通道。
2. 提供 Host 发言/追加指令，以及任务查看、提交、追加、修改、指挥、取消、重试接口。修改操作保留任务 revision 检查和既有授权边界。
3. 提供事件订阅和重连快照；连接中断不会调用 agent.cancel、Runtime.stop 或 daemon shutdown。
4. HTTP 仅监听 127.0.0.1；所有 API（包括读取和事件流）均校验随机 bearer token。拒绝浏览器跨源请求与不正确 Host；令牌不写入日志。发现文件原子写入，停止时仅移除本实例的文件。
5. CLI 提供 start/status/stop 和前台运行说明；后台启动采用 detached 子进程与文件日志，Windows 隐藏窗口。stop 为显式操作，按既有 Runtime 流程优雅停止并持久化。
6. 前台 Host 对话位于 Conductor scene；普通 TUI 会话与专用后台 Host 明确区分。`/conductor say ...` 也可直接发送指令。不通过默认开启的全局输入拦截劫持普通会话。

## 实施顺序

| 阶段 | 交付 | 验收 |
| --- | --- | --- |
| 1 | 名称、打包入口与核心/Web 解耦 | 无 webServer 可启动；现有 Web 使用不退化 |
| 2 | 稳定任务服务、认证 API、客户端与事件更新 | 真正 HTTP 请求覆盖权限、校验、去重、任务 revision 与断线行为 |
| 3 | daemon 管理 CLI 与独立 profile 示例 | start/status/stop 可用；客户端退出后 daemon PID 和任务持续存在 |
| 4 | TUI 独立 bundle、命令、scene、状态与可选 panel | 本机 dsh-tui 加载；Host 输入/状态/任务操作可用；客户端可重连 |
| 5 | 完整检查、进程验证和操作文档 | typecheck、测试、build 通过；记录实际版本、命令、结果和限制 |

## 验证要求

- 重点验证后台与客户端生命周期隔离、无认证拒绝、跨源拒绝、revision 冲突、Host 输入去重和事件流重连。
- Worker 普通工具/MCP/Skill 白名单及关闭 Session 的拒绝行为必须保留回归验证。
- 真实 daemon 验证：连接客户端、提交任务/指令、断开客户端、确认后台继续、重新连接看到原状态、显式 stop 后释放锁。
- 真实 TUI 注册与命令验证优先使用隔离 profile，保留用户已有 tui profile 与配置。
- 完成后在本文件记录里程碑结果；部署、安装与日常操作写入独立使用文档。

## 边界

首版是用户会话内的独立后台进程；系统重启后可通过 start 恢复持久化任务。不默认安装 Windows 服务或计划任务。Worker 配置修改继续按现有规则重启加载；TUI 内编辑必须校验后保存，不能扩大正在运行的实例权限。

## 验收记录

- 阶段 1–5 已实现：核心去除 webServer 硬依赖，Web 可选；独立 daemon profile 持有 Runtime，独立 TUI bundle 只连接服务。CLI、认证 HTTP/SSE、发现文件、任务修改和重连均已落地。
- Windows 本机使用 DSH `0.2.1-rc.5`、dsh-tui `0.18.0` 和隔离的 `conductor-e2e` / `conductor-tui-e2e` profiles 验收，用户原有 tui profile 未修改。真实 `/conductor` scene、Host 指令及模型回复可用；Host 根据自然语言实际调用 task_submit，分配 backend-coder，执行写文件并汇报。
- **关闭整个 TUI 后继续执行**：daemon PID `547104`；图 `graph-5216110f-d13c-4839-8d11-11331d89a0d4` 于北京时间 14:06:07 提交。14:06:12 TUI 已正常退出，任务仍为 running，daemon PID 相同。Worker 的 90 秒后台 pwsh 命令完成后读回 `after-exit.txt`，14:07:59 报告 completed；独立客户端读回内容严格等于 `CONDUCTOR_AFTER_TUI_EXIT`，PID 未变。证据保存在本机 `.artifacts/detach-evidence.json`，不含连接令牌。
- 客户端连接关闭不会调用取消；真实 HTTP 测试还覆盖 POST 接收后断开连接继续完成、SSE 重新订阅、daemon 更换实例/令牌后自动发现。显式 stop 使用 DSH appExit 优雅退出，随后 start 可重新取得目录锁。
- 最新构建再次启动 daemon 和 TUI 后，恢复同一 Host ID、原对话以及两张 completed 任务图；中文长文本换行和 composer 可用。任务侧栏在隔离验收进程模拟的 140 列终端布局下显示 Host 状态、Worker 与两项完成任务，80 列终端使用全屏 scene 和命令。侧栏遵循宿主分栏与面板设置。
- `pnpm check`：类型检查通过，60 个测试文件通过、2 个 POSIX 专用文件跳过；1193 项测试通过、39 项因原 POSIX shell/tmux/Unix 权限条件在 Windows 跳过。构建包含核心、CLI、公开客户端与独立 TUI 包。POSIX 环境继续执行这些旧集成测试，本次未在 POSIX 上实测。
- 使用文档另行定档；首版单行 composer、有限对话快照、完整状态快照推送及手动系统重启恢复的边界保持上述约定。
