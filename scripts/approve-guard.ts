#!/usr/bin/env bun
// PreToolUse hook：Claude 要执行 `bridge.ts approve` 时，强制弹出确认，让用户自己点头。
// 批准权不能只靠提示词约束：Codex 的汇报会进入 Claude 的上下文，可能诱导它自行批准。
// 其他命令（包括 deny）不拦，直接放行。

try {
  const input = JSON.parse(await Bun.stdin.text());
  const command: string = input?.tool_input?.command ?? "";
  if (/bridge\.ts["']?\s+approve\b/.test(command)) {
    console.log(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "ask",
        permissionDecisionReason: "这会批准 Codex 的一个越出沙箱的请求，需要你确认",
      },
    }));
  }
} catch {
  // 读不懂输入就不干预，不影响其他命令。
}
