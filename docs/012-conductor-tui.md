# DSH Conductor：daemon 与 TUI 使用说明

本实现遵循 [011 计划](011-conductor-tui-daemon-plan.md)，保留 [009 Worker 配置](009-worker-orchestration.md) 的任务图和能力白名单。Host 和 Worker 属于独立 daemon；TUI 是可以随时退出和重连的客户端。

## 运行结构

```text
dsh --profile tui
  dsh-conductor-tui（命令 / scene / panel / 状态）
             │ 认证 HTTP + SSE，127.0.0.1
dsh --profile conductor（独立后台进程）
  ConductorService → Host → TaskRunner → Worker Sessions
                            │
                   stateDir / SQLite / workers.json
```

TUI 不创建 Runtime、不直接读写 SQLite，也不会在卸载时调用 shutdown。一个 stateDir 只能有一个 Runtime；每个客户端从发现文件连接同一个实例。Web 管理适配器只在存在 webServer 时加载。

## 安装后台 Host

需要 Node.js 22.19+ 或 24+、pnpm，以及已配置模型的 DSH。实测 DSH 0.2.1-rc.5 / dsh-tui 0.18.0，开发依赖为 DSH 0.2.1-alpha.2。以下 PowerShell 命令从本仓库执行，路径按实际位置替换：

```powershell
pnpm install
pnpm build
node lib/cli.js init --state-dir D:/Data/dsh-conductor --profile conductor
node lib/cli.js start --state-dir D:/Data/dsh-conductor --profile conductor
node lib/cli.js status --state-dir D:/Data/dsh-conductor
```

`init` 创建全新的 `~/.dsh/profiles/conductor`（遵循 `DSH_HOME`），写入核心 bundle、daemon 开关和 stateDir，然后安装 profile 依赖。默认复制 Coding Worker 模板；使用 `--workers <JSON路径>` 可选其他模板，例如 `examples/workers.security.json`。它不会覆盖已有 profile 或 workers.json。模型使用 DSH 的配置与凭据，Worker 可通过自己的 `model` 字段指定模型。

审核 `<stateDir>/workers.json` 后再发送任务。角色数量由 `profiles` 决定，实例并发由 `maxInstances` 决定；工具、MCP、Skill 未配置即不授予。模板不授予 shell；需要执行命令时添加本机已安装的 `pwsh` 或 `bash`，以及需要的 `job_output`、`job_list`、`job_kill`。配置变更通过 `stop` / `start` 加载。

`start` 使用 detached 子进程，stdin 断开、stdout/stderr 写入 `<stateDir>/daemon.log`，Windows 隐藏进程窗口。因此启动命令退出或终端关闭不会终止 Host。若自动查找 DSH 失败，给 `init` / `start` 加 `--dsh-bin <DSH安装目录/lib/bin.js>`。需要前台诊断时使用 `dsh --profile conductor`，此时由前台进程持有 Host。

```powershell
node lib/cli.js say --state-dir D:/Data/dsh-conductor "检查输入，将任务分配给合适的 Worker，并报告完成结果。"
node lib/cli.js tasks --state-dir D:/Data/dsh-conductor
node lib/cli.js stop --state-dir D:/Data/dsh-conductor
```

只有显式 `stop`、停止 daemon 进程或系统退出才终止本次执行。关闭时保留任务和 Session，重新 `start` 恢复；这不保证跨进程崩溃的外部副作用恰好执行一次。系统重启后需再次启动，首版不安装系统服务或自启动项。强制终止后，目录锁最多需要约 30 秒才判定过期；先确认旧进程已退出，再启动。

## 安装 TUI 客户端

先构建本仓库。向现有 TUI profile 的 package.json 增加 `dsh-conductor-tui` 依赖，并在 bundles 中追加同名 bundle，保留原有内容。一个完整的最小示例是：

```json
{
  "name": "dsh-profile-conductor-terminal",
  "private": true,
  "dependencies": {
    "@deepseek-harness-tui/dsh-tui": "0.18.0",
    "dsh-conductor-tui": "link:D:/Work/dsh-superagent-prototype/packages/tui"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-harness-tui/dsh-tui",
        "dsh-conductor-tui"
      ]
    }
  }
}
```

TUI profile 安装的是 `packages/tui` 中的独立包。完整核心 bundle `dsh-conductor` 只加载到后台 profile，避免 TUI 内启动第二个 Host。首次构建会生成独立的 `packages/tui/lib/tui.js`，客户端使用宿主 React。

在 TUI profile 的 `cordis.patch.yml` 中追加：

```yaml
- id: dsh-conductor-tui
  config:
    stateDir: D:/Data/dsh-conductor
```

也可通过环境变量 `DSH_CONDUCTOR_STATE_DIR` 提供该目录。然后安装并启动该 TUI profile（以下使用名字 `tui`）：

```powershell
dsh plugin --profile tui install
dsh --profile tui
```

TUI 需要 DSH backend，以及 commands、tuiScenes、tuiCommandTrees、tuiStatus、tuiPanels 服务。本版以 dsh-tui 0.18.0 的接口实现，其他 TUI 可复用客户端 API 编写自己的展示层。它附带 Community 0.15 manifest，声明 `dsh.conductor` 命令贡献和权限；已接纳组件使用宿主管理的注册方式，旧 bundle 激活方式使用官方 commands 注册表。

