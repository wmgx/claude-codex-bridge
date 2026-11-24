import { afterAll, afterEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tempState = mkdtempSync(join(tmpdir(), "bridge-waiter-test-"));
process.env.XDG_STATE_HOME = tempState;

const { Session } = await import("./session");
const { appendEvent, gcState, readStatus, readWaitCursor, registerThread, writeDecision, writeLastEmitted } = await import("./state");
const { stripInternalFields, waitForNextEvent } = await import("./waiter");

const log = spyOn(console, "log").mockImplementation(() => {});
afterEach(() => log.mockClear());
afterAll(() => rmSync(tempState, { recursive: true, force: true }));

test("waitForNextEvent 跳过 heartbeat，按 wait-cursor 顺序消费已到达事件不丢失", async () => {
  const tid = "w-thread-1";
  appendEvent(tid, { agent: "codex", event: "heartbeat", threadId: tid, turnId: "t1" });
  appendEvent(tid, { agent: "codex", event: "turn_completed", threadId: tid, turnId: "t1", text: "first" });
  appendEvent(tid, { agent: "codex", event: "turn_completed", threadId: tid, turnId: "t2", text: "second" });

  const r1 = await waitForNextEvent(tid, { checkWatcher: () => process.pid, pollMs: 10 });
  expect(r1.kind).toBe("event");
  if (r1.kind === "event") {
    expect(stripInternalFields(r1.event)).toEqual({ agent: "codex", event: "turn_completed", threadId: tid, turnId: "t1", text: "first" });
    expect(readWaitCursor(tid)).toBe(2);
  }

  const r2 = await waitForNextEvent(tid, { checkWatcher: () => process.pid, pollMs: 10 });
  expect(r2.kind).toBe("event");
  if (r2.kind === "event") {
    expect(r2.event.turnId).toBe("t2");
    expect(readWaitCursor(tid)).toBe(3);
  }
});

test("审批不断链闭环：Session 保持连接存活，Waiter 1 立即唤醒审批，approve 后 Waiter 2 收到 turn_completed", async () => {
  const tid = "w-thread-2";
  const responses: Array<{ id: unknown; result: unknown }> = [];
  const fakeClient: any = {
    request: async () => ({}),
    respond(id: unknown, result: unknown) { responses.push({ id, result }); },
    respondError() {},
  };

  const session = new Session(tid, null, 0, { backend: "codex" });
  session.attach(fakeClient);
  session.run();

  try {
    fakeClient.onNotification({ method: "turn/started", params: { threadId: tid, turn: { id: "t1" } } });
    // 异步触发审批请求
    setTimeout(() => {
      fakeClient.onServerRequest({
        id: 42,
        method: "item/commandExecution/requestApproval",
        params: { command: "git push origin main", cwd: "/repo", reason: "push" },
      });
    }, 30);

    // Waiter #1 立即被 approval_requested 唤醒退出，同时 session 仍持有连接
    const w1 = await waitForNextEvent(tid, { checkWatcher: () => process.pid, pollMs: 15 });
    expect(w1.kind).toBe("event");
    if (w1.kind !== "event") throw new Error("expected approval_requested");
    expect(w1.event.event).toBe("approval_requested");
    expect(w1.event.requestId).toBe("42");

    // status.json 里能直接看到待审请求
    expect(readStatus(tid)?.pendingApprovals).toMatchObject([{ requestId: "42", command: "git push origin main" }]);

    // 用户同意后写入决定，仍在存活的 session 读到并回复给 Codex 连接
    writeDecision(tid, "42", "accept");
    await Bun.sleep(600);
    expect(responses).toEqual([{ id: 42, result: { decision: "accept" } }]);
    expect(readStatus(tid)?.pendingApprovals).toBeUndefined();

    // 紧接着该轮完成，Waiter #2 立刻拿到 turn_completed
    fakeClient.onNotification({ method: "item/completed", params: { threadId: tid, turnId: "t1", item: { type: "agentMessage", phase: "final_answer", text: "pushed ok" } } });
    fakeClient.onNotification({ method: "turn/completed", params: { threadId: tid, turn: { id: "t1", status: "completed" } } });

    const w2 = await waitForNextEvent(tid, { checkWatcher: () => process.pid, pollMs: 15 });
    expect(w2.kind).toBe("event");
    if (w2.kind === "event") {
      expect(w2.event.event).toBe("turn_completed");
      expect(w2.event.text).toBe("pushed ok");
    }
  } finally {
    session.stop();
  }
});

test("超时返回 timeout；watcher 意外退出返回 watcher_exited；退出前刚写入的事件不丢失", async () => {
  const tid1 = "w-thread-timeout";
  const rTimeout = await waitForNextEvent(tid1, { checkWatcher: () => process.pid, pollMs: 10, timeoutMs: 40 });
  expect(rTimeout.kind).toBe("timeout");

  const tid2 = "w-thread-dead";
  const rDead = await waitForNextEvent(tid2, { checkWatcher: () => undefined, pollMs: 10 });
  expect(rDead.kind).toBe("watcher_exited");

  const tid3 = "w-thread-final-ev";
  appendEvent(tid3, { agent: "codex", event: "closed", threadId: tid3, reason: "重连超时" });
  const rFinal = await waitForNextEvent(tid3, { checkWatcher: () => undefined, pollMs: 10 });
  expect(rFinal.kind).toBe("event");
  if (rFinal.kind === "event") expect(rFinal.event.event).toBe("closed");
});

test("Session idleExitMs 在空闲时触发退出，有活跃轮次时不触发", async () => {
  const tid = "w-thread-idle";
  let exited = false;
  const fakeClient: any = { request: async () => ({}), respond() {}, respondError() {} };
  const session = new Session(tid, null, 0, {
    backend: "codex",
    idleExitMs: 60,
    onIdleExit: () => { exited = true; },
  });
  session.attach(fakeClient);
  // 有活跃轮次时不应触发空闲退出
  fakeClient.onNotification({ method: "turn/started", params: { threadId: tid, turn: { id: "t1" } } });
  await Bun.sleep(100);
  expect(exited).toBe(false);

  // 轮次结束后开始计时并触发空闲退出
  fakeClient.onNotification({ method: "turn/completed", params: { threadId: tid, turn: { id: "t1", status: "completed" } } });
  await Bun.sleep(100);
  expect(exited).toBe(true);
});

test("gcState 支持 dryRun，仅清理超期旧线程并保留近期线程", async () => {
  const { utimesSync, existsSync } = await import("node:fs");
  const { eventsLogPath } = await import("./state");

  const oldId = "gc-old-thread";
  const freshId = "gc-fresh-thread";
  writeLastEmitted(oldId, "t1");
  appendEvent(oldId, { agent: "codex", event: "turn_completed", threadId: oldId });
  registerThread({ threadId: oldId, backend: "codex", name: "old" });

  writeLastEmitted(freshId, "t1");
  registerThread({ threadId: freshId, backend: "codex", name: "fresh" });

  // 把 oldId 的文件与目录 mtime 拨回 20 天前
  const past = new Date(Date.now() - 20 * 86_400_000);
  const oldDir = join(tempState, "claude-codex-bridge", oldId);
  utimesSync(eventsLogPath(oldId), past, past);
  utimesSync(join(oldDir, "last-emitted"), past, past);
  utimesSync(oldDir, past, past);

  const dry = gcState({ days: 14, dryRun: true });
  expect(dry.cleanedThreads).toContain(oldId);
  expect(dry.cleanedThreads).not.toContain(freshId);
  expect(existsSync(oldDir)).toBe(true);

  const real = gcState({ days: 14, dryRun: false });
  expect(real.cleanedThreads).toContain(oldId);
  expect(real.prunedRegistry).toContain(oldId);
  expect(existsSync(oldDir)).toBe(false);
  expect(existsSync(join(tempState, "claude-codex-bridge", freshId))).toBe(true);
});
