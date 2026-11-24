import { expect, test } from "bun:test";
import { evaluateHookInput, shouldAskApproval } from "./approve-guard";

test("拦截各种形态的 bridge.ts approve 调用", () => {
  expect(shouldAskApproval("bun scripts/bridge.ts approve t1 req1")).toBe(true);
  expect(shouldAskApproval('bun "/Users/a b/scripts/bridge.ts" approve t1 req1 --session')).toBe(true);
  expect(shouldAskApproval("bun scripts/bridge.ts --agent agy approve t1 req1")).toBe(true);
  expect(shouldAskApproval("bun scripts/bridge.ts --agent=agy approve t1 req1")).toBe(true);
  expect(shouldAskApproval("bun scripts/bridge.ts --idle-exit 60 --timeout 30 approve t1 req1")).toBe(true);
  expect(shouldAskApproval("cd /tmp && bun scripts/bridge.ts approve t1 req1")).toBe(true);
  expect(shouldAskApproval("echo ok; bun scripts/bridge.ts approve t1 req1")).toBe(true);
  expect(shouldAskApproval("sh -c 'bun scripts/bridge.ts approve t1 req1'")).toBe(true);
  expect(shouldAskApproval('bash -lc "bun /opt/bridge.ts --agent agy approve t1 7"')).toBe(true);
  expect(shouldAskApproval('eval "bun scripts/bridge.ts approve t1 7"')).toBe(true);
  expect(shouldAskApproval('echo "$(bun scripts/bridge.ts approve t1 7)"')).toBe(true);
  expect(shouldAskApproval('bun scripts/bridge.ts send t1 "`bun scripts/bridge.ts approve t1 7`"')).toBe(true);
});

test("不误拦 deny、其他子命令以及正文里包含 approve 的 send/start", () => {
  expect(shouldAskApproval("bun scripts/bridge.ts deny t1 req1")).toBe(false);
  expect(shouldAskApproval("bun scripts/bridge.ts --agent agy deny t1 req1")).toBe(false);
  expect(shouldAskApproval('bun scripts/bridge.ts send t1 "请不要 approve 这个操作"')).toBe(false);
  expect(shouldAskApproval('bun scripts/bridge.ts start /repo "不要运行 bridge.ts approve" --agent agy')).toBe(false);
  expect(shouldAskApproval("bun scripts/bridge.ts status approve")).toBe(false);
  expect(shouldAskApproval("bun scripts/bridge.ts list --agent agy")).toBe(false);
});

test("evaluateHookInput 同时兼容 Claude Code 与 Antigravity PreToolUse 协议", () => {
  // Claude Code 格式
  expect(evaluateHookInput({ tool_input: { command: "bun scripts/bridge.ts approve t1 7" } })).toMatchObject({
    hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "ask" },
  });
  expect(evaluateHookInput({ tool_input: { command: "bun scripts/bridge.ts deny t1 7" } })).toBeUndefined();

  // Antigravity 格式
  expect(evaluateHookInput({
    hookEventName: "PreToolUse",
    toolCall: { name: "run_command", args: { CommandLine: "bun scripts/bridge.ts --agent codex approve t1 7" } },
  })).toMatchObject({ decision: "force_ask" });
  expect(evaluateHookInput({
    hookEventName: "PreToolUse",
    toolCall: { name: "run_command", args: { CommandLine: "bun scripts/bridge.ts send t1 \"do not approve\"" } },
  })).toEqual({ decision: "allow" });
});
