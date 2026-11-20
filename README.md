# claude-codex-bridge

让 Claude Code 出方案，Codex 去做。Claude 直接开 Codex 线程、派活，Codex 做完或有疑问时事件会自动推回 Claude，两边在**同一个线程**里来回沟通。

> 与 OpenAI、Anthropic 无关联。Codex 是 OpenAI 的产品，Claude Code 是 Anthropic 的产品。

## 命令

| 命令 | 作用 |
|---|---|
| `start <cwd> <text> [--name N] [--max-quiet M] [--model X] [--effort E] [--no-network]` | 开线程，发第一轮，之后持续输出事件。默认允许联网 |
| `watch <thread> [--max-quiet M]` | 重新订阅已有线程的事件；补发上次上报之后完成的轮次，已上报的不重放 |
| `send <thread> <text> [--model X] [--effort E]` | 在同一线程继续发一轮，给了模型或思考深度就从这一轮起换；没有监听进程时输出里会带 `watching: false` |
| `approve <thread> <id> [--session]` / `deny <thread> <id>` | 回应审批请求 |
| `status <thread>` | 查 Codex 是否还活着：返回 `ok`、`problems`、`daemon`、`thread` 状态、`running`、监听进程 pid。只读，不会拉起 daemon |
| `models` | 列出可选模型，以及每个模型支持的思考深度（`efforts`）和默认值 |
| `list` | 列出 claude-codex-bridge 开过的线程 |
| `history <thread> [--limit N]` | 最近几轮的提问与汇报 |
| `rename <thread> <name>` | 改名 |
| `doctor` | 检查依赖 |

`<thread>` 可以是线程 ID，也可以是 `start` 时起的名字。线程在 Codex 自己的列表里显示为 `[bridge] <名字>`。

`start` 和 `send` 的 `<text>` 可以换成 `--file <路径>`，从文件读文本。方案较长或带引号、反引号、`$` 时用它，避免 shell 转义出错。

`--model` / `--effort` 不给时用 Codex 自己 `config.toml` 里的设置；给了之后，后续轮次都沿用，直到再次指定。可选值用 `models` 查。

同一个线程同时只允许一个监听进程（`start` 或 `watch`）：已有一个在跑时，再 `watch` 会报错并给出它的 pid。

## 事件

事件由 Codex 主动推送，不是轮询。每个事件一行 JSON：

| event | 含义 |
|---|---|
| `started` | 线程已创建，带 `threadId`、`name`，以及 `observe`：一条可以直接复制的旁观命令，Claude 会转告给你 |
| `turn_completed` | 一轮结束，`text` 是 Codex 的最后一条消息（汇报或提问） |
| `approval_requested` | Codex 请求越权操作，带 `requestId`、`command`、`reason` |
| `approval_resolved` | 审批超时，已自动拒绝。正常的批准或拒绝不上报 |
| `heartbeat` | 太久没有唤醒 Claude，发一个事件让它的缓存续期；Codex 不受影响，仍在跑 |
| `codex_lost` | 一轮正在跑时 Codex 异常退出（没有先发 `thread/closed` 就被卸载，或进入 systemError），不会再有结果。Codex 自己正常卸载线程不推送。带 `turnId`、`status` |
| `approvals_dropped` | 连接断开重连后，旧连接上未决的审批请求失效，带 `requestIds` |
| `error` / `closed` / `unsupported_request` | 出错、结束、收到不支持的请求 |

每输出一个事件，Claude 就被唤醒一次、重读一遍上下文，所以只上报需要它处理的事：正常的批准或拒绝、重连成功都不出声。

Codex 的提问发生在一轮末尾：它把问题写出来、结束这一轮，Claude 回复后继续。不能在一轮中途停下来等回复。

## 权限：auto 模式

线程固定为 Codex 的 auto 模式（`workspace-write` 沙箱 + `on-request` 审批 + `auto_review` 审查者）：

- 沙箱内（线程工作目录、系统临时目录）的操作 Codex 直接做，不打扰。
- **默认允许联网**：`workspace-write` 沙箱本身是断网的（连本机代理都连不上），bridge 开线程时打开了沙箱的网络开关。不需要联网的任务用 `start --no-network`。
- 越出沙箱（如写家目录；`--no-network` 时的联网）时，审批请求默认交给 Codex 的 `auto_review` 子代理按风险判断，通过或拒绝都不打扰用户。
- 仍落到用户这边的请求（如审查者无法决定）会变成 `approval_requested` 事件，**由用户决定**，Claude 不替用户批准。10 分钟无人回复自动拒绝。
- 只读任务请在任务描述里写明"只读，不要改文件"。

## 缓存心跳：避免 Claude 缓存过期

Claude 每被唤醒一次，它的 prompt 缓存有效期就从头算。静默太久缓存会失效，下一个事件把它唤醒时要按全价重读整个上下文。

所以 Codex 的一轮跑得很久时，bridge 会在缓存失效之前输出一个 `heartbeat` 事件，把 Claude 唤醒一次让缓存续期。**心跳不中断 Codex，也不需要问用户**，Claude 收到后什么都不用做。

`--max-quiet <分钟>` 控制最长静默时间，默认 50（按 1 小时缓存有效期留余量），`0` 表示不发心跳，可以是小数：

- 每输出一个事件（即唤醒了 Claude），计时重置。
- Codex 有一轮在跑、且静默达到上限时，输出一个 `heartbeat`，然后重新计时；这一轮没结束就按这个间隔一直发。
- 没有轮次在跑时不发。
- 等审批期间不计入：那时 Claude 已经在等用户，不是静默。

