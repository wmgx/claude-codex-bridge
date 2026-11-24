// 面向非 Monitor 宿主（如 Antigravity）的一次性事件等待与后台监听进程托管。
// 后台 watcher 持续持有与 Codex / agy daemon 的 WebSocket 连接（审批不断链），
// 前台 `--once` / `wait` / `send --wait` 按 wait-cursor 消费下一条需处理事件后立刻退出，实现零轮询即时唤醒。

import { dirname, join } from "node:path";
import { BridgeError, sleep } from "./out";
import {
  type Backend,
  type RecordedEvent,
  readEvents,
  readStatus,
  readWaitCursor,
  watcherPid,
  writeWaitCursor,
} from "./state";

const SCRIPTS_DIR = dirname(import.meta.dir);
const BRIDGE_SCRIPT = join(SCRIPTS_DIR, "bridge.ts");

// 这些事件需要唤醒宿主处理；heartbeat 等保活事件不触发退出。
export const ACTIONABLE_EVENTS = new Set([
  "turn_completed",
  "approval_requested",
  "approval_resolved",
  "codex_lost",
  "agy_lost",
  "approvals_dropped",
  "unsupported_request",
  "closed",
  "error",
]);

export const DEFAULT_DETACHED_IDLE_EXIT_MIN = 60;

export function takeNextActionableEvent(threadId: string): RecordedEvent | undefined {
  const cursor = readWaitCursor(threadId);
  const list = readEvents(threadId);
  const hit = list.find(e => e.seq > cursor && ACTIONABLE_EVENTS.has(String(e.event ?? "")));
  if (!hit) return undefined;
  writeWaitCursor(threadId, hit.seq);
  return hit;
}

export function stripInternalFields(ev: RecordedEvent): Record<string, unknown> {
  const { seq: _seq, at: _at, ...rest } = ev;
  return rest;
}

export type WaitResult =
  | { kind: "event"; event: RecordedEvent }
  | { kind: "timeout" }
  | { kind: "watcher_exited" };

export async function waitForNextEvent(
  threadId: string,
  opts: {
    timeoutMs?: number;
    pollMs?: number;
    checkWatcher?: () => number | undefined;
  } = {},
): Promise<WaitResult> {
  const pollMs = opts.pollMs ?? 250;
  const checkWatcher = opts.checkWatcher ?? (() => watcherPid(threadId));
  const deadline = opts.timeoutMs && opts.timeoutMs > 0 ? Date.now() + opts.timeoutMs : undefined;

  // 先检查是否已有未消费事件（防止事件在 approve 与 wait 间隙到达而漏掉）
  const immediate = takeNextActionableEvent(threadId);
  if (immediate) return { kind: "event", event: immediate };

  let lastWatcherCheck = 0;
  while (true) {
    const hit = takeNextActionableEvent(threadId);
    if (hit) return { kind: "event", event: hit };

    const now = Date.now();
    if (deadline !== undefined && now >= deadline) {
      return { kind: "timeout" };
    }

    if (now - lastWatcherCheck >= 1500) {
      lastWatcherCheck = now;
      if (checkWatcher() === undefined) {
        // 退出前再扫一次，避免 watcher 刚写完最终事件就退出的竞态
        const finalHit = takeNextActionableEvent(threadId);
        if (finalHit) return { kind: "event", event: finalHit };
        return { kind: "watcher_exited" };
      }
    }

    await sleep(pollMs);
  }
}

// 确保该线程有一个脱离终端的后台 watcher 在运行并已就绪订阅，避免快轮次漏事件。
export async function ensureDetachedWatcher(
  threadId: string,
  backend: Backend,
  opts: { idleExitMin?: number; bridgeScript?: string; readyTimeoutMs?: number } = {},
): Promise<{ pid: number; spawned: boolean }> {
  const existing = watcherPid(threadId);
  if (existing !== undefined) return { pid: existing, spawned: false };

  const idleExitMin = opts.idleExitMin ?? DEFAULT_DETACHED_IDLE_EXIT_MIN;
  const script = opts.bridgeScript ?? BRIDGE_SCRIPT;
  const child = Bun.spawn(
    [
      process.execPath,
      script,
      "watch",
      threadId,
      "--agent",
      backend,
      "--max-quiet",
      "0",
      "--idle-exit",
      String(idleExitMin),
    ],
    {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      detached: true,
      env: process.env,
    },
  );
  child.unref();

  const deadline = Date.now() + (opts.readyTimeoutMs ?? 15_000);
  while (Date.now() < deadline) {
    const pid = watcherPid(threadId);
    const st = readStatus(threadId);
    if (pid !== undefined && st && st.pid === pid && st.ready) {
      return { pid, spawned: true };
    }
    await sleep(100);
  }
  throw new BridgeError("后台监听进程启动超时", `可用 \`bridge status ${threadId}\` 或手动 \`bridge watch ${threadId}\` 排查`);
}

export async function stopWatcher(threadId: string): Promise<{ stopped: boolean; wasRunning: boolean; pid?: number }> {
  const pid = watcherPid(threadId);
  if (pid === undefined) return { stopped: true, wasRunning: false };
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return { stopped: true, wasRunning: false };
  }
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (watcherPid(threadId) === undefined) {
      return { stopped: true, wasRunning: true, pid };
    }
    await sleep(100);
  }
  try { process.kill(pid, "SIGKILL"); } catch {}
  return { stopped: true, wasRunning: true, pid };
}
