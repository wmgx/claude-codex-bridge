// 审批决定的落盘通道。
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

export function writeDecision(threadId: string, requestId: string, decision: Decision) {
  mkdirSync(dir(threadId), { recursive: true, mode: 0o700 });
  writeFileSync(file(threadId, requestId), JSON.stringify({ decision }), { mode: 0o600 });
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
