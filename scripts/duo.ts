#!/usr/bin/env bun
// agent-duo：让 Claude Code 通过 Codex 本地 app-server daemon 开线程、派活、收事件。
//
//   doctor
//   start <cwd> <text> [--name N]      开线程并发第一轮，之后持续输出事件
//   watch <thread>                     重新订阅已有线程的事件
//   send <thread> <text>               在同一线程继续发一轮
//   approve <thread> <requestId> [--session]   同意一个审批请求（--session：本会话内同类免问）
//   deny <thread> <requestId>          拒绝一个审批请求
//   list                               列出 agent-duo 开过的线程
//   history <thread> [--limit N]       看最近几轮的提问与汇报
//   rename <thread> <name>             改名
//
// <thread> 可以是线程 ID，也可以是 start 时起的名字。

import { Client } from "./lib/client";
import { ensureDaemon, run, socketAlive } from "./lib/daemon";
import { DuoError, out } from "./lib/out";
import { Session } from "./lib/session";
import { writeDecision } from "./lib/state";
import { defaultName, listThreads, renameThread, resolveThread, sendTurn, startThread, threadHistory } from "./lib/threads";

function parseArgs(argv: string[]) {
  const pos: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--session") flags.set("session", true);
    else if (a === "--name" || a === "--limit") flags.set(a.slice(2), argv[++i] ?? "");
    else pos.push(a);
  }
  return { pos, flags };
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
  const need = (n: number) => { if (pos.length !== n) throw new DuoError(`参数个数不对，见文件头部的用法`); };

  if (cmd === "doctor") return doctor();

  if (cmd === "start") {
    need(2);
    const [cwd, text] = pos;
    const c = await connected();
    const name = typeof flags.get("name") === "string" && flags.get("name") ? String(flags.get("name")) : defaultName(text);
    const threadId = await startThread(c, cwd, name);
    // 先挂好事件处理再发第一轮，用同一条连接，不会漏掉快速结束的事件。
    const session = new Session(threadId, null);
    session.attach(c);
    session.run();
    await sendTurn(c, threadId, text);
    out({ event: "started", threadId, name, mode: "auto" });
    return;
  }

  if (cmd === "watch") {
    need(1);
    const c = await connected();
    const threadId = await resolveThread(c, pos[0]);
    const session = new Session(threadId);
    session.attach(c);
    await session.resume(c);
    session.run();
    out({ event: "watching", threadId });
    return;
  }

  if (cmd === "send") {
    need(2);
    const c = await connected();
    const threadId = await resolveThread(c, pos[0]);
    await sendTurn(c, threadId, pos[1]);
    out({ sent: true, threadId });
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

  throw new DuoError("未知命令", "doctor | start | watch | send | approve | deny | list | history | rename");
}

main().catch(e => {
  out({ error: e instanceof Error ? e.message : String(e), ...(e instanceof DuoError && e.hint ? { hint: e.hint } : {}) });
  process.exit(1);
});
