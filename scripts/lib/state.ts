// 按线程落盘的状态：审批决定、上报进度、监听进程、双后端线程注册表、权限审计日志。
// 审批请求只能在持有订阅的那条连接上回复，所以 `approve` / `deny` 命令把决定写成文件，
// 由正在监听的进程读到后再回复 daemon。

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type Backend = "codex" | "agy";
export type Decision = "accept" | "acceptForSession" | "decline";

export const stateBase = () => join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "claude-codex-bridge");
export const agyStateDir = () => join(stateBase(), "agy");
export const agySockPath = () => join(stateBase(), "agy-daemon.sock");
export const agyDaemonPidFile = () => join(agyStateDir(), "daemon.pid");

const safe = (s: string) => s.replace(/[^\w-]/g, "_");
const dir = (threadId: string) => join(stateBase(), safe(threadId));
const file = (threadId: string, requestId: string) => join(dir(threadId), `${safe(requestId)}.json`);
const lastEmittedFile = (threadId: string) => join(dir(threadId), "last-emitted");
const watcherFile = (threadId: string) => join(dir(threadId), "watcher.pid");
const statusFile = (threadId: string) => join(dir(threadId), "status.json");
const eventsFile = (threadId: string) => join(dir(threadId), "events.jsonl");
const waitCursorFile = (threadId: string) => join(dir(threadId), "wait-cursor");
const registryFile = () => join(stateBase(), "threads.json");

export const auditLogPath = (threadId: string) => join(dir(threadId), "audit.jsonl");
export const eventsLogPath = (threadId: string) => eventsFile(threadId);

function ensureDir(p: string) {
  mkdirSync(p, { recursive: true, mode: 0o700 });
}

function write(threadId: string, path: string, content: string) {
  ensureDir(dir(threadId));
  writeFileSync(path, content, { mode: 0o600 });
}

function writeAtomic(path: string, content: string) {
  ensureDir(stateBase());
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, content, { mode: 0o600 });
  renameSync(tmp, path);
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

