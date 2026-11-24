#!/usr/bin/env bun
// claude-codex-bridge：让 Claude Code / Antigravity 通过本机 daemon 向 Codex 或 Antigravity (agy) 开线程、派活、收事件。
//
//   doctor [--agent codex|agy|all]
//   start <cwd> <text> [--agent codex|agy] [--name N] [--max-quiet M] [--model X] [--effort E] [--no-network] [--once] [--timeout S]
//                                      开线程并发第一轮；默认持续流式输出事件（Claude Monitor）；
//                                      加 --once 则后台托管监听并等到下一条需处理事件后立刻退出（适配 Antigravity 等非 Monitor 宿主）
//   watch <thread> [--agent codex|agy] [--max-quiet M] [--idle-exit M] [--once] [--timeout S]
//                                      重新订阅已有线程的事件（自动按注册表识别后端）
//   send <thread> <text> [--agent codex|agy] [--model X] [--effort E] [--wait] [--timeout S]
//                                      在同一线程继续发一轮；加 --wait 自动确保后台监听并等到下一条事件后退出
//   wait <thread> [--agent codex|agy] [--timeout S]
//                                      等待该线程的下一条需处理事件（如审批后继续等 turn_completed）并立刻退出
//   cancel <thread> [--agent codex|agy] 中断该线程当前正在运行的轮次
//   stop <thread> [--agent codex|agy]  停止该线程的后台监听进程（不删除线程历史）
//   （start / send 的 <text> 可以换成 --file <路径>，从文件读，避免长文本的 shell 转义问题）
//   approve <thread> <requestId> [--session]   同意一个审批请求（--session：本会话内同类免问）
//   deny <thread> <requestId>          拒绝一个审批请求
//   status <thread> [--agent codex|agy]查执行端是否还活着：daemon、线程状态、监听进程、待审请求、实时进度（只读，不拉起 daemon）
//   models [--agent codex|agy|all]     列出可选模型及各自支持的思考深度
//   list [--agent codex|agy|all]       列出 claude-codex-bridge 开过的线程
//   history <thread> [--limit N]       看最近几轮的提问与汇报
//   audit <thread> [--limit N] [--raw] 查看权限审计汇总（--raw 逐行输出明细）
//   logs <thread> [--limit N] [--acp]  查看线程最近事件流（--acp 查看 agy ACP 后台日志尾部）
//   rename <thread> <name>             改名
//   gc [--days N] [--dry-run]          清理超过 N 天（默认 14）且无活跃监听的旧状态与日志
//   daemon stop <codex|agy>            停止指定执行端的本地常驻 daemon
//
// <thread> 可以是线程 ID，也可以是 start 时起的名字。

import { readFileSync } from "node:fs";
import { listStoredAgyThreads, toBridgeThreadShape } from "./lib/agy/store";
import {
  backendAlive,
  backendSocket,
  connectBackend,
  detectAgySandbox,
  ensureBackendDaemon,
  observeCommand,
  parseBackend,
  parseBackendFilter,
  probeAgyCli,
  stopBackendDaemon,
} from "./lib/backend";
import { Client } from "./lib/client";
import { run } from "./lib/daemon";
import { BridgeError, out } from "./lib/out";
import { Session } from "./lib/session";
import {
  type Backend,
  type ProgressSummary,
  agyLogPath,
  auditLogPath,
  claimWatcher,
  eventsLogPath,
  findRegisteredThreads,
  gcState,
  getThreadRecord,
  latestEventSeq,
  readAudit,
  readEvents,
  readLastEmitted,
  readStatus,
  readTailLines,
  registerThread,
  releaseWatcher,
  summarizeAudit,
  watcherPid,
  writeDecision,
  writeLastEmitted,
  writeWaitCursor,
} from "./lib/state";
import {
  PREFIX,
  type TurnOptions,
  defaultName,
  interruptTurn,
  isAgyThreadId,
  isDirectThreadId,
  listModels,
  listThreads,
  renameThread,
  resolveThread,
  sendTurn,
  startThread,
  threadHistory,
} from "./lib/threads";
import {
  ensureDetachedWatcher,
  stopWatcher,
  stripInternalFields,
  waitForNextEvent,
} from "./lib/waiter";

