// mock-ACP 全链路集成测试：
// 用真实子进程运行极简模拟 ACP 服务端，验证 AgyDaemonCore + AcpClient + Session + 持久化存储的完整闭环：
// 1. 流式输出过滤 agent_thought_chunk，提取最终汇报与 actualModel
// 2. 模拟 Monitor 30 分钟到期断线：任务在 daemon 内继续完成，新 watch 挂上后补发漏轮
// 3. 四段权限漏斗（白名单直放、自审核放行/拒绝、硬拒绝、高危转人工并在 Monitor 换班后补推待审请求）+ 审计日志
// 4. 子进程异常崩溃触发 agy_lost 并附 stderr 诊断
// 5. model/list 与中途切模型

import { afterAll, afterEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tempState = mkdtempSync(join(tmpdir(), "agy-daemon-state-"));
const tempWork = mkdtempSync(join(tmpdir(), "agy-daemon-work-"));
process.env.XDG_STATE_HOME = tempState;

const fakeAcpScript = join(tempWork, "fake-acp.ts");
writeFileSync(
  fakeAcpScript,
  `#!/usr/bin/env bun
// 极简模拟 agy acp 子进程（通过 stdin/stdout 行分隔 JSON-RPC 2.0 通信）
const modeEnv = process.env.FAKE_ACP_MODES || "default,accept-edits,auto";
const modes = modeEnv.split(",").filter(Boolean).map(id => ({ id, name: id }));
let curMode = modes[0]?.id || "default";
let curModel = "gemini-3.5-pro";
let reqSeq = 100;
const pending = new Map<number, (r: any) => void>();

function send(o: Record<string, unknown>) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...o }) + "\\n");
}

function askPermission(sessionId: string, toolCall: any): Promise<any> {
  return new Promise(resolve => {
    const id = ++reqSeq;
    pending.set(id, resolve);
    send({
      id,
      method: "session/request_permission",
      params: {
        sessionId,
        toolCall,
        options: [
          { optionId: "allow_once", kind: "allow_once", name: "Allow once" },
          { optionId: "allow_always", kind: "allow_always", name: "Allow always" },
          { optionId: "reject_once", kind: "reject_once", name: "Reject" },
        ],
      },
    });
  });
}

async function handlePrompt(id: unknown, sessionId: string, text: string) {
  if (text.includes("CRASH_NOW")) {
    process.stderr.write("OAuth token expired, please login again\\n");
    process.exit(42);
  }
  if (text.includes("THINK_AND_TOOL")) {
    send({ method: "session/update", params: { sessionId, update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "内部秘密思考" } } } });
    send({ method: "session/update", params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "先检查代码..." } } } });
    send({ method: "session/update", params: { sessionId, update: { sessionUpdate: "tool_call", toolCallId: "tc1", title: "read_file", kind: "read", status: "completed" } } });
    send({ method: "session/update", params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "最终汇报：一切通过" }, model: curModel } } });
    send({ id, result: { stopReason: "end_turn", model: curModel } });
    return;
  }
  if (text.includes("LONG_TURN")) {
    await Bun.sleep(120);
    send({ method: "session/update", params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "长跑任务在断线期间完成了" } } } });
    send({ id, result: { stopReason: "end_turn" } });
    return;
  }
  if (text.includes("PERM_FUNNEL")) {
    const r1 = await askPermission(sessionId, { kind: "execute", title: "shell", rawInput: { command: "bun test" } });
    const r2 = await askPermission(sessionId, { kind: "execute", title: "shell", rawInput: { command: "cd sub && bun test" } });
    const r3 = await askPermission(sessionId, { kind: "execute", title: "shell", rawInput: { command: "rm -rf /" } });
    const r4 = await askPermission(sessionId, { kind: "execute", title: "shell", rawInput: { command: "git push origin main" } });
    const summary = [r1, r2, r3, r4].map(r => r?.outcome?.optionId ?? "cancelled").join(",");
    send({ method: "session/update", params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "perms:" + summary } } } });
    send({ id, result: { stopReason: "end_turn" } });
    return;
  }
  send({ method: "session/update", params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "echo:" + curModel + ":" + curMode + ":" + text } } } });
  send({ id, result: { stopReason: "end_turn", model: curModel } });
}

const reader = Bun.stdin.stream().getReader();
const dec = new TextDecoder();
let buf = "";
while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  buf += dec.decode(value, { stream: true });
  let nl: number;
  while ((nl = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    if (msg.id !== undefined && !msg.method) {
      const fn = pending.get(msg.id);
      if (fn) { pending.delete(msg.id); fn(msg.result); }
      continue;
    }
    if (msg.method === "initialize") {
      send({ id: msg.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } });
    } else if (msg.method === "session/new") {
      send({
        id: msg.id,
        result: {
          sessionId: "acp-sess-1",
          modes: { currentModeId: curMode, availableModes: modes },
          models: {
            currentModelId: curModel,
            availableModels: [
              { modelId: "gemini-3.5-pro", name: "Gemini 3.5 Pro" },
              { modelId: "gemini-3.5-flash", name: "Gemini 3.5 Flash" },
            ],
          },
        },
      });
    } else if (msg.method === "session/resume" || msg.method === "session/load") {
      send({ id: msg.id, result: { sessionId: msg.params.sessionId, modes: { currentModeId: curMode, availableModes: modes } } });
    } else if (msg.method === "session/set_mode") {
      curMode = msg.params.modeId;
      send({ id: msg.id, result: {} });
    } else if (msg.method === "session/set_model") {
      curModel = msg.params.modelId;
      send({ id: msg.id, result: {} });
    } else if (msg.method === "session/prompt") {
      const text = msg.params.prompt?.[0]?.text ?? "";
      void handlePrompt(msg.id, msg.params.sessionId, text);
    }
  }
}
`,
);

const { AcpClient } = await import("./acp");
const { AgyDaemonCore } = await import("./daemon-core");
const { Session } = await import("../session");
const { auditLogPath, readLastEmitted, writeDecision, writeLastEmitted } = await import("../state");
const { sleep } = await import("../out");

const log = spyOn(console, "log").mockImplementation(() => {});
const events = () => log.mock.calls.map(([line]) => JSON.parse(line as string));

afterEach(() => log.mockClear());
afterAll(() => {
  rmSync(tempState, { recursive: true, force: true });
  rmSync(tempWork, { recursive: true, force: true });
});

// 内存直连 Peer <-> Client 适配器，绕开沙箱对 OS socket connect 的限制，完整测试 JSON-RPC 与 Session 状态机。
function connectInMemory(core: InstanceType<typeof AgyDaemonCore>, peerId: string) {
  let seq = 0;
  const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  const client: any = {
    onNotification: (_m: any) => {},
    onServerRequest: (_m: any) => {},
    onClose: () => {},
    request(method: string, params: unknown) {
      return new Promise((resolve, reject) => {
        const id = ++seq;
        pending.set(id, { resolve, reject });
        void core.handleMessage(peer, { id, method, params });
      });
    },
    respond(id: unknown, result: unknown) {
      void core.handleMessage(peer, { id, result });
    },
    respondError(id: unknown, message: string) {
      void core.handleMessage(peer, { id, error: { code: -32601, message } });
    },
    close() {
      core.unregisterPeer(peerId);
    },
  };
  const peer = {
    id: peerId,
    send(msg: any) {
      if (msg.method && msg.id !== undefined) return client.onServerRequest(msg);
      if (msg.method) return client.onNotification(msg);
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message));
      else p.resolve(msg.result);
    },
  };
  core.registerPeer(peer);
  return client;
}