// 仅当 watcher.pid 属于当前进程时清理，避免误删新监听进程的记录。
export function releaseWatcher(threadId: string) {
  try {
    const pid = Number(readFileSync(watcherFile(threadId), "utf8"));
    if (pid === process.pid) rmSync(watcherFile(threadId), { force: true });
  } catch {}
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

export type PendingApprovalSummary = {
  requestId: string;
  kind: string;
  command?: string;
  grantRoot?: string;
  cwd?: string;
  reason?: string;
};

export type ProgressSummary = {
  toolCalls: number;
  lastTool?: string;
  lastToolStatus?: string;
  tokensUsed?: number;
  tokenLimit?: number;
  updatedAt: string;
};

// 监听进程每次探活后写一份：Claude / Antigravity 随时能用 `status` 查到执行端是否还活着及待审请求。
export type Status = {
  pid: number;
  updatedAt: string;
  daemon: "up" | "reconnecting" | "down";
  thread?: string;
  activeTurnId?: string;
  backend?: Backend;
  ready?: boolean;
  pendingApprovals?: PendingApprovalSummary[];
  progress?: ProgressSummary;
};

export function writeStatus(threadId: string, s: Omit<Status, "pid" | "updatedAt">) {
  write(threadId, statusFile(threadId), JSON.stringify({ pid: process.pid, updatedAt: new Date().toISOString(), ...s }));
}

export function readStatus(threadId: string): Status | undefined {
  try { return JSON.parse(readFileSync(statusFile(threadId), "utf8")); } catch { return undefined; }
}

// 线程事件日志（供 --once / wait / send --wait 无竞争消费，每行带单调递增 seq）。
export type RecordedEvent = Record<string, unknown> & { seq: number; at: string };

export function readEvents(threadId: string): RecordedEvent[] {
  try {
    const raw = readFileSync(eventsFile(threadId), "utf8");
    const out: RecordedEvent[] = [];
    for (const line of raw.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try { out.push(JSON.parse(t)); } catch {}
    }
    return out;
  } catch {
    return [];
  }
}

export function latestEventSeq(threadId: string): number {
  const list = readEvents(threadId);
  return list.at(-1)?.seq ?? 0;
}

export function appendEvent(threadId: string, event: Record<string, unknown>): RecordedEvent {
  ensureDir(dir(threadId));
  const seq = latestEventSeq(threadId) + 1;
  const rec: RecordedEvent = { ...event, seq, at: new Date().toISOString() };
  appendFileSync(eventsFile(threadId), JSON.stringify(rec) + "\n", { mode: 0o600 });
  return rec;
}

export function readWaitCursor(threadId: string): number {
  try {
    const n = Number(readFileSync(waitCursorFile(threadId), "utf8").trim());
    return Number.isFinite(n) && n >= 0 ? n : 0;
  } catch {
    return 0;
  }
}

export function writeWaitCursor(threadId: string, seq: number) {
  write(threadId, waitCursorFile(threadId), String(seq));
}

// 权限审计日志（每行一条 JSON，供排障和人工核查自审核/白名单/人工放行记录）。
export type AuditEntry = Record<string, unknown> & {
  at: string;
  stage?: string;
  decision?: string;
  reason?: string;
  kind?: string;
  command?: string;
  locations?: string[];
  requestId?: string;
};

export function appendAudit(threadId: string, entry: Record<string, unknown>) {
  ensureDir(dir(threadId));
  appendFileSync(auditLogPath(threadId), JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n", { mode: 0o600 });
}

export function readAudit(threadId: string): AuditEntry[] {
  try {
    const raw = readFileSync(auditLogPath(threadId), "utf8");
    const out: AuditEntry[] = [];
    for (const line of raw.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try { out.push(JSON.parse(t)); } catch {}
    }
    return out;
  } catch {
    return [];
  }
}

export type AuditSummary = {
  total: number;
  byStage: Record<string, number>;
  byDecision: Record<string, number>;
  recent: AuditEntry[];
};

export function summarizeAudit(entries: AuditEntry[], limit = 20): AuditSummary {
  const byStage: Record<string, number> = {};
  const byDecision: Record<string, number> = {};
  for (const e of entries) {
    const stage = String(e.stage ?? "unknown");
    const dec = String(e.decision ?? "unknown");
    byStage[stage] = (byStage[stage] ?? 0) + 1;
    byDecision[dec] = (byDecision[dec] ?? 0) + 1;
  }
  return {
    total: entries.length,
    byStage,
    byDecision,
    recent: limit > 0 ? entries.slice(-limit) : [],
  };
}

export function agyLogPath(tag = "shared-acp"): string {
  return join(agyStateDir(), "logs", `${safe(tag)}.log`);
}

export function readTailLines(path: string, limit = 50): string[] {
  try {
    const lines = readFileSync(path, "utf8").split("\n").filter(l => l.length > 0);
    return limit > 0 ? lines.slice(-limit) : lines;
  } catch {
    return [];
  }
}

// 本地线程注册表：记录 threadId 属于哪个执行端（codex / agy），让 send / watch / approve / status 免传 --agent。
export type ThreadRecord = {
  threadId: string;
  backend: Backend;
  name?: string;
  cwd?: string;
  updatedAt: string;
};

function readRegistryMap(): Record<string, ThreadRecord> {
  try {
    const parsed = JSON.parse(readFileSync(registryFile(), "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function registerThread(rec: Omit<ThreadRecord, "updatedAt">) {
  const map = readRegistryMap();
  const prev = map[rec.threadId];
  map[rec.threadId] = {
    threadId: rec.threadId,
    backend: rec.backend,
    name: rec.name ?? prev?.name,
    cwd: rec.cwd ?? prev?.cwd,
    updatedAt: new Date().toISOString(),
  };
  writeAtomic(registryFile(), JSON.stringify(map, null, 2));
}

export function getThreadRecord(threadId: string): ThreadRecord | undefined {
  return readRegistryMap()[threadId];
}

export function listRegisteredThreads(backend?: Backend): ThreadRecord[] {
  const list = Object.values(readRegistryMap());
  return (backend ? list.filter(r => r.backend === backend) : list)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function findRegisteredThreads(ref: string, backend?: Backend): ThreadRecord[] {
  const list = listRegisteredThreads(backend);
  const byId = list.find(r => r.threadId === ref);
  if (byId) return [byId];
  const exact = list.filter(r => r.name === ref);
  if (exact.length > 0) return exact;
  return list.filter(r => typeof r.name === "string" && r.name.includes(ref));
}

export type GcResult = {
  dryRun: boolean;
  days: number;
  cleanedThreads: string[];
  removedAgyThreads: string[];
  removedLogs: string[];
  prunedRegistry: string[];
};

function newestMtimeInDir(dirPath: string): number {
  let max = statSync(dirPath).mtimeMs;
  try {
    for (const entry of readdirSync(dirPath)) {
      try {
        const m = statSync(join(dirPath, entry)).mtimeMs;
        if (m > max) max = m;
      } catch {}
    }
  } catch {}
  return max;
}

// 清理超过指定天数且无活跃监听/活跃轮次的旧线程状态目录、agy 持久化文件与日志。
export function gcState(opts: { days?: number; dryRun?: boolean; nowMs?: number } = {}): GcResult {
  const days = opts.days ?? 14;
  const dryRun = Boolean(opts.dryRun);
  const now = opts.nowMs ?? Date.now();
  const cutoff = now - days * 86_400_000;

  const cleanedThreads: string[] = [];
  const removedAgyThreads: string[] = [];
  const removedLogs: string[] = [];
  const prunedRegistry: string[] = [];

  const base = stateBase();
  const reserved = new Set(["agy", "threads.json", "agy-daemon.sock"]);

  if (existsSync(base)) {
    for (const name of readdirSync(base)) {
      if (reserved.has(name) || name.endsWith(".tmp")) continue;
      const full = join(base, name);
      try {
        if (!statSync(full).isDirectory()) continue;
        if (watcherPid(name) !== undefined) continue;
        if (newestMtimeInDir(full) >= cutoff) continue;
        cleanedThreads.push(name);
        if (!dryRun) rmSync(full, { recursive: true, force: true });
      } catch {}
    }
  }

  const agyThreadsDir = join(agyStateDir(), "threads");
  if (existsSync(agyThreadsDir)) {
    for (const f of readdirSync(agyThreadsDir)) {
      if (!f.endsWith(".json")) continue;
      const full = join(agyThreadsDir, f);
      try {
        const st = statSync(full);
        const parsed = JSON.parse(readFileSync(full, "utf8"));
        const id = String(parsed?.id ?? f.slice(0, -5));
        if (parsed?.status?.type === "active" || watcherPid(id) !== undefined) continue;
        const updatedMs = typeof parsed?.updatedAt === "number" ? parsed.updatedAt * 1000 : st.mtimeMs;
        if (Math.max(updatedMs, st.mtimeMs) >= cutoff) continue;
        removedAgyThreads.push(id);
        if (!dryRun) rmSync(full, { force: true });
      } catch {}
    }
  }

  const agyLogsDir = join(agyStateDir(), "logs");
  if (existsSync(agyLogsDir)) {
    for (const f of readdirSync(agyLogsDir)) {
      if (!f.endsWith(".log") || f === "shared-acp.log") continue;
      const full = join(agyLogsDir, f);
      try {
        if (statSync(full).mtimeMs >= cutoff) continue;
        removedLogs.push(f);
        if (!dryRun) rmSync(full, { force: true });
      } catch {}
    }
  }

  const reg = readRegistryMap();
  const cleanedSet = new Set([...cleanedThreads, ...removedAgyThreads]);
  let regChanged = false;
  for (const [id, rec] of Object.entries(reg)) {
    if (watcherPid(id) !== undefined) continue;
    const updatedMs = Date.parse(rec.updatedAt);
    const expired = Number.isFinite(updatedMs) && updatedMs < cutoff;
    if (cleanedSet.has(safe(id)) || cleanedSet.has(id) || (expired && !existsSync(dir(id)))) {
      prunedRegistry.push(id);
      delete reg[id];
      regChanged = true;
    }
  }
  if (regChanged && !dryRun) {
    writeAtomic(registryFile(), JSON.stringify(reg, null, 2));
  }

  return { dryRun, days, cleanedThreads, removedAgyThreads, removedLogs, prunedRegistry };
}