type Flags = Map<string, string | true>;

const BOOL_FLAGS = new Set(["--session", "--no-network", "--once", "--wait", "--dry-run", "--raw", "--acp"]);
const VALUE_FLAGS = new Set(["--agent", "--name", "--limit", "--max-quiet", "--file", "--model", "--effort", "--idle-exit", "--timeout", "--days"]);

// 允许 flag 出现在子命令前或后，并支持 --flag=value 写法。
function parseArgs(argv: string[]) {
  const pos: string[] = [];
  const flags: Flags = new Map();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (BOOL_FLAGS.has(a)) {
      flags.set(a.slice(2), true);
    } else if (VALUE_FLAGS.has(a)) {
      const v = argv[++i];
      if (v === undefined) throw new BridgeError(`${a} 后面需要一个值`);
      flags.set(a.slice(2), v);
    } else if (a.startsWith("--") && a.includes("=")) {
      const eq = a.indexOf("=");
      const k = a.slice(0, eq);
      const v = a.slice(eq + 1);
      if (VALUE_FLAGS.has(k)) flags.set(k.slice(2), v);
      else pos.push(a);
    } else {
      pos.push(a);
    }
  }
  const [cmd, ...restPos] = pos;
  return { cmd, pos: restPos, flags };
}

// 默认按 1 小时 prompt 缓存有效期留出余量。
const DEFAULT_MAX_QUIET_MIN = 50;

function nonNegNumber(flags: Flags, key: string, defaultVal: number, unitLabel: string): number {
  const raw = flags.get(key);
  if (raw === undefined) return defaultVal;
  const n = Number(raw);
  if (raw === "" || !Number.isFinite(n) || n < 0) throw new BridgeError(`--${key} 需要非负数字（${unitLabel}）`);
  return n;
}

const quietMs = (flags: Flags) => nonNegNumber(flags, "max-quiet", DEFAULT_MAX_QUIET_MIN, "分钟") * 60_000;
const idleExitMs = (flags: Flags) => nonNegNumber(flags, "idle-exit", 0, "分钟") * 60_000;
const waitTimeoutMs = (flags: Flags) => nonNegNumber(flags, "timeout", 0, "秒") * 1000;

const turnOptions = (flags: Flags): TurnOptions => ({
  model: flags.get("model") as string | undefined,
  effort: flags.get("effort") as string | undefined,
});

function textOf(pos: string[], flags: Flags, idx: number): string {
  const path = flags.get("file");
  let text = pos[idx] ?? "";
  if (typeof path === "string") {
    try { text = readFileSync(path, "utf8"); }
    catch { throw new BridgeError(`读不到文件 ${path}`); }
  }
  if (!text.trim()) throw new BridgeError("文本为空");
  return text;
}

function sessionHooks(backend: Backend, idleMs = 0) {
  return {
    backend,
    ensureDaemon: () => ensureBackendDaemon(backend),
    connect: () => Client.connect(backendSocket(backend)),
    idleExitMs: idleMs,
  };
}

function installSignalCleanup(threadId: string, session: Session, client?: Client) {
  const clean = () => {
    session.stop();
    try { client?.close(); } catch {}
    releaseWatcher(threadId);
    process.exit(0);
  };
  process.on("SIGTERM", clean);
  process.on("SIGINT", clean);
}

