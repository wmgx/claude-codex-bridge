# claude-codex-bridge

让 Claude Code 出方案，Codex 或 Antigravity（`agy` / Gemini 模型）去做。Claude 直接开线程、派活，执行端做完或有疑问时事件会自动推回 Claude，两边在**同一个线程**里来回沟通。

> 与 OpenAI、Anthropic、Google 无关联。Codex 是 OpenAI 的产品，Claude Code 是 Anthropic 的产品，Antigravity (`agy`) / Gemini 是 Google 的产品。

每轮派单的规格格式、执行端的决策权限和 Claude 的验收要求见[协作规范](skills/delegate/COLLABORATION.md)。

## 双执行端支持

| 执行端 | 参数 | 底层机制 | 长跑保活（跨 30 分钟 Monitor） | 实时旁观 (`observe`) |
|---|---|---|---|---|
| **Codex**（默认） | `--agent codex` | Codex 官方 `app-server daemon`（Unix socket） | 原生支持 | 支持（`codex resume <ID> --remote unix://`） |
| **Antigravity (`agy`)** | `--agent agy` | 自建常驻 `agy-daemon`（Unix socket）托管 `agy acp --sandbox` | 支持（含 `watch` 补发轮次与挂起审批） | 不提供 |

## 命令

| 命令 | 作用 |
|---|---|
| `start <cwd> <text> [--agent codex\|agy] [--name N] [--max-quiet M] [--model X] [--effort E] [--no-network] [--once] [--timeout S]` | 开线程，发第一轮；默认持续输出事件（Claude Monitor）；加 `--once` 自动后台托管监听，收到下一条需处理事件即退出 |
| `watch <thread> [--agent codex\|agy] [--max-quiet M] [--idle-exit M] [--once] [--timeout S]` | 重新订阅已有线程的事件；补发上次上报之后完成的轮次，已上报的不重放 |
| `send <thread> <text> [--agent codex\|agy] [--model X] [--effort E] [--wait] [--timeout S]` | 在同一线程继续发一轮；加 `--wait` 自动确保后台监听并等到下一条事件即退出 |
| `wait <thread> [--agent codex\|agy] [--timeout S]` | 等待线程的下一条需处理事件（如 `approve` 后继续等 `turn_completed`）并立刻退出 |
| `stop <thread> [--agent codex\|agy]` | 停止线程的后台监听进程（不删除线程历史） |
| `approve <thread> <id> [--session]` / `deny <thread> <id>` | 回应审批请求 |
| `status <thread> [--agent codex\|agy]` | 查执行端是否还活着：返回 `agent`、`ok`、`problems`、`daemon`、`thread` 状态、`running`、监听进程 pid 及 `pendingApprovals`。只读，不会拉起 daemon |
| `models [--agent codex\|agy\|all]` | 列出可选模型，以及每个模型支持的思考深度（`efforts`）和默认值 |
| `list [--agent codex\|agy\|all]` | 列出 claude-codex-bridge 开过的线程（默认聚合两个后端） |
| `history <thread> [--limit N]` | 最近几轮的提问与汇报 |
| `rename <thread> <name>` | 改名 |
| `daemon stop <codex\|agy>` | 停止指定执行端的本地常驻 daemon |
| `doctor [--agent codex\|agy\|all]` | 检查依赖与沙箱就绪状态 |

`<thread>` 可以是线程 ID，也可以是 `start` 时起的名字。本地注册表（`~/.local/state/claude-codex-bridge/threads.json`）会记住每个线程所属后端，后续 `watch`/`send`/`approve`/`deny`/`status`/`history`/`rename` 无需重复传 `--agent`。

`start` 和 `send` 的 `<text>` 可以换成 `--file <路径>`，从文件读文本。方案较长或带引号、反引号、`$` 时用它，避免 shell 转义出错。

`--model` / `--effort` 不给时沿用执行端默认设置；给了之后，后续轮次都沿用，直到再次指定。可选值用 `models --agent <codex|agy>` 查。

同一个线程同时只允许一个监听进程（`start` 或 `watch`）：已有一个在跑时，再 `watch` 会报错并给出它的 pid。

## 事件

事件由后端 daemon 主动推送，不是轮询。每个事件一行 JSON，均带 `agent`（`codex` / `agy`）：

