# claude-codex-bridge

让 Claude Code 出方案，Codex 去做。Claude 直接开 Codex 线程、派活，Codex 做完或有疑问时事件会自动推回 Claude，两边在**同一个线程**里来回沟通。

> 与 OpenAI、Anthropic 无关联。Codex 是 OpenAI 的产品，Claude Code 是 Anthropic 的产品。

## 命令

| 命令 | 作用 |
|---|---|
| `start <cwd> <text> [--name N] [--budget M]` | 开线程，发第一轮，之后持续输出事件 |
| `watch <thread> [--budget M]` | 重新订阅已有线程的事件，不重放已上报的轮次 |
| `send <thread> <text>` | 在同一线程继续发一轮 |
| `approve <thread> <id> [--session]` / `deny <thread> <id>` | 回应审批请求 |
| `list` | 列出 claude-codex-bridge 开过的线程 |
| `history <thread> [--limit N]` | 最近几轮的提问与汇报 |
| `rename <thread> <name>` | 改名 |
| `doctor` | 检查依赖 |

`<thread>` 可以是线程 ID，也可以是 `start` 时起的名字。线程在 Codex 自己的列表里显示为 `[bridge] <名字>`。

## 事件

事件由 Codex 主动推送，不是轮询。每个事件一行 JSON：

| event | 含义 |
|---|---|
| `started` | 线程已创建，带 `threadId`、`name` |
| `turn_completed` | 一轮结束，`text` 是 Codex 的最后一条消息（汇报或提问） |
| `approval_requested` | Codex 请求越权操作，带 `requestId`、`command`、`reason` |
| `approval_resolved` | 审批已落实（含超时自动拒绝） |
| `budget_exceeded` | 一轮跑超时，已中断；随后会有一条 `status: interrupted` 的 `turn_completed` |
| `reconnecting` / `reconnected` | 连接断开后自动重连 |
| `error` / `closed` / `unsupported_request` | 出错、结束、收到不支持的请求 |

Codex 的提问发生在一轮末尾：它把问题写出来、结束这一轮，Claude 回复后继续。不能在一轮中途停下来等回复。

## 权限：auto 模式

线程固定为 Codex 的 auto 模式（`workspace-write` 沙箱 + `on-request` 审批）：

- 沙箱内（线程工作目录、系统临时目录）的操作 Codex 直接做，不打扰。
- 越出沙箱（如写家目录、联网）时，Codex 发出审批请求，变成 `approval_requested` 事件，**由用户决定**，Claude 不替用户批准。10 分钟无人回复自动拒绝。
- 只读任务请在任务描述里写明"只读，不要改文件"。

## 时限：跑太久就停下，问用户是否继续

`--budget <分钟>` 限制**单轮**最长运行时间，默认 30，`0` 表示不限，可以是小数。超时后：

1. 中断 Codex 当前这一轮（`turn/interrupt`）。
2. 输出 `budget_exceeded` 事件，Claude 据此问用户"要继续吗"。
3. 用户同意后 `send <thread> "继续"`，会开新的一轮并重新计时；不同意就到此为止。

说明：插件看不到 Claude 自己的 prompt 缓存是否已失效，所以用"单轮时长"做近似。想让它更早停下，就把 `--budget` 设小。等待审批的时间也算在这一轮里。

## 保活

- 连接断开自动重连（指数退避，最长 15 秒一次，10 分钟放弃）。
- 每 30 秒心跳，连接静默死掉也能发现。
- 重连后补发断线期间完成、但还没上报的轮次，不重复上报。
- 重连会使旧连接上未决的审批请求失效，需要 Codex 重新发起。

## 要求

- macOS 或 Linux
- [Bun](https://bun.sh) >= 1.4（需要 `ws+unix://` 支持）
- Codex CLI，已登录。脚本会自动启动本地 daemon（`codex app-server daemon start`），不开远程控制。

## 安装

在 Claude Code 里添加本仓库为插件市场并安装：

```
/plugin marketplace add wmgx/claude-codex-bridge
/plugin install claude-codex-bridge
```

首次使用前自检：`bun scripts/bridge.ts doctor`。

## 使用

对 Claude 说"让 Codex 去做 X"。`delegate` skill 会引导 Claude：先和你确认方案，再用 `Monitor` 运行 `bridge.ts start`，收到事件后核对结果、回答提问、把审批请求转给你。

## 安全

- 只连本机 Unix socket，不联网、不读写凭据。
- 审批决定以文件形式落在 `~/.local/state/claude-codex-bridge/`（目录 0700、文件 0600），由监听进程读取后删除。
- Codex 的汇报是它的自述，Claude 应自己核对 diff 和测试，不要直接采信。

## 已知限制

- 依赖 Codex 实验性的 app-server 协议。Codex 升级后可能失效；已测 Codex CLI 0.166.0 / daemon 0.167.0。
- 只处理命令执行和文件变更两类审批；其他请求（工具调用、权限请求、用户输入）会被自动拒绝并输出 `unsupported_request`。
- Monitor 最长 30 分钟，长任务到期后用 `watch` 续上。
- 没有单元测试，验证靠对真实 Codex 的端到端运行（提问往返、审批、断线重连、列表与历史）。

## License

MIT