// 从本地注册表和 agy 磁盘记录推断线程属于哪个后端（不拉起任何 daemon）。
function inferBackendOffline(ref: string, explicit?: Backend): { backend: Backend; threadId?: string } {
  if (explicit) return { backend: explicit, threadId: isDirectThreadId(ref) ? ref : undefined };

  // 先查注册表，避免用户起名为 "agy-smoke" 时被当成 agy 线程 ID
  const regHits = findRegisteredThreads(ref);
  if (regHits.length === 1) return { backend: regHits[0].backend, threadId: regHits[0].threadId };
  if (regHits.length > 1) {
    throw new BridgeError(
      `"${ref}" 匹配到 ${regHits.length} 个线程`,
      regHits.map(r => `[${r.backend}] ${r.threadId} ${r.name ?? ""}`).join("; ") + "；请改传线程 ID 或加 --agent",
    );
  }

  if (isAgyThreadId(ref)) return { backend: "agy", threadId: ref };

  // 兜底检查 agy 磁盘记录（兼容手动清理了 threads.json 的场景）
  const storedAgy = listStoredAgyThreads();
  const agyById = storedAgy.find(t => t.id === ref);
  if (agyById) return { backend: "agy", threadId: agyById.id };
  const agyExact = storedAgy.filter(t => t.name === PREFIX + ref);
  const agyHits = agyExact.length ? agyExact : storedAgy.filter(t => t.name.includes(ref));
  if (agyHits.length === 1) return { backend: "agy", threadId: agyHits[0].id };
  if (agyHits.length > 1) {
    throw new BridgeError(`"${ref}" 匹配到 ${agyHits.length} 个 agy 线程`, agyHits.map(t => `${t.id} ${t.name}`).join("; "));
  }

  return { backend: "codex", threadId: isDirectThreadId(ref) ? ref : undefined };
}

async function resolveTarget(ref: string, explicit?: Backend): Promise<{ backend: Backend; client: Client; threadId: string }> {
  const inferred = inferBackendOffline(ref, explicit);
  const client = await connectBackend(inferred.backend);
  const threadId = inferred.threadId ?? (await resolveThread(client, ref));
  if (!getThreadRecord(threadId)) {
    registerThread({ threadId, backend: inferred.backend });
  }
  return { backend: inferred.backend, client, threadId };
}

async function emitAndExitOnWait(backend: Backend, threadId: string, timeoutMs: number): Promise<never> {
  const res = await waitForNextEvent(threadId, { timeoutMs });
  if (res.kind === "event") {
    out(stripInternalFields(res.event));
    process.exit(0);
  }
  if (res.kind === "timeout") {
    out({
      agent: backend,
      event: "wait_timeout",
      threadId,
      timeoutSec: timeoutMs / 1000,
      hint: "任务仍在后台运行；可继续用 `bridge wait` 等待或 `bridge status` 查看状态",
    });
    process.exit(0);
  }
  out({
    agent: backend,
    event: "watcher_exited",
    threadId,
    hint: "监听进程已退出，用 `status` 查看线程状态或 `watch` 重新挂上",
  });
  process.exit(1);
}

async function doctor(flags: Flags) {
  const filter = parseBackendFilter(flags.get("agent"), "all");
  const checks: { group: "core" | Backend; name: string; ok: boolean; hint?: string }[] = [];

  const [maj, min] = Bun.version.split(".").map(Number);
  checks.push({
    group: "core",
    name: `Bun ${Bun.version}`,
    ok: maj > 1 || (maj === 1 && min >= 4),
    hint: "需要 Bun >= 1.4（支持 ws+unix），运行 `bun upgrade`",
  });

  if (filter === "codex" || filter === "all") {
    const codex = run(["codex", "--version"]);
    checks.push({ group: "codex", name: `Codex CLI ${codex.stdout || "(未安装)"}`, ok: codex.ok, hint: "安装 Codex CLI 并登录" });
    const alive = codex.ok && (await backendAlive("codex"));
    checks.push({ group: "codex", name: "Codex daemon 可连接", ok: alive, hint: "运行 `codex app-server daemon start`（其他命令也会自动尝试）" });
  }

  if (filter === "agy" || filter === "all") {
    const cli = probeAgyCli();
    checks.push({
      group: "agy",
      name: `Antigravity CLI (agy) ${cli.ok ? cli.version : "(未安装)"}`,
      ok: cli.ok && cli.acpOk,
      hint: cli.hint,
    });
    const sb = detectAgySandbox();
    checks.push({
      group: "agy",
      name: `agy 终端沙箱 ${sb.ok ? sb.kind : "(不可用)"}`,
      ok: sb.ok,
      hint: sb.hint,
    });
    const alive = cli.ok && (await backendAlive("agy"));
    checks.push({
      group: "agy",
      name: "agy-daemon 可连接",
      ok: alive,
      hint: "首次执行 `start --agent agy` 时会自动拉起，也可手动运行 `bun scripts/agy-daemon.ts`",
    });
  }

  for (const c of checks) {
    out({ group: c.group, check: c.name, ok: c.ok, ...(c.ok ? {} : { hint: c.hint }) });
  }

  const coreOk = checks.filter(c => c.group === "core").every(c => c.ok);
  const codexReady = checks.filter(c => c.group === "codex").every(c => c.ok);
  const agyCliReady = checks.filter(c => c.group === "agy" && !c.name.includes("daemon")).every(c => c.ok);
  const agyAllReady = checks.filter(c => c.group === "agy").every(c => c.ok);

  if (filter === "codex") process.exit(coreOk && codexReady ? 0 : 1);
  if (filter === "agy") process.exit(coreOk && agyAllReady ? 0 : 1);
  process.exit(coreOk && (codexReady || agyCliReady) ? 0 : 1);
}