| event | 含义 |
|---|---|
| `started` | 线程已创建，带 `agent`、`threadId`、`name`；Codex 还会带 `observe` 旁观命令 |
| `turn_completed` | 一轮结束，`text` 是执行端的最后一条消息（汇报或提问）；若底层实际模型发生变化还会带 `actualModel` |
| `approval_requested` | 执行端请求越权操作，带 `requestId`、`command` / `grantRoot`、`cwd`、`reason` |
| `approval_resolved` | 审批超时，已自动拒绝。正常的批准或拒绝不上报 |
| `heartbeat` | 太久没有唤醒 Claude，发一个事件让它的缓存续期；执行端不受影响，仍在跑 |
| `codex_lost` / `agy_lost` | 一轮正在跑时执行端异常退出，不会再有结果。带 `turnId`、`status` 及 `detail` 诊断信息 |
| `approvals_dropped` | 连接断开重连后，旧连接上未决的审批请求失效，带 `requestIds` |
| `error` / `closed` / `unsupported_request` | 出错、结束、收到不支持的请求 |

每输出一个事件，Claude 就被唤醒一次、重读一遍上下文，所以只上报需要它处理的事：正常的批准或拒绝、重连成功都不出声。

## 权限、沙箱与自审核

### Codex：原生 auto 模式
线程固定为 `workspace-write` 沙箱 + `on-request` 审批 + `auto_review` 审查者：
- 沙箱内（线程工作目录、系统临时目录）操作直接做；默认打开网络，不需要联网时加 `--no-network`。
- 越出沙箱的请求先交给 `auto_review` 子代理按风险判断；仍落到用户这边的请求才发 `approval_requested`，10 分钟无人回复自动拒绝。

### Antigravity (`agy`)：原生沙箱 + Auto 模式 + 四段安全漏斗
`agy-daemon` 以 `agy acp --sandbox` 启动子进程（刻意不暴露 ACP fs/terminal 代理能力，工具始终在 `agy` 原生终端沙箱内执行）：
- **Layer 0（原生 OS 沙箱）**：macOS 使用 `sandbox-exec`（Seatbelt），Linux 使用原生 Kernel Namespaces（免 Docker）；限制写入到工作目录和临时目录，原生屏蔽 `~/.ssh`、`.env` 等敏感文件，默认限制出网。
- **优先原生 `Auto` 模式**：建会话后自动协商激活 `auto` 模式；激活后，凡 `agy` 主动升级到 `agy-daemon` 的请求都视为需要人工拍板（除硬拒绝外直接转 `approval_requested`，不削弱原生边界）。
- **回退四段安全漏斗**（当账号/环境回退到 `default` / `accept-edits`，或显式设置 `BRIDGE_AGY_POLICY_MODE=bridge`）：
  1. **硬拒绝 / 强转人工**：毁灭性命令（`rm -rf /`、`dd of=/dev/...` 等）直接拒绝；敏感凭据路径、越界写文件、`git push`、`sudo`、数据外传与混淆管道强制转 `approval_requested`。
  2. **防绕过静态白名单**：仅放行无 shell 拼接元字符（`;`/`&&`/`||`/`|`/`$()`/反引号/`>`）的单条安全只读/测试命令，以及工作区内常规读写；可在 `~/.config/claude-codex-bridge/agy-policy.json` 扩展 `denyCommands` / `askCommands` / `allowCommands`（优先级 `Deny > Ask > Allow`）。
  3. **隔离自审核（fail-closed）**：灰区请求交由无工具、独立上下文的轻量评审模型判断（优先使用 `GEMINI_API_KEY` 直调 `gemini-2.5-flash`，否则回退到隔离临时目录的只读 `agy --mode=plan -p`；可用 `BRIDGE_AGY_AUTO_REVIEW=off` 关闭）。任何超时、异常或非法 JSON 一律安全降级为 `ask_user`。
  4. **审计日志**：所有权限决策均按 JSONL 记入 `~/.local/state/claude-codex-bridge/<threadId>/audit.jsonl`（权限 `0600`）。

> **合规与认证提醒**：Google 对个人消费者 OAuth（`oauth-personal`）在第三方外层自动化编排中的使用条款（Antigravity Terms Section 6）限制较严；长期程序化/桥接场景请务必留意账号条款与限流政策。

## 非 Monitor 宿主用法（如 Antigravity）

在没有逐行 stdout 唤醒（`Monitor`）的宿主里（如 Antigravity 后台任务），可使用一次性等待模式，实现零轮询、事件一到立刻退出唤醒，且审批不掉链：

```bash
# 1. 开线程并等第一条需处理事件（turn_completed / approval_requested / codex_lost）即退出
bun scripts/bridge.ts start <目录> --file <方案文件> --agent codex --name task-1 --once

# 2. 若返回 approval_requested，经用户确认后 approve，再继续 wait 等本轮结束
bun scripts/bridge.ts approve task-1 <requestId>
bun scripts/bridge.ts wait task-1

# 3. 追加指令并等下一条事件即退出
bun scripts/bridge.ts send task-1 "补充修改 X" --wait

# 4. 任务结束，清理后台托管监听进程（默认空闲 60 分钟也会自动退出）
bun scripts/bridge.ts stop task-1
```

