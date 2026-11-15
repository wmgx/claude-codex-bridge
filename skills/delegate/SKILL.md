---
name: delegate
description: 把方案交给 Codex 执行并在同一线程里往返沟通。当用户说"让 Codex 去做""交给 Codex""你出方案 Codex 执行"，或需要把已定方案派给 Codex 实现时使用。
---

# 派活给 Codex

你出方案，Codex 执行；Codex 有问题在同一线程里回问你。全程走 Codex 本地 app-server daemon，不需要在 Codex 里装任何插件。

脚本：`${CLAUDE_PLUGIN_ROOT}/scripts/duo.ts`（用 `bun` 运行）。

## 流程

1. **先确认方案**。派活前把方案、改动范围、验收标准写清楚；默认只读。需要写文件时必须先让用户确认，再加 `--write`。
2. **首次使用先自检**：`bun ${CLAUDE_PLUGIN_ROOT}/scripts/duo.ts doctor`，按提示修复。
3. **开线程并监听**：用 `Monitor` 工具运行
   `bun ${CLAUDE_PLUGIN_ROOT}/scripts/duo.ts start <目录> "<完整方案>" [--write]`
   该进程会一直连着线程，每个事件输出一行 JSON，作为通知唤醒你。不要轮询、不要 sleep。
4. **处理事件**：
   - `started`：记下 `threadId`。
   - `turn_completed`：读 `text`。是汇报就核对（见下）；是提问就回答。
   - `needs_input`：Codex 在等输入，告诉用户。
   - `error` / `closed`：告诉用户，必要时用 `watch` 重新订阅。
5. **回答或追加指令**：`bun ${CLAUDE_PLUGIN_ROOT}/scripts/duo.ts send <threadId> "<文本>"`。同一线程，上下文保留。
6. **Monitor 到期**（最长 30 分钟）：线程还需要继续时，用 `watch <threadId>` 重新挂上。

## 写方案时要约定的事

在方案里明确告诉 Codex：

- 遇到方案没覆盖的决策、与方案冲突的现状：**不要自行决定，把问题作为这一轮的最后一条消息写出来并结束这一轮**。
- 完成后汇报：改了什么、验证证据、未验证项。
- 同一仓库里，Claude 和 Codex 不同时改同一个文件，派活时说明文件归属。

## 验收

`turn_completed` 里 Codex 的汇报是它的自述，不是证据。声明完成前自己核对：读 diff、跑测试或命令。用户的规则优先于 Codex 的结论。

## 权限

- 默认 `read-only` 沙箱 + 不审批。
- `--write` 为 `workspace-write`：可写工作目录和系统临时目录（`/tmp` 等），其余路径会被沙箱拒绝；仍不审批，不会弹窗。
- 不提供 `danger-full-access`。需要更大权限时让用户自己决定。
- 删除、强推、发布、对外发送等不可逆操作，不要在方案里授权给 Codex。