const STATUS_STALE_MS = 90_000; // 探活 30 秒一次，连续 3 次没更新就算失联

// 只读查询，不拉起任何 daemon：daemon 不在就如实报 down。
async function status(ref: string, explicit?: Backend) {
  const inferred = inferBackendOffline(ref, explicit);
  const backend = inferred.backend;
  let daemon: "up" | "down" = "down";
  let thread: string | undefined;
  let liveProgress: ProgressSummary | undefined;
  let threadId = inferred.threadId ?? ref;

  if (await backendAlive(backend)) {
    try {
      const c = await Client.connect(backendSocket(backend));
      threadId = inferred.threadId ?? (await resolveThread(c, ref));
      const readRes = await c.request("thread/read", { threadId, includeTurns: false });
      thread = readRes.thread?.status?.type;
      liveProgress = readRes.thread?.progress;
      c.close();
      daemon = "up";
    } catch (e) {
      if (e instanceof BridgeError && /找不到|匹配到/.test(e.message)) throw e;
    }
  } else if (backend === "codex" && !isDirectThreadId(threadId)) {
    throw new BridgeError("daemon 不在线，无法按名字找线程", "改传线程 ID");
  }

  const saved = readStatus(threadId);
  const watcher = watcherPid(threadId);
  const age = saved ? Date.now() - Date.parse(saved.updatedAt) : undefined;
  const watcherStale = !!saved && watcher !== undefined && age! > STATUS_STALE_MS;
  const running = daemon === "up" ? thread === "active" : !!saved?.activeTurnId;
  const progress = liveProgress ?? (running ? saved?.progress : undefined);
  const problems = [
    daemon === "down" && `${backend} daemon 不在线`,
    thread === "systemError" && "线程处于 systemError",
    saved?.activeTurnId && thread === "notLoaded" && "线程在跑却已被卸载",
    running && watcher === undefined && "有轮次在跑但没有监听进程，结果和审批会漏掉",
    watcherStale && "监听进程的探活记录已过期",
    saved?.daemon === "down" && "监听进程重连 daemon 失败",
  ].filter(Boolean);

  out({
    agent: backend,
    threadId,
    ok: problems.length === 0,
    problems,
    daemon,
    thread,
    running,
    watcher: watcher ?? null,
    watcherReport: saved ? { daemon: saved.daemon, updatedAt: saved.updatedAt } : null,
    ...(saved?.pendingApprovals?.length ? { pendingApprovals: saved.pendingApprovals } : {}),
    ...(progress ? { progress } : {}),
  });
  process.exit(0);
}

async function listAllThreads(filter: Backend | "all") {
  const rows: any[] = [];

  if (filter === "codex" || filter === "all") {
    try {
      if (filter === "codex" || (await backendAlive("codex")) || run(["codex", "--version"]).ok) {
        const c = await connectBackend("codex");
        rows.push(...(await listThreads(c, "codex")));
        c.close();
      }
    } catch (e) {
      if (filter === "codex") throw e;
    }
  }

  if (filter === "agy" || filter === "all") {
    if (await backendAlive("agy")) {
      const c = await Client.connect(backendSocket("agy"));
      rows.push(...(await listThreads(c, "agy")));
      c.close();
    } else {
      for (const t of listStoredAgyThreads()) {
        if (!t.name.startsWith(PREFIX)) continue;
        const shape = toBridgeThreadShape(t, false);
        rows.push({
          agent: "agy",
          threadId: shape.id,
          name: shape.name.slice(PREFIX.length),
          cwd: shape.cwd,
          status: shape.status.type,
          updatedAt: new Date(shape.updatedAt * 1000).toISOString(),
          preview: shape.preview,
        });
      }
    }
  }

  rows.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  return rows;
}

