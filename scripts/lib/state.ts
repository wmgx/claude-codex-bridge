// 按线程落盘的状态：审批决定、上报进度、监听进程。
// 审批请求只能在持有订阅的那条连接上回复，所以 `approve` / `deny` 命令把决定写成文件，
// 由正在监听的进程读到后再回复 daemon。

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const BASE = join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "claude-codex-bridge");

export type Decision = "accept" | "acceptForSession" | "decline";

const safe = (s: string) => s.replace(/[^\w-]/g, "_");
const dir = (threadId: string) => join(BASE, safe(threadId));
const file = (threadId: string, requestId: string) => join(dir(threadId), `${safe(requestId)}.json`);
const lastEmittedFile = (threadId: string) => join(dir(threadId), "last-emitted");
const watcherFile = (threadId: string) => join(dir(threadId), "watcher.pid");

function write(threadId: string, path: string, content: string) {
  mkdirSync(dir(threadId), { recursive: true, mode: 0o700 });
  writeFileSync(path, content, { mode: 0o600 });
}

export function writeDecision(threadId: string, requestId: string, decision: Decision) {
  write(threadId, file(threadId, requestId), JSON.stringify({ decision }));
}

// 读取并删除一个决定；没有则返回 undefined。
export function takeDecision(threadId: string, requestId: string): Decision | undefined {
  try {
    const { decision } = JSON.parse(readFileSync(file(threadId, requestId), "utf8"));
    rmSync(file(threadId, requestId), { force: true });
    return ["accept", "acceptForSession", "decline"].includes(decision) ? decision : undefined;
  } catch {
    return undefined;
  }
}

// 最后一个已上报的完成轮。落盘后，监听进程换了一个（Monitor 到期后重新 watch）也能接着补发。
// null 表示有记录但还没上报过任何轮次。
export function writeLastEmitted(threadId: string, turnId: string | null) {
  write(threadId, lastEmittedFile(threadId), turnId ?? "");
}

// undefined 表示没有记录（线程不是本工具开的，或是旧版本开的）。
export function readLastEmitted(threadId: string): string | null | undefined {
  try {
    return readFileSync(lastEmittedFile(threadId), "utf8").trim() || null;
  } catch {
    return undefined;
  }
}

// 登记当前进程为该线程的监听进程。
export function claimWatcher(threadId: string) {
  write(threadId, watcherFile(threadId), String(process.pid));
}

// 该线程仍在运行的监听进程 pid；没有则返回 undefined。
export function watcherPid(threadId: string): number | undefined {
  try {
    const pid = Number(readFileSync(watcherFile(threadId), "utf8"));
    if (!pid || pid === process.pid) return undefined;
    process.kill(pid, 0); // 只探活，不发信号
    return pid;
  } catch {
    return undefined;
  }
}

// 监听进程每次探活后写一份：Claude 随时能用 `status` 查到 Codex 是否还活着，不必等事件。
export type Status = { pid: number; updatedAt: string; daemon: "up" | "reconnecting" | "down"; thread?: string; activeTurnId?: string };

const statusFile = (threadId: string) => join(dir(threadId), "status.json");

export function writeStatus(threadId: string, s: Omit<Status, "pid" | "updatedAt">) {
  write(threadId, statusFile(threadId), JSON.stringify({ pid: process.pid, updatedAt: new Date().toISOString(), ...s }));
}

export function readStatus(threadId: string): Status | undefined {
  try { return JSON.parse(readFileSync(statusFile(threadId), "utf8")); } catch { return undefined; }
}
