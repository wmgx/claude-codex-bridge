# agent-duo

让 Claude Code 出方案，Codex 去做。Claude 直接开 Codex 线程、派活，Codex 做完或有疑问时事件会自动推回 Claude，两边在**同一个线程**里来回沟通。

> 与 OpenAI、Anthropic 无关联。Codex 是 OpenAI 的产品，Claude Code 是 Anthropic 的产品。

## 它做什么

- `start`：连上本机 Codex daemon，开线程，把方案作为第一轮发出，并持续输出事件。
- `send`：在已有线程里继续发一轮（Codex 忙时是插话，空闲时是新一轮）。
- `watch`：重新订阅一个已有线程的事件。
- `doctor`：检查依赖，缺什么告诉你怎么修。

事件是 Codex 主动推的，不是轮询。每个事件一行 JSON：

| event | 含义 |
|---|---|
| `started` | 线程已创建，带 `threadId` |
| `turn_completed` | 一轮结束，`text` 是 Codex 的最后一条消息（汇报或提问） |
| `needs_input` | Codex 在等输入 |
| `error` / `closed` | 出错或连接断开 |

Codex 的提问发生在一轮末尾：它把问题写出来、结束这一轮，Claude 回复后继续。不能在一轮中途停下来等回复。

## 要求

- macOS 或 Linux
- [Bun](https://bun.sh) >= 1.4（需要 `ws+unix://` 支持）
- Codex CLI，已登录。脚本会自动启动本地 daemon（`codex app-server daemon start`），不开远程控制。

## 安装

在 Claude Code 里添加本仓库为插件市场并安装（填入你的仓库地址）：

```
/plugin marketplace add <owner>/agent-duo
/plugin install agent-duo
```

首次使用前自检：

```
bun scripts/duo.ts doctor
```

## 使用

对 Claude 说"让 Codex 去做 X"。`delegate` skill 会引导 Claude：先和你确认方案，再用 `Monitor` 运行 `duo.ts start`，收到事件后核对结果、回答提问。

## 权限与安全

- 默认 `read-only` 沙箱，不审批。
- `--write` 是 `workspace-write`：可写线程工作目录和系统临时目录（如 `/tmp`），其余路径（例如家目录）会被沙箱拒绝，不会弹审批。已实测：写 `~` 下文件返回 `operation not permitted`，写 `/tmp` 成功。
- 不提供 `danger-full-access`。
- 只连本机 Unix socket，不联网、不读写凭据。
- Codex 的汇报是它的自述，Claude 应自己核对 diff 和测试，不要直接采信。

## 已知限制

- 依赖 Codex 实验性的 app-server 协议。Codex 升级后可能失效；已测 Codex CLI 0.166.0 / daemon 0.167.0。
- 线程挂在 daemon 上，daemon 重启后线程仍可通过 `codex resume` 找回，但事件订阅需要 `watch` 重新挂上。
- Monitor 最长 30 分钟，长任务到期后用 `watch` 续上。
- 没有处理审批请求：因为固定 `approvalPolicy: never`，正常不会出现；出现时只会输出 `needs_input`。

## License

MIT
