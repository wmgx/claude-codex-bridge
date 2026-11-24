import { afterEach, expect, test } from "bun:test";
import { buildReviewPrompt, parseReviewJson, runAutoReview, type ReviewInput } from "./reviewer";

const origFetch = globalThis.fetch;
const origKey = process.env.GEMINI_API_KEY;
const origToggle = process.env.BRIDGE_AGY_AUTO_REVIEW;

afterEach(() => {
  globalThis.fetch = origFetch;
  if (origKey === undefined) delete process.env.GEMINI_API_KEY;
  else process.env.GEMINI_API_KEY = origKey;
  if (origToggle === undefined) delete process.env.BRIDGE_AGY_AUTO_REVIEW;
  else process.env.BRIDGE_AGY_AUTO_REVIEW = origToggle;
});

const sampleInput: ReviewInput = {
  cwd: "/tmp/repo",
  network: true,
  sandboxed: true,
  taskSummary: "修复单测并验证编译",
  permission: {
    kind: "command",
    title: "run_shell_command",
    command: "cd packages/app && bun test",
    locations: [],
    rawInput: { command: "cd packages/app && bun test" },
    signature: "cmd:cd",
  },
};

test("parseReviewJson 支持纯 JSON、代码块包裹以及拒绝非法决策", () => {
  expect(parseReviewJson('{"decision":"allow","reason":"工作区内测试"}')).toEqual({ decision: "allow", reason: "工作区内测试" });
  expect(parseReviewJson('```json\n{"decision":"deny","reason":"高危"}\n```')).toEqual({ decision: "deny", reason: "高危" });
  expect(parseReviewJson('前缀说明 {"decision":"ask_user","reason":"需确认"}')).toEqual({ decision: "ask_user", reason: "需确认" });
  expect(parseReviewJson('{"decision":"auto_approve"}')).toBeUndefined();
  expect(parseReviewJson("not json")).toBeUndefined();
});

test("buildReviewPrompt 隔离上下文并标明不可信输入", () => {
  const prompt = buildReviewPrompt(sampleInput);
  expect(prompt).toContain("不可信输入");
  expect(prompt).toContain("cd packages/app && bun test");
});

test("BRIDGE_AGY_AUTO_REVIEW=off 时直接降级为 ask_user", async () => {
  process.env.BRIDGE_AGY_AUTO_REVIEW = "off";
  const res = await runAutoReview(sampleInput);
  expect(res.decision).toBe("ask_user");
  expect(res.source).toBe("disabled");
});

test("API 自审核正常放行与异常/超时/畸形响应 fail-closed 降级为 ask_user", async () => {
  process.env.GEMINI_API_KEY = "test-key";

  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: '{"decision":"allow","reason":"沙箱内可逆测试"}' }] } }] }), {
      status: 200,
    })) as any;
  const ok = await runAutoReview(sampleInput);
  expect(ok).toEqual({ decision: "allow", reason: "沙箱内可逆测试", source: "api" });

  // HTTP 500 -> fail-closed
  globalThis.fetch = (async () => new Response("err", { status: 500 })) as any;
  const failHttp = await runAutoReview(sampleInput);
  expect(failHttp.decision).toBe("ask_user");
  expect(failHttp.source).toBe("fail_closed");

  // 畸形输出 -> fail-closed
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "随便回复一段非JSON" }] } }] }), { status: 200 })) as any;
  const failParse = await runAutoReview(sampleInput);
  expect(failParse.decision).toBe("ask_user");
  expect(failParse.source).toBe("fail_closed");

  // 网络异常 -> fail-closed
  globalThis.fetch = (async () => { throw new Error("network down"); }) as any;
  const failNet = await runAutoReview(sampleInput);
  expect(failNet.decision).toBe("ask_user");
  expect(failNet.source).toBe("fail_closed");
});
