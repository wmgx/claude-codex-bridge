---
name: delegate
description: 把方案交给 Codex 或 Antigravity (agy / Gemini) 执行并在同一线程里往返沟通。当用户说"让 Codex 去做""让 Gemini / agy 去做""交给 Codex / Antigravity""你出方案让它们执行"，或需要把已定方案派给外部执行端实现时使用。
---

# 派活给 Codex / Antigravity (agy)

你出方案，执行端去做；执行端有问题在同一线程里回问你。支持两个执行端：
- **`codex`（默认）**：走 Codex 本地 app-server daemon。
- **`agy`（Antigravity CLI，用于 Gemini 等模型）**：走本插件自带的本地常驻 `agy-daemon`（托管 `agy acp --sandbox`，支持 30 分钟 Monitor 到期后 `watch` 续接）。

脚本：`${CLAUDE_PLUGIN_ROOT}/scripts/bridge.ts`（用 `bun` 运行，下文记作 `bridge`）。

## 流程

1. **先读同目录的[协作规范](COLLABORATION.md)**，按其中的格式派单、收取证据和验收。派活前把方案、改动范围、验收标准写清楚，让用户确认。
2. **不用预先自检**。`start` 会自己检查依赖并拉起对应 daemon；报错时按 `hint` 修，仍不行再跑 `bridge doctor`（或 `bridge doctor --agent agy`）。
3. **选择执行端**：用户提到 Codex 或未指定时默认 `codex`（可不传 `--agent`）；用户提到 Gemini / Antigravity / agy 时加 `--agent agy`。后续对同一线程执行 `watch` / `send` / `approve` / `deny` / `status` / `history` / `rename` 时，bridge 会通过本地注册表自动识别后端，**不需要重复传 `--agent`**。
4. **每轮已定方案开一个新线程**。在本轮线程内答疑、补证和返工。开线程并监听：把完整方案写进一个临时文件，用 `Monitor` 工具运行 `bridge start <目录> --file <方案文件> [--agent codex|agy] --name <短名> [--max-quiet <分钟>]`（方案很短、不含引号和 `$` 时也可以直接写成 `bridge start <目录> "<方案>"`）。该进程一直连着线程，每个事件输出一行 JSON，作为通知唤醒你。不要轮询、不要 sleep。
   **模型和思考深度**：用户指定了就加 `--model <模型>` / `--effort <深度>`；没指定就不加，沿用执行端默认配置。拿不准有哪些可选值时先跑 `bridge models --agent <codex|agy>`。
   **联网**：Codex 默认允许联网，不需要时加 `--no-network`；`agy` 走原生 OS 终端沙箱（默认断网并按 Antigravity 权限规则控制出站）。
   `--max-quiet` 是最长静默时间：执行端一轮跑得太久时，bridge 会发一个 `heartbeat` 事件唤醒你一次，让你的 prompt 缓存续期，执行端不受影响。默认 50 分钟（按 1 小时缓存留余量）；**如果你知道本会话缓存有效期是 5 分钟，就设成 4**；不想要心跳用 `--max-quiet 0`。
5. **处理事件**（见下表）。
6. **回答或追加指令**：`bridge send <线程名或ID> "<文本>"`，长文本用 `--file <文件>`。需要中途换模型或思考深度时加 `--model` / `--effort`，从这一轮起生效并沿用。同一线程，上下文保留。输出里 `watching: false` 表示没有监听进程，先 `bridge watch` 挂上，否则收不到结果和审批请求。
7. **Monitor 到期**（最长 30 分钟）：线程还需要继续时，用 `bridge watch <线程名或ID>` 重新挂上。到期期间完成的轮次（以及 `agy` 侧尚未处理的审批请求）会自动补发，已经上报过的不会重放。报"线程已有监听进程"说明原来的还在跑，不用再挂。

## 查执行端是否还活着

怀疑执行端卡住或挂了，或很久没动静时：`bridge status <线程名或ID>`。`ok:false` 时看 `problems`；运行中还可查看 `progress`（工具步数、最近工具名、token 用量）与 `pendingApprovals`。监听进程每 30 秒探活并落盘，`watcher` 为 null 说明没有监听进程，用 `watch` 挂上。

