// agy 线程与轮次的本地持久化存储（~/.local/state/claude-codex-bridge/agy/threads/<threadId>.json）。
// 负责在 30 分钟 Monitor 换班、线程空闲回收或 daemon 重启后保留完整历史与 turn 游标。

import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { agyStateDir } from "../state";

export type StoredTurn = {
  id: string;
  status: "inProgress" | "completed" | "failed" | "cancelled";
  ask: string;
  report: string;
  actualModel?: string;
  errorDetail?: string;
  startedAt: string;
  completedAt?: string;
};

export type StoredAgyThread = {
  id: string;
  acpSessionId?: string;
  name: string;
  cwd: string;
  network: boolean;
  model?: string;
  effort?: string;
  nativeAutoActive: boolean;
  taskSummary: string;
  status: { type: "idle" | "active" | "notLoaded" | "systemError"; detail?: string };
  updatedAt: number; // Unix 秒，与 Codex thread/list 格式对齐
  turns: StoredTurn[];
};

const safe = (s: string) => s.replace(/[^\w-]/g, "_");
const threadsDir = () => join(agyStateDir(), "threads");
const threadFile = (id: string) => join(threadsDir(), `${safe(id)}.json`);

function ensureDir() {
  mkdirSync(threadsDir(), { recursive: true, mode: 0o700 });
}

export function saveAgyThread(t: StoredAgyThread) {
  ensureDir();
  const path = threadFile(t.id);
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(t, null, 2), { mode: 0o600 });
  renameSync(tmp, path);
}

export function loadAgyThread(id: string): StoredAgyThread | undefined {
  try {
    return JSON.parse(readFileSync(threadFile(id), "utf8"));
  } catch {
    return undefined;
  }
}

export function listStoredAgyThreads(): StoredAgyThread[] {
  try {
    const files = readdirSync(threadsDir()).filter(f => f.endsWith(".json"));
    const out: StoredAgyThread[] = [];
    for (const f of files) {
      try {
        out.push(JSON.parse(readFileSync(join(threadsDir(), f), "utf8")));
      } catch {}
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt);
  } catch {
    return [];
  }
}

// 启动恢复：daemon 异常重启后，把遗留在磁盘上的 inProgress 轮次标为失败，避免 watch 误以为仍在跑。
export function recoverInterruptedThreads() {
  for (const t of listStoredAgyThreads()) {
    let changed = false;
    for (const turn of t.turns) {
      if (turn.status === "inProgress") {
        turn.status = "failed";
        turn.errorDetail = "agy-daemon 已重启，进行中的轮次已中断";
        turn.completedAt = new Date().toISOString();
        changed = true;
      }
    }
    if (t.status.type === "active") {
      t.status = { type: "systemError", detail: "agy-daemon 已重启，进行中的轮次已中断" };
      changed = true;
    }
    if (changed) {
      t.updatedAt = Math.floor(Date.now() / 1000);
      saveAgyThread(t);
    }
  }
}

// 转换为 Codex app-server 同构结构，便于 Session / threads.ts 零修改复用。
export function toBridgeThreadShape(t: StoredAgyThread, includeTurns: boolean) {
  const firstAsk = t.turns[0]?.ask ?? "";
  return {
    id: t.id,
    name: t.name,
    cwd: t.cwd,
    status: t.status,
    updatedAt: t.updatedAt,
    preview: firstAsk.split("\n")[0].slice(0, 80),
    ...(includeTurns
      ? {
          turns: t.turns.map(turn => ({
            id: turn.id,
            status: turn.status,
            ...(turn.actualModel ? { actualModel: turn.actualModel } : {}),
            ...(turn.errorDetail ? { errorDetail: turn.errorDetail } : {}),
            items: [
              { type: "userMessage", content: [{ type: "text", text: turn.ask }] },
              ...(turn.report ? [{ type: "agentMessage", phase: "final_answer", text: turn.report }] : []),
            ],
          })),
        }
      : {}),
  };
}