function makeCore(opts: { modes?: string; reviewer?: any } = {}) {
  return new AgyDaemonCore({
    reviewer: opts.reviewer,
    userPolicy: () => ({}),
    spawnAcp: cwd => {
      const env: Record<string, string> = {};
      for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
      if (opts.modes) env.FAKE_ACP_MODES = opts.modes;
      return { acp: new AcpClient([process.execPath, fakeAcpScript], cwd, env), sandboxed: true };
    },
  });
}

async function waitFor(pred: () => boolean, timeoutMs = 4000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (pred()) return;
    await sleep(20);
  }
  throw new Error("waitFor timeout");
}

test("流式输出过滤 thought chunk、提取工具后最终汇报，并支持 model/list 与中途切模型", async () => {
  const core = makeCore();
  try {
    const c = connectInMemory(core, "p1");
    const { thread } = await c.request("thread/start", { cwd: tempWork });
    await c.request("thread/name/set", { threadId: thread.id, name: "[bridge] demo" });
    writeLastEmitted(thread.id, null);

    const session = new Session(thread.id, null, 0, { backend: "agy" });
    session.attach(c);

    await c.request("turn/start", { threadId: thread.id, input: [{ type: "text", text: "THINK_AND_TOOL" }] });
    await waitFor(() => events().some(e => e.event === "turn_completed"));

    const done = events().find(e => e.event === "turn_completed");
    expect(done.agent).toBe("agy");
    expect(done.text).toBe("最终汇报：一切通过");
    expect(done.text).not.toContain("内部秘密思考");
    expect(done.actualModel).toBe("gemini-3.5-pro");

    // 动态 model/list 与中途切模型
    const { data: models } = await c.request("model/list", {});
    expect(models.map((m: any) => m.model)).toEqual(["gemini-3.5-pro", "gemini-3.5-flash"]);

    log.mockClear();
    await c.request("turn/start", { threadId: thread.id, input: [{ type: "text", text: "hi" }], model: "gemini-3.5-flash" });
    await waitFor(() => events().some(e => e.event === "turn_completed"));
    expect(events().find(e => e.event === "turn_completed").text).toBe("echo:gemini-3.5-flash:auto:hi");
  } finally {
    core.stop();
  }
});