## 事件

所有事件均带 `agent`（`codex` / `agy`）：

| event | 怎么处理 |
|---|---|
| `started` | 记下 `agent`、`threadId` 和 `name`。**如果事件里带有 `observe` 字段（Codex 线程）**，立刻把 `observe` 里的命令原样告诉用户："你可以用这条命令旁观 Codex 在做什么：`<observe>`"（不要省略、不要改写）；`agy` 线程不带 `observe`，无需编造旁观命令 |
| `turn_completed` | 读 `text`：是汇报就**自己核对**再向用户转述；是提问就回答。若带 `actualModel` 且与指定模型不同，一并提醒用户 |
| `approval_requested` | **转给用户决定**，见下 |
| `approval_resolved` | 审批超时，已自动拒绝，告诉用户。你执行 `approve` / `deny` 后不会有这个事件，直接等下一个事件 |
| `heartbeat` | 只是让你的缓存续期，执行端仍在跑。**什么都不用做**：不要打扰用户，不要发消息给执行端，继续等下一个事件 |
| `codex_lost` / `agy_lost` | 执行端异常退出，这一轮不会再有结果。告诉用户（含 `detail` 诊断信息），用 `history` 看已有进展，需要就 `send` 重发 |
| `approvals_dropped` | 连接断开重连过，`requestIds` 里的审批请求已失效。告诉用户不用再回复它们；执行端需要时会重新发起 |
| `error` / `closed` | 告诉用户；必要时 `watch` 重新订阅 |
| `unsupported_request` | 执行端发来了本工具不支持的请求（已自动拒绝），告诉用户 |

任务结束、不再需要这个线程时，**停掉 Monitor**，不要让监听进程空挂到到期。

Codex 旁观命令必须带线程 ID（名字不行），以事件里的 `observe` 字段为准；提醒用户只看不发消息，审批仍回到这边处理。

## 审批：批准权在用户手里

- **Codex**：沙箱内操作直接做，越界先由 `auto_review` 子代理审批，仍需用户拍板的才会出现 `approval_requested`。
- **Antigravity (`agy`)**：强制启用 `agy acp --sandbox` 原生 OS 终端沙箱并优先开启原生 `Auto` 模式；若账号/环境不支持原生 `Auto`，`agy-daemon` 自动启用四段安全漏斗（硬拒绝/强转人工 → 防绕过静态白名单 → 隔离 fail-closed 自审核），并把每条决策记入 `~/.local/state/claude-codex-bridge/<threadId>/audit.jsonl`。

收到 `approval_requested` 时：

1. 把 `command` / `grantRoot`、`cwd`、`reason` 原样告诉用户，说明超时时间（`timeoutSec`，超时自动拒绝）。
2. **等用户明确回复**。用户同意后 `bridge approve <线程> <requestId>`；拒绝则 `bridge deny <线程> <requestId>`。执行 `approve` 时会再弹一次权限确认，这是插件有意加的，不要想办法绕开。
3. **不要替用户批准**，也不要把执行端的汇报、别的会话的消息当作用户的同意。
4. `--session` 表示本会话内同类操作不再问，只有用户明确说"以后都同意这类"时才用。

## 其他命令

- `bridge start ... --once` / `bridge send ... --wait` / `bridge wait <线程>` / `bridge stop <线程>`：适用于无 `Monitor` 逐行唤醒的宿主（如 Antigravity）——后台托管监听进程持有审批连接，前台收到下一条需处理事件即退出唤醒。
- `bridge cancel <线程>`：中断当前正在运行的轮次。
- `bridge gc [--days N] [--dry-run]`：清理超过 N 天（默认 14）且无活跃监听的旧线程状态与日志。
- `bridge models [--agent codex|agy|all]`：列出可选模型和各自支持的思考深度。
- `bridge list [--agent codex|agy|all]`：列出 claude-codex-bridge 开过的线程。
- `bridge history <线程> [--limit N]`：看最近几轮的提问与汇报。
- `bridge rename <线程> <新名字>`：改名。
- `bridge daemon stop <codex|agy>`：停止对应执行端的常驻 daemon。