async function main() {
  const { cmd, pos, flags } = parseArgs(process.argv.slice(2));
  const need = (n: number) => { if (pos.length !== n) throw new BridgeError("参数个数不对，见文件头部的用法"); };
  const explicitAgent = () => (flags.has("agent") ? parseBackend(flags.get("agent")) : undefined);

  if (cmd === "doctor") return doctor(flags);

  if (cmd === "gc") {
    need(0);
    const days = nonNegNumber(flags, "days", 14, "天");
    const res = gcState({ days, dryRun: flags.has("dry-run") });
    out(res);
    process.exit(0);
  }

  if (cmd === "daemon") {
    need(2);
    if (pos[0] !== "stop") throw new BridgeError("未知 daemon 子命令", "daemon stop <codex|agy>");
    const backend = parseBackend(pos[1]);
    const res = await stopBackendDaemon(backend);
    out({ agent: backend, ...res });
    process.exit(res.stopped ? 0 : 1);
  }

  if (cmd === "start") {
    need(flags.has("file") ? 1 : 2);
    const backend = parseBackend(flags.get("agent"), "codex");
    const cwd = pos[0];
    const text = textOf(pos, flags, 1);
    const quiet = quietMs(flags);
    const once = flags.has("once") || flags.has("wait");
    const timeout = waitTimeoutMs(flags);
    const opts = { ...turnOptions(flags), network: !flags.has("no-network") };
    const c = await connectBackend(backend);
    const name = typeof flags.get("name") === "string" && flags.get("name") ? String(flags.get("name")) : defaultName(text);
    const threadId = await startThread(c, cwd, name, { backend, ...opts });
    registerThread({ threadId, backend, name, cwd });
    writeLastEmitted(threadId, null);
    writeWaitCursor(threadId, latestEventSeq(threadId));
    const observe = observeCommand(backend, threadId);
    const networkDisplay = backend === "agy" ? "sandbox-default" : opts.network;

    if (once) {
      // 后台托管 watcher 持续持有 WebSocket 连接（确保审批不掉链），前台等下一条事件即退出。
      const { pid } = await ensureDetachedWatcher(threadId, backend);
      await sendTurn(c, threadId, text, opts);
      c.close();
      out({
        agent: backend,
        event: "started",
        threadId,
        name,
        mode: "auto",
        model: opts.model ?? "default",
        effort: opts.effort ?? "default",
        network: networkDisplay,
        once: true,
        watcher: pid,
        ...(observe ? { observe } : {}),
      });
      return emitAndExitOnWait(backend, threadId, timeout);
    }

    claimWatcher(threadId);
    // 先挂好事件处理再发第一轮，用同一条连接，不会漏掉快速结束的事件。
    const session = new Session(threadId, null, quiet, sessionHooks(backend, idleExitMs(flags)));
    session.attach(c);
    session.run();
    session.markReady();
    installSignalCleanup(threadId, session, c);
    await sendTurn(c, threadId, text, opts);
    out({
      agent: backend,
      event: "started",
      threadId,
      name,
      mode: "auto",
      model: opts.model ?? "default",
      effort: opts.effort ?? "default",
      network: networkDisplay,
      maxQuietMinutes: quiet / 60_000,
      ...(observe ? { observe } : {}),
    });
    return;
  }

  if (cmd === "watch") {
    need(1);
    const quiet = quietMs(flags);
    const once = flags.has("once") || flags.has("wait");
    const timeout = waitTimeoutMs(flags);
    const { backend, client: c, threadId } = await resolveTarget(pos[0], explicitAgent());
    const observe = observeCommand(backend, threadId);

    if (once) {
      c.close();
      const { pid } = await ensureDetachedWatcher(threadId, backend);
      out({
        agent: backend,
        event: "watching",
        threadId,
        once: true,
        watcher: pid,
        ...(observe ? { observe } : {}),
      });
      return emitAndExitOnWait(backend, threadId, timeout);
    }

    const pid = watcherPid(threadId);
    if (pid) throw new BridgeError(`线程已有监听进程（pid ${pid}）`, "不需要重复 watch；确实要换一个，先结束那个进程（可用 `bridge stop`）");
    claimWatcher(threadId);
    const session = new Session(threadId, readLastEmitted(threadId), quiet, sessionHooks(backend, idleExitMs(flags)));
    session.attach(c);
    await session.resume(c);
    session.run();
    session.markReady();
    installSignalCleanup(threadId, session, c);
    out({
      agent: backend,
      event: "watching",
      threadId,
      maxQuietMinutes: quiet / 60_000,
      ...(observe ? { observe } : {}),
    });
    return;
  }

  if (cmd === "wait") {
    need(1);
    const timeout = waitTimeoutMs(flags);
    const inferred = inferBackendOffline(pos[0], explicitAgent());
    let backend = inferred.backend;
    let threadId = inferred.threadId;
    if (!threadId) {
      const resolved = await resolveTarget(pos[0], explicitAgent());
      backend = resolved.backend;
      threadId = resolved.threadId;
      resolved.client.close();
    }
    await ensureDetachedWatcher(threadId, backend);
    return emitAndExitOnWait(backend, threadId, timeout);
  }

  if (cmd === "cancel") {
    need(1);
    const { backend, client: c, threadId } = await resolveTarget(pos[0], explicitAgent());
    const res = await interruptTurn(c, threadId, backend);
    c.close();
    out({ agent: backend, threadId, ...res });
    process.exit(0);
  }

  if (cmd === "stop") {
    need(1);
    const inferred = inferBackendOffline(pos[0], explicitAgent());
    let backend = inferred.backend;
    let threadId = inferred.threadId;
    if (!threadId) {
      const resolved = await resolveTarget(pos[0], explicitAgent());
      backend = resolved.backend;
      threadId = resolved.threadId;
      resolved.client.close();
    }
    const res = await stopWatcher(threadId);
    out({ agent: backend, threadId, ...res });
    process.exit(0);
  }

  if (cmd === "send") {
    need(flags.has("file") ? 1 : 2);
    const text = textOf(pos, flags, 1);
    const wait = flags.has("wait") || flags.has("once");
    const timeout = waitTimeoutMs(flags);
    const { backend, client: c, threadId } = await resolveTarget(pos[0], explicitAgent());

    if (wait) {
      // 确保后台监听已就绪后再发新轮次，并将游标对齐到发轮前，避免误读更早历史事件。
      const { pid } = await ensureDetachedWatcher(threadId, backend);
      if (!readStatus(threadId)?.pendingApprovals?.length) {
        writeWaitCursor(threadId, latestEventSeq(threadId));
      }
      await sendTurn(c, threadId, text, turnOptions(flags));
      c.close();
      out({ agent: backend, sent: true, threadId, watching: true, watcher: pid });
      return emitAndExitOnWait(backend, threadId, timeout);
    }

    await sendTurn(c, threadId, text, turnOptions(flags));
    const watching = watcherPid(threadId) !== undefined;
    out({
      agent: backend,
      sent: true,
      threadId,
      watching,
      ...(watching ? {} : { hint: "没有监听进程，收不到结果和审批请求；用 watch 挂上" }),
    });
    c.close();
    process.exit(0);
  }

  if (cmd === "approve" || cmd === "deny") {
    need(2);
    const { backend, client: c, threadId } = await resolveTarget(pos[0], explicitAgent());
    const decision = cmd === "deny" ? "decline" : flags.get("session") ? "acceptForSession" : "accept";
    writeDecision(threadId, pos[1], decision);
    out({ agent: backend, recorded: true, threadId, requestId: pos[1], decision });
    c.close();
    process.exit(0);
  }

  if (cmd === "status") {
    need(1);
    return status(pos[0], explicitAgent());
  }

  if (cmd === "models") {
    const filter = parseBackendFilter(flags.get("agent"), "codex");
    const backends: Backend[] = filter === "all" ? ["codex", "agy"] : [filter];
    for (const b of backends) {
      try {
        const c = await connectBackend(b);
        for (const m of await listModels(c)) out({ agent: b, ...m });
        c.close();
      } catch (e) {
        if (filter !== "all") throw e;
        out({ agent: b, error: e instanceof Error ? e.message : String(e) });
      }
    }
    process.exit(0);
  }

  if (cmd === "list") {
    const filter = parseBackendFilter(flags.get("agent"), "all");
    for (const t of await listAllThreads(filter)) out(t);
    process.exit(0);
  }

  if (cmd === "history") {
    need(1);
    const { backend, client: c, threadId } = await resolveTarget(pos[0], explicitAgent());
    const limit = Number(flags.get("limit")) || 5;
    for (const t of await threadHistory(c, threadId, limit)) out({ agent: backend, ...t });
    c.close();
    process.exit(0);
  }

  if (cmd === "audit") {
    need(1);
    const inferred = inferBackendOffline(pos[0], explicitAgent());
    let backend = inferred.backend;
    let threadId = inferred.threadId;
    if (!threadId) {
      const resolved = await resolveTarget(pos[0], explicitAgent());
      backend = resolved.backend;
      threadId = resolved.threadId;
      resolved.client.close();
    }
    const entries = readAudit(threadId);
    const raw = flags.has("raw");
    const limit = Number(flags.get("limit")) || (raw ? 50 : 20);
    if (raw) {
      if (entries.length === 0) out({ agent: backend, threadId, total: 0, auditFile: auditLogPath(threadId) });
      else for (const e of entries.slice(-limit)) out({ agent: backend, threadId, ...e });
    } else {
      out({ agent: backend, threadId, auditFile: auditLogPath(threadId), ...summarizeAudit(entries, limit) });
    }
    process.exit(0);
  }

  if (cmd === "logs") {
    need(1);
    const inferred = inferBackendOffline(pos[0], explicitAgent());
    let backend = inferred.backend;
    let threadId = inferred.threadId;
    if (!threadId) {
      const resolved = await resolveTarget(pos[0], explicitAgent());
      backend = resolved.backend;
      threadId = resolved.threadId;
      resolved.client.close();
    }
    const limit = Number(flags.get("limit")) || (flags.has("acp") ? 50 : 30);
    if (flags.has("acp")) {
      if (backend !== "agy") throw new BridgeError("--acp 日志仅适用于 agy 线程");
      const perThreadLog = agyLogPath(threadId);
      const sharedLog = agyLogPath("shared-acp");
      const perLines = readTailLines(perThreadLog, limit);
      const useShared = perLines.length === 0;
      const logFile = useShared ? sharedLog : perThreadLog;
      const lines = useShared ? readTailLines(sharedLog, limit) : perLines;
      out({ agent: backend, threadId, logFile, count: lines.length, lines });
      process.exit(0);
    }
    const events = readEvents(threadId);
    if (events.length === 0) {
      out({ agent: backend, threadId, total: 0, eventsFile: eventsLogPath(threadId) });
    } else {
      for (const e of events.slice(-limit)) out(e);
    }
    process.exit(0);
  }

  if (cmd === "rename") {
    need(2);
    const { backend, client: c, threadId } = await resolveTarget(pos[0], explicitAgent());
    await renameThread(c, threadId, pos[1]);
    registerThread({ threadId, backend, name: pos[1] });
    out({ agent: backend, renamed: true, threadId, name: pos[1] });
    c.close();
    process.exit(0);
  }

  throw new BridgeError("未知命令", "doctor | start | watch | wait | cancel | stop | send | approve | deny | status | models | list | history | audit | logs | rename | gc | daemon stop");
}

main().catch(e => {
  out({ error: e instanceof Error ? e.message : String(e), ...(e instanceof BridgeError && e.hint ? { hint: e.hint } : {}) });
  process.exit(1);
});