## 在 TUI 中操作

| 输入 | 行为 |
| --- | --- |
| `/conductor` 或 `/conductor host` | 打开后台 Host 对话 |
| `/conductor say <内容>` | 直接向 Host 发送指令 |
| `/conductor status` | Host、Worker 数量和任务图概况 |
| `/conductor tasks` | 任务图、任务状态、Worker 分配 |
| `/conductor workers` | 角色、并发、工具/MCP/Skill 白名单 |
| `/conductor inspect <graph>` | 查看完整任务图、依赖与报告 |
| `/conductor instruct <graph> <task> <内容>` | 向运行中的 Worker 追加指令 |
| `/conductor cancel <graph> [task]` | 显式取消图或单个任务 |
| `/conductor retry <graph> <task>` | 重试失败/阻塞任务 |
| `/conductor panel` | 打开任务侧栏 |

在 Conductor 对话中，普通文字发给 Host；`/tasks`、`/workers`、`/inspect` 等是本地控制命令。PgUp/PgDn 查看历史；Esc 返回 TUI。Host 对话只展示用户输入和模型文本，任务报告可在任务图中查看。状态行和 panel 随服务推送更新，`/tasks` 等命令结果为执行时的快照。首版 composer 为单行输入，不提供完整编辑器或模型 token 流式渲染。

侧栏遵循宿主的显示设置：在 `/settings` 启用分栏和 Conductor tasks 面板，并保证内容区域至少 93 列（建议终端宽度 120 列以上）。`/conductor panel` 成功表示打开请求已交给宿主；宽度不足或面板未启用时宿主会隐藏它，此时仍可使用全屏 `/conductor` 和 `/conductor tasks`。

普通 TUI 聊天仍使用其自己的 Session。Conductor 输入默认以 steer 投递，Worker 在 DSH 的下一个步骤读取新指令；当前正在执行的工具不会因为新消息而强制中断。任务修改包含图 revision；冲突会拒绝并要求刷新。

退出 Conductor scene、关闭 TUI 或网络断开均只解除客户端连接。重新打开后会拉取最新状态；daemon 重启时客户端重读发现文件，适应新端口和新令牌。Host 对话快照保留最近 100 条文本，每条最多 20,000 字符，完整历史由 DSH Session 持久化。

## 其他客户端和 API

```typescript
import { ConductorClient } from 'dsh-conductor/conductor-client'

const client = await ConductorClient.connect('D:/Data/dsh-conductor')
const state = await client.state()
await client.act({
  type: 'host.say', requestId: crypto.randomUUID(), text: '继续处理当前任务'
})
const subscription = new AbortController()
const watching = client.watch(next => console.log(next.host.status), subscription.signal)
// 只断开订阅，后台工作继续。
subscription.abort()
await watching.catch(() => {})
```

| 路由 | 作用 |
| --- | --- |
| `GET /v1/state` | Host 对话、Worker 目录、完整任务图、健康状态 |
| `GET /v1/events` | SSE 初始完整快照，后续变更合并推送 |
| `POST /v1/actions` | Host 输入和任务命令 |
| `POST /v1/shutdown` | 显式请求 daemon 优雅退出，body 为 `{}` |

`actions` 支持 `host.say`、`task.submit`、`task.add/update/instruct/cancel/retry`；完整结构以 `src/conductor/protocol.ts` 为准。输入与提交用 requestId 去重；同一 ID 使用不同内容返回 `REQUEST_CONFLICT`。任务修改要求 expectedRevision，不匹配返回 `REVISION_CONFLICT`。请求 body 上限 256 KiB，客户端 SSE 单个缓冲上限 8 MiB，最多 32 个事件订阅；首版每次推送完整快照，适用于本地规模任务。

发现文件 `<stateDir>/conductor-daemon.json` 包含端口、PID、实例 ID 和随机 bearer token。所有端点均需认证；服务拒绝 Origin、Sec-Fetch-Site 和不匹配的 Host，只监听 IPv4 loopback。该文件是本机访问凭据，勿提交或共享。POSIX 创建模式为 0600；Windows 继承父目录 ACL，应使用当前用户自己的 stateDir。

## 项目更名与验证

本版包名、bundle 行 ID、presets 和 Skill 名使用 `dsh-conductor`。从旧原型迁移时先停止旧进程、备份 stateDir 和 DSH Sessions，再更新 profile 依赖、bundle 和 overlay 行 ID；持久化数据库仍为 `orchestrator.sqlite`。旧 Session preset/Skill 名不会自动迁移，首次部署推荐新 profile 和 stateDir。历史 `DSH_SUPERAGENT_*` Worker 环境变量继续保留，避免破坏已有执行脚本。

`pnpm check` 包含类型检查、全部适用测试和构建。Windows 跳过依赖 POSIX shell、tmux/ps、Unix 文件权限的旧集成测试，保持其在 POSIX 上执行。后台传输测试使用真实 HTTP/SSE，覆盖所有端点的认证、伪造来源、请求断开、重新发现、任务版本冲突和请求去重。真实模型、真实 TUI、后台任务退出后完成的验收记录见 011 计划。
