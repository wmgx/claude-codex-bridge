#!/usr/bin/env bun
// claude-codex-bridge：让 Claude Code 通过 Codex 本地 app-server daemon 开线程、派活、收事件。
//
//   doctor
//   start <cwd> <text> [--name N] [--max-quiet M]   开线程并发第一轮，之后持续输出事件
//   watch <thread> [--max-quiet M]     重新订阅已有线程的事件
//   （--max-quiet：最长静默分钟数，超过就输出一个 heartbeat 事件唤醒 Claude，避免它的缓存过期；
//     不中断 Codex；默认 50，0 为不发）
//   send <thread> <text>               在同一线程继续发一轮
//   （start / send 的 <text> 可以换成 --file <路径>，从文件读，避免长文本的 shell 转义问题）
//   approve <thread> <requestId> [--session]   同意一个审批请求（--session：本会话内同类免问）
//   deny <thread> <requestId>          拒绝一个审批请求
//   list                               列出 claude-codex-bridge 开过的线程
//   history <thread> [--limit N]       看最近几轮的提问与汇报
//   rename <thread> <name>             改名
//
// <thread> 可以是线程 ID，也可以是 start 时起的名字。

import { Client } from "./lib/client";
import { ensureDaemon, run, socketAlive } from "./lib/daemon";
import { BridgeError, out } from "./lib/out";
import { Session } from "./lib/session";
import { readFileSync } from "node:fs";
import { claimWatcher, readLastEmitted, watcherPid, writeDecision, writeLastEmitted } from "./lib/state";
import { defaultName, listThreads, renameThread, resolveThread, sendTurn, startThread, threadHistory } from "./lib/threads";

type Flags = Map<string, string | true>;

const VALUE_FLAGS = ["--name", "--limit", "--max-quiet", "--file"];

function parseArgs(argv: string[]) {
  const pos: string[] = [];
  const flags: Flags = new Map();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--session") flags.set("session", true);
    else if (VALUE_FLAGS.includes(a)) {
      const v = argv[++i];
      if (v === undefined) throw new BridgeError(`${a} 后面需要一个值`);
      flags.set(a.slice(2), v);
    } else pos.push(a);
  }
  return { pos, flags };
}

// 默认按 1 小时 prompt 缓存有效期留出余量。
const DEFAULT_MAX_QUIET_MIN = 50;

// 最长静默时间（毫秒）：距离上次唤醒 Claude 超过它就输出一个 heartbeat。--max-quiet 0 表示不发。
function quietMs(flags: Flags): number {
  const raw = flags.get("max-quiet");
  if (raw === undefined) return DEFAULT_MAX_QUIET_MIN * 60_000;
  const min = Number(raw);
  if (raw === "" || !Number.isFinite(min) || min < 0) throw new BridgeError("--max-quiet 需要非负数字（分钟）");
  return min * 60_000;
}

// 要发给 Codex 的文本：--file 优先，否则取第 idx 个位置参数。
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

async function connected(): Promise<Client> {
  await ensureDaemon();
  return Client.connect();
}

async function doctor() {
  const checks: { name: string; ok: boolean; hint?: string }[] = [];
  const [maj, min] = Bun.version.split(".").map(Number);
  checks.push({ name: `Bun ${Bun.version}`, ok: maj > 1 || (maj === 1 && min >= 4), hint: "需要 Bun >= 1.4（支持 ws+unix），运行 `bun upgrade`" });
  const codex = run(["codex", "--version"]);
  checks.push({ name: `Codex CLI ${codex.stdout}`, ok: codex.ok, hint: "安装 Codex CLI 并登录" });
  const alive = codex.ok && (await socketAlive());
  checks.push({ name: "Codex daemon 可连接", ok: alive, hint: "运行 `codex app-server daemon start`（其他命令也会自动尝试）" });
  for (const c of checks) out({ check: c.name, ok: c.ok, ...(c.ok ? {} : { hint: c.hint }) });
  process.exit(checks.every(c => c.ok) ? 0 : 1);
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { pos, flags } = parseArgs(rest);
  const need = (n: number) => { if (pos.length !== n) throw new BridgeError(`参数个数不对，见文件头部的用法`); };

  if (cmd === "doctor") return doctor();

  if (cmd === "start") {
    need(flags.has("file") ? 1 : 2);
    const cwd = pos[0];
    const text = textOf(pos, flags, 1);
    const quiet = quietMs(flags); // 参数有问题要在开线程之前报出来
    const c = await connected();
    const name = typeof flags.get("name") === "string" && flags.get("name") ? String(flags.get("name")) : defaultName(text);
    const threadId = await startThread(c, cwd, name);
    claimWatcher(threadId);
    writeLastEmitted(threadId, null);
    // 先挂好事件处理再发第一轮，用同一条连接，不会漏掉快速结束的事件。
    const session = new Session(threadId, null, quiet);
    session.attach(c);
    session.run();
    await sendTurn(c, threadId, text);
    out({ event: "started", threadId, name, mode: "auto", maxQuietMinutes: quiet / 60_000 });
    return;
  }

  if (cmd === "watch") {
    need(1);
    const quiet = quietMs(flags);
    const c = await connected();
    const threadId = await resolveThread(c, pos[0]);
    const pid = watcherPid(threadId);
    if (pid) throw new BridgeError(`线程已有监听进程（pid ${pid}）`, "不需要重复 watch；确实要换一个，先结束那个进程");
    claimWatcher(threadId);
    const session = new Session(threadId, readLastEmitted(threadId), quiet);
    session.attach(c);
    await session.resume(c);
    session.run();
    out({ event: "watching", threadId, maxQuietMinutes: quiet / 60_000 });
    return;
  }

  if (cmd === "send") {
    need(flags.has("file") ? 1 : 2);
    const text = textOf(pos, flags, 1);
    const c = await connected();
    const threadId = await resolveThread(c, pos[0]);
    await sendTurn(c, threadId, text);
    const watching = watcherPid(threadId) !== undefined;
    out({ sent: true, threadId, watching, ...(watching ? {} : { hint: "没有监听进程，收不到结果和审批请求；用 watch 挂上" }) });
    process.exit(0);
  }

  if (cmd === "approve" || cmd === "deny") {
    need(2);
    const c = await connected();
    const threadId = await resolveThread(c, pos[0]);
    const decision = cmd === "deny" ? "decline" : flags.get("session") ? "acceptForSession" : "accept";
    writeDecision(threadId, pos[1], decision);
    out({ recorded: true, threadId, requestId: pos[1], decision });
    process.exit(0);
  }

  if (cmd === "list") {
    const c = await connected();
    for (const t of await listThreads(c)) out(t);
    process.exit(0);
  }

  if (cmd === "history") {
    need(1);
    const c = await connected();
    const threadId = await resolveThread(c, pos[0]);
    const limit = Number(flags.get("limit")) || 5;
    for (const t of await threadHistory(c, threadId, limit)) out(t);
    process.exit(0);
  }

  if (cmd === "rename") {
    need(2);
    const c = await connected();
    const threadId = await resolveThread(c, pos[0]);
    await renameThread(c, threadId, pos[1]);
    out({ renamed: true, threadId, name: pos[1] });
    process.exit(0);
  }

  throw new BridgeError("未知命令", "doctor | start | watch | send | approve | deny | list | history | rename");
}

main().catch(e => {
  out({ error: e instanceof Error ? e.message : String(e), ...(e instanceof BridgeError && e.hint ? { hint: e.hint } : {}) });
  process.exit(1);
});
