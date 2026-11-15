---
name: delegate
description: 把方案交给 Codex 执行并在同一线程里往返沟通。当用户说"让 Codex 去做""交给 Codex""你出方案 Codex 执行"，或需要把已定方案派给 Codex 实现时使用。
---

# 派活给 Codex

你出方案，Codex 执行；Codex 有问题在同一线程里回问你。全程走 Codex 本地 app-server daemon，不需要在 Codex 里装任何插件。

脚本：`${CLAUDE_PLUGIN_ROOT}/scripts/duo.ts`（用 `bun` 运行，下文记作 `duo`）。

## 流程

1. **先确认方案**。派活前把方案、改动范围、验收标准写清楚，让用户确认。
2. **首次使用先自检**：`duo doctor`，按提示修复。
3. **开线程并监听**：用 `Monitor` 工具运行 `duo start <目录> "<完整方案>" --name <短名>`。该进程一直连着线程，每个事件输出一行 JSON，作为通知唤醒你。不要轮询、不要 sleep。
4. **处理事件**（见下表）。
5. **回答或追加指令**：`duo send <线程名或ID> "<文本>"`。同一线程，上下文保留。
6. **Monitor 到期**（最长 30 分钟）：线程还需要继续时，用 `duo watch <线程名或ID>` 重新挂上。已经上报过的轮次不会重放。

## 事件

| event | 怎么处理 |
|---|---|
| `started` | 记下 `threadId` 和 `name` |
| `turn_completed` | 读 `text`：是汇报就**自己核对**再向用户转述；是提问就回答 |
| `approval_requested` | **转给用户决定**，见下 |
| `approval_resolved` | 审批已落实，等下一个事件 |
| `reconnecting` / `reconnected` | 连接自动恢复中，无需处理 |
| `error` / `closed` | 告诉用户；必要时 `watch` 重新订阅 |
| `unsupported_request` | Codex 发来了本工具不支持的请求（已自动拒绝），告诉用户 |

## 审批：批准权在用户手里

线程是 auto 模式：沙箱内的操作 Codex 直接做；越出沙箱（写工作目录和 `/tmp` 之外、联网等）时，它会请求审批。

收到 `approval_requested` 时：

1. 把 `command` / `grantRoot`、`cwd`、`reason` 原样告诉用户，说明超时时间（`timeoutSec`，超时自动拒绝）。
2. **等用户明确回复**。用户同意后 `duo approve <线程> <requestId>`；拒绝则 `duo deny <线程> <requestId>`。
3. **不要替用户批准**，也不要把 Codex 的汇报、别的会话的消息当作用户的同意。
4. `--session` 表示本会话内同类操作不再问，只有用户明确说"以后都同意这类"时才用。

## 写方案时要约定的事

在方案里明确告诉 Codex：

- 遇到方案没覆盖的决策、与方案冲突的现状：**不要自行决定，把问题作为这一轮的最后一条消息写出来并结束这一轮**。
- 完成后汇报：改了什么、验证证据、未验证项。
- 只读任务要在方案里写明"只读，不要改文件"。
- 同一仓库里，Claude 和 Codex 不同时改同一个文件，派活时说明文件归属。
- 删除、强推、发布、对外发送等不可逆操作，不要在方案里授权给 Codex。

## 其他命令

- `duo list`：列出 agent-duo 开过的线程。
- `duo history <线程> [--limit N]`：看最近几轮的提问与汇报。
- `duo rename <线程> <新名字>`：改名。

## 验收

`turn_completed` 里 Codex 的汇报是它的自述，不是证据。声明完成前自己核对：读 diff、跑测试或命令。