test("长跑任务跨 Monitor 断开不断线：watch 重连后自动补发漏掉的轮次", async () => {
  const core = makeCore();
  try {
    const c1 = connectInMemory(core, "watch-1");
    const { thread } = await c1.request("thread/start", { cwd: tempWork });
    writeLastEmitted(thread.id, null);
    await c1.request("turn/start", { threadId: thread.id, input: [{ type: "text", text: "LONG_TURN" }] });

    // 模拟 Monitor 30 分钟到期断开监听连接，但 agy-daemon 里的任务继续运行直至完成
    c1.close();
    await sleep(220);
    expect(events()).toEqual([]);

    // 新 Monitor 通过 watch 重连，自动补发漏掉的那一轮
    const c2 = connectInMemory(core, "watch-2");
    const session2 = new Session(thread.id, readLastEmitted(thread.id), 0, { backend: "agy" });
    session2.attach(c2);
    await session2.resume(c2);

    const missed = events().filter(e => e.event === "turn_completed");
    expect(missed).toHaveLength(1);
    expect(missed[0].text).toBe("长跑任务在断线期间完成了");
    expect(missed[0].agent).toBe("agy");
  } finally {
    core.stop();
  }
});

test("四段权限漏斗（白名单 + 自审核 + 硬拒绝 + 人工确认跨 watch 补推）与审计日志", async () => {
  const core = makeCore({
    modes: "default,accept-edits", // 模拟原生 auto 不可用，验证回退四段漏斗
    reviewer: async ({ permission }: any) => ({
      decision: permission.command?.includes("cd sub") ? "allow" : "ask_user",
      reason: "mock 自审核放行工作区复合测试",
      source: "api",
    }),
  });
  try {
    const c1 = connectInMemory(core, "p-perm-1");
    const { thread } = await c1.request("thread/start", { cwd: tempWork });
    writeLastEmitted(thread.id, null);

    // 启动前先断开 c1，模拟高危审批恰好发生在 Monitor 换班空档
    await c1.request("turn/start", { threadId: thread.id, input: [{ type: "text", text: "PERM_FUNNEL" }] });
    c1.close();
    await sleep(120);

    // 新监听进程连上后，daemon 立刻补推仍挂起的 git push 人工审批请求
    const c2 = connectInMemory(core, "p-perm-2");
    const session = new Session(thread.id, readLastEmitted(thread.id), 0, { backend: "agy" });
    session.attach(c2);
    await session.resume(c2);
    session.run();

    await waitFor(() => events().some(e => e.event === "approval_requested"));
    const req = events().find(e => e.event === "approval_requested");
    expect(req.command).toBe("git push origin main");

    // 模拟用户确认后 bridge approve 写入决定文件
    writeDecision(thread.id, req.requestId, "accept");
    await waitFor(() => events().some(e => e.event === "turn_completed"));
    session.stop();

    const done = events().find(e => e.event === "turn_completed");
    // r1(bun test)=allow_once, r2(cd sub && bun test)=allow_once(自审), r3(rm -rf /)=reject_once(硬拒绝), r4(git push)=allow_once(人工)
    expect(done.text).toBe("perms:allow_once,allow_once,reject_once,allow_once");

    // 检查审计日志完整落盘
    const auditLines = readFileSync(auditLogPath(thread.id), "utf8").trim().split("\n").map(l => JSON.parse(l));
    expect(auditLines.map(a => `${a.stage}:${a.decision}`)).toEqual([
      "allowlist:allow",
      "auto_review_api:allow",
      "hard_deny:deny",
      "hard_ask:ask_user",
      "user_decision:accept",
    ]);
  } finally {
    core.stop();
  }
});

test("agy acp 子进程异常退出时推送 agy_lost 并附带认证诊断提示", async () => {
  const core = makeCore();
  try {
    const c = connectInMemory(core, "p-crash");
    const { thread } = await c.request("thread/start", { cwd: tempWork });
    writeLastEmitted(thread.id, null);

    const session = new Session(thread.id, null, 0, { backend: "agy" });
    session.attach(c);

    await c.request("turn/start", { threadId: thread.id, input: [{ type: "text", text: "CRASH_NOW" }] });
    await waitFor(() => events().some(e => e.event === "agy_lost"));

    const lost = events().find(e => e.event === "agy_lost");
    expect(lost.agent).toBe("agy");
    expect(lost.status).toBe("systemError");
    expect(lost.detail).toContain("未登录或凭据已过期");
  } finally {
    core.stop();
  }
});