说明：

- 插件看不到 Claude 自己的缓存状态，上限要按自己会话的缓存有效期设置。缓存有效期是 5 分钟的会话设成 4 左右。
- 每次心跳也要付一次读缓存的钱。间隔很短、任务很长时，心跳的总花费可能超过让缓存过期一次，这种情况用 `--max-quiet 0` 关掉更划算。
- 计时器在监听进程里。Monitor 最长 30 分钟，所以默认的 50 分钟在单个 Monitor 内不会触发；Monitor 到期、Claude 重新 `watch` 本身就是一次唤醒。

## 保活

- 连接断开自动重连（指数退避，最长 15 秒一次，10 分钟放弃）。重连成功不上报，放弃时输出 `closed`。
- 每 30 秒探活一次，连接静默死掉也能发现。
- 最后上报到哪一轮记在状态目录里。重连或重新 `watch` 后，补发这之后完成的所有轮次，不重复上报。
- 重连会使旧连接上未决的审批请求失效，这时输出 `approvals_dropped`，需要 Codex 重新发起。

## 安装

**1. 准备依赖**

- [Bun](https://bun.sh) >= 1.4（需要 `ws+unix://` 支持）。已装的用 `bun upgrade` 升级。
- Codex CLI，并已登录（`codex login`）。

**2. 安装插件**

在 Claude Code 里添加本仓库为插件市场并安装，然后重启 Claude Code：

```
/plugin marketplace add wmgx/claude-codex-bridge
/plugin install claude-codex-bridge
```

**3. 自检**

对 Claude 说"自检一下 Codex bridge"，它会运行 `doctor` 检查 Bun 版本、Codex CLI 和 daemon 是否可连接。克隆了仓库的话也可以直接跑 `bun scripts/bridge.ts doctor`。

脚本会在需要时自动启动 Codex 的本地 daemon（`codex app-server daemon start`），不开远程控制。daemon 是常驻进程，不用时可以 `codex app-server daemon stop` 停掉。

**升级与卸载**

- 升级：在 `/plugin` 界面里更新插件市场和插件，然后重启 Claude Code。
- 卸载：`/plugin uninstall claude-codex-bridge`。状态文件在 `~/.local/state/claude-codex-bridge/`，不再需要可以直接删除。
- 从 0.2 升级：`quiet_timeout` 事件已改为 `heartbeat`，静默到上限时不再中断 Codex；`--max-quiet` 默认值从 4 改为 50 分钟。
- 从 0.3.1 升级：为了少唤醒 Claude，`reconnecting` / `reconnected` 不再上报，`approval_resolved` 只在超时自动拒绝时上报；新增 `approvals_dropped`。

## 使用

对 Claude 说"让 Codex 去做 X"。`delegate` skill 会引导 Claude：先和你确认方案，再用 `Monitor` 运行 `bridge.ts start`，收到事件后核对结果、回答提问、把审批请求转给你。

## 旁观 Codex 在做什么

bridge 开的是 Codex 本地 daemon 上的普通线程，可以用 Codex 自己的客户端连上去看：

- `codex agents`：浏览 daemon 上的所有会话，bridge 开的显示为 `[bridge] <名字>`。
- `codex resume <线程ID> --remote unix://`：把 Codex 终端界面连到同一个 daemon，实时看它在跑什么命令、改什么文件。必须用线程 ID，名字不行。

每次派活后，`started` 事件的 `observe` 字段里就是填好线程 ID 的这条命令，Claude 会直接告诉你；`watch` 重新挂上时的 `watching` 事件里也有。

注意：

- 一定带 `--remote unix://`。不带的话可能另起一个进程加载同一个线程，两边各跑各的。
- 只看，不要在旁观窗口里发消息，否则 Claude 会收到一轮不是它发起的 `turn_completed`。
- 审批回到 Claude 这边批。在旁观窗口里直接批的话，bridge 不知道，10 分钟后会误报一条"超时自动拒绝"。

## 安全

- 只连本机 Unix socket，不联网、不读写凭据。
- **批准必须经用户确认**：插件带一个 `PreToolUse` hook（`hooks/hooks.json`），Claude 执行 `bridge.ts approve` 时强制弹出确认，不受已有的 Bash 放行规则影响。`deny` 不拦。它识别的是命令文本，是一道防线而不是沙箱；不通过插件安装、直接跑脚本时没有这层保护。
- 状态落在 `~/.local/state/claude-codex-bridge/<线程>/`（目录 0700、文件 0600）：审批决定（监听进程读取后删除）、最后上报的轮次、监听进程的 pid。
- 新的审批请求登记时会先丢弃同 ID 的残留决定，过期的批准不会落到别的请求上。
- Codex 的汇报是它的自述，Claude 应自己核对 diff 和测试，不要直接采信。

## 已知限制

- 依赖 Codex 实验性的 app-server 协议。Codex 升级后可能失效；已测 Codex CLI 0.166.0 / daemon 0.167.0。
- 只处理命令执行和文件变更两类审批；其他请求（工具调用、权限请求、用户输入）会被自动拒绝并输出 `unsupported_request`。
- Monitor 最长 30 分钟，长任务到期后用 `watch` 续上。
- 单元测试只有两个（`bun test`）：重新 `watch` 后的补发、残留审批决定不会错批。其余靠对真实 Codex 的端到端运行验证（提问往返、心跳、审批、重新监听补发、列表与历史）。

## License

MIT