后台监听进程会持续持有与 daemon 的 WebSocket 连接（Codex 审批不会因前台退出而失效），并把每条事件带自增 `seq` 落盘到 `events.jsonl`，前台通过 `wait-cursor` 按序消费，不会漏事件。

## 缓存心跳：避免 Claude 缓存过期

Claude 每被唤醒一次，它的 prompt 缓存有效期就从头算。静默太久缓存会失效，下一个事件把它唤醒时要按全价重读整个上下文。

所以执行端一轮跑得很久时，bridge 会在缓存失效之前输出一个 `heartbeat` 事件，把 Claude 唤醒一次让缓存续期。**心跳不中断执行端，也不需要问用户**，Claude 收到后什么都不用做。

`--max-quiet <分钟>` 控制最长静默时间，默认 50（按 1 小时缓存有效期留余量），`0` 表示不发心跳，可以是小数。缓存有效期是 5 分钟的会话建议设成 `4`。

## 保活

- 连接断开自动重连（指数退避，最长 15 秒一次，10 分钟放弃）。重连成功不上报，放弃时输出 `closed`。
- 每 30 秒探活一次，连接静默死掉也能发现。
- 最后上报到哪一轮记在状态目录里。重连或重新 `watch` 后，补发这之后完成的所有轮次，不重复上报。
- `agy-daemon` 在 Monitor 换班空档期间会保留挂起中的审批请求，新 `watch` 连上后立即补推，避免审批丢失；线程空闲 2 小时回收子进程（下次 `send` 自动 `session/resume` / `session/load`），全空载 4 小时自动退出。

## 安装

**1. 准备依赖**

- [Bun](https://bun.sh) >= 1.4（需要 `ws+unix://` 支持）。已装的用 `bun upgrade` 升级。
- 按需安装执行端 CLI：
  - **Codex**：安装 Codex CLI 并登录（`codex login`）。
  - **Antigravity (`agy`)**：安装 Antigravity CLI 并登录（`agy acp --login`），确保 `agy` 在 `PATH` 中。

**2. 安装插件**

在 Claude Code 里添加本仓库为插件市场并安装，然后重启 Claude Code：

```
/plugin marketplace add wmgx/claude-codex-bridge
/plugin install claude-codex-bridge
```

**3. 自检**

对 Claude 说"自检一下 bridge"，或直接运行 `bun scripts/bridge.ts doctor`（也可加 `--agent codex` / `--agent agy` 单独检查）。

脚本会在需要时自动拉起对应的本地常驻 daemon，不用时可用 `bun scripts/bridge.ts daemon stop codex` 或 `bun scripts/bridge.ts daemon stop agy` 停掉。

## 旁观 Codex 在做什么

仅 Codex 线程支持多端实时旁观：
- `codex agents`：浏览 daemon 上的所有会话，bridge 开的显示为 `[bridge] <名字>`。
- `codex resume <线程ID> --remote unix://`：连到同一个 daemon 实时观看。只看，不要在旁观窗口发消息或批审批。

`agy` 线程按设计不提供实时 TUI 旁观，可通过 `~/.local/state/claude-codex-bridge/<threadId>/audit.jsonl` 查看权限审计记录，或用 `bridge history <线程>` 查看每轮汇报。

## 安全

- 只连本机 Unix socket（目录 `0700`、socket/文件 `0600`），不监听 TCP 端口、不读写凭据。
- **批准必须经用户确认**：插件带一个 `PreToolUse` hook（`hooks/hooks.json` + `scripts/approve-guard.ts`），词法级识别 `bridge.ts ... approve`（覆盖前置 `--agent`、`sh -c`、`$()`/`eval` 包装，同时不误拦 `deny` 和 `send` 正文里的 `approve` 字样），强制弹出确认。
- 新的审批请求登记时会先丢弃同 ID 的残留决定，过期的批准不会落到别的请求上。
- 执行端的汇报是它的自述，Claude 应自己核对 diff 和测试，不要直接采信。

## 已知限制

- Codex 依赖实验性的 app-server 协议（已测 Codex CLI 0.166.0 / daemon 0.167.0）；`agy` 依赖 `agy acp` 协议（已测 `agy 1.5.15`），CLI 升级后可能需要跟进适配。
- Monitor 最长 30 分钟，长任务到期后用 `watch` 续上。
- 单元测试（`bun test`）共 26 项，覆盖护栏、一次性等待与审批不断链、策略引擎、fail-closed 自审核、`Session` 状态机以及基于真实子进程模拟 ACP 的全链路测试；真实端到端已测 `agy 1.5.15` 与 `Codex CLI 0.166.0`。

## License

MIT
