#!/usr/bin/env bun
// agent-duo：让 Claude Code 通过 Codex 本地 app-server daemon 直接开线程、派活、收事件。
// 子命令：doctor | start <cwd> <text> [--write] | send <threadId> <text> | watch <threadId>

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const SOCK = join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "app-server-control", "app-server-control.sock");
const REQUEST_TIMEOUT_MS = 15_000;

const out = (o: Record<string, unknown>) => console.log(JSON.stringify(o));
const fail = (message: string, hint?: string): never => {
  out({ error: message, ...(hint ? { hint } : {}) });
  process.exit(1);
};

function run(cmd: string[]): { ok: boolean; stdout: string } {
  try {
    const p = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe", timeout: 30_000 });
    return { ok: p.exitCode === 0, stdout: new TextDecoder().decode(p.stdout).trim() };
  } catch {
    return { ok: false, stdout: "" };
  }
}

function socketAlive(): Promise<boolean> {
  return new Promise(resolve => {
    if (!existsSync(SOCK)) return resolve(false);
    const ws = new WebSocket(`ws+unix://${SOCK}:/`);
    const timer = setTimeout(() => { ws.close(); resolve(false); }, 3000);
    ws.onopen = () => { clearTimeout(timer); ws.close(); resolve(true); };
    ws.onerror = () => { clearTimeout(timer); resolve(false); };
  });
}

async function ensureDaemon() {
  if (await socketAlive()) return;
  if (!run(["codex", "--version"]).ok) fail("找不到 codex 命令", "先安装 Codex CLI 并登录");
  run(["codex", "app-server", "daemon", "start"]);
  if (!(await socketAlive())) fail("Codex daemon 启动失败", "手动运行 `codex app-server daemon start` 查看错误");
}

class Client {
  private ws!: WebSocket;
  private seq = 0;
  private pending = new Map<number, (v: any) => void>();
  onMessage: (m: any) => void = () => {};

  async connect() {
    this.ws = new WebSocket(`ws+unix://${SOCK}:/`);
    this.ws.onmessage = e => {
      const m = JSON.parse(String(e.data));
      if (m.id !== undefined && !m.method && this.pending.has(m.id)) {
        this.pending.get(m.id)!(m);
        this.pending.delete(m.id);
      } else this.onMessage(m);
    };
    await new Promise<void>((resolve, reject) => {
      this.ws.onopen = () => resolve();
      this.ws.onerror = () => reject(new Error("连接 daemon 失败"));
    });
    await this.request("initialize", { clientInfo: { name: "agent-duo", version: "0.1.0" }, capabilities: { experimentalApi: true } });
    this.ws.send(JSON.stringify({ method: "initialized" }));
  }

  request(method: string, params: unknown): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = ++this.seq;
      const timer = setTimeout(() => reject(new Error(`${method} 超时`)), REQUEST_TIMEOUT_MS);
      this.pending.set(id, v => { clearTimeout(timer); resolve(v); });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  onClose(fn: () => void) { this.ws.onclose = fn; }
}

async function connected(): Promise<Client> {
  await ensureDaemon();
  const c = new Client();
  try { await c.connect(); } catch (e) { fail((e as Error).message); }
  return c;
}

// 把线程事件翻译成一行行 JSON：一轮结束、报错、需要输入。
function attachEvents(c: Client, threadId: string) {
  let lastText = "";
  c.onMessage = m => {
    if (m.params?.threadId && m.params.threadId !== threadId) return;
    if (m.method === "item/completed" && m.params.item?.type === "agentMessage") {
      lastText = m.params.item.text ?? lastText;
    } else if (m.method === "turn/completed") {
      out({ event: "turn_completed", status: m.params.turn?.status, text: lastText });
      lastText = "";
    } else if (m.method === "error") {
      out({ event: "error", detail: m.params });
    } else if (m.id !== undefined && m.method) {
      out({ event: "needs_input", method: m.method });
    }
  };
  c.onClose(() => { out({ event: "closed" }); process.exit(0); });
}

// 开线程并发第一轮；用同一条连接继续监听，避免"开完再订阅"漏掉快速结束的事件。
async function cmdStart(cwd: string, text: string, write: boolean) {
  const c = await connected();
  const t = await c.request("thread/start", {
    cwd,
    sandbox: write ? "workspace-write" : "read-only",
    approvalPolicy: "never",
    serviceName: "agent-duo",
  });
  if (t.error) fail(`thread/start 失败: ${JSON.stringify(t.error)}`);
  const threadId = t.result.thread.id as string;
  attachEvents(c, threadId);
  const u = await c.request("turn/start", { threadId, input: [{ type: "text", text }] });
  if (u.error) fail(`turn/start 失败: ${JSON.stringify(u.error)}`);
  out({ event: "started", threadId, sandbox: write ? "workspace-write" : "read-only" });
}

async function cmdSend(threadId: string, text: string) {
  const c = await connected();
  const u = await c.request("turn/start", { threadId, input: [{ type: "text", text }] });
  if (u.error) fail(`turn/start 失败: ${JSON.stringify(u.error)}`, "线程可能已被关闭，用 start 重新开一个");
  out({ sent: true });
  process.exit(0);
}

async function cmdWatch(threadId: string) {
  const c = await connected();
  attachEvents(c, threadId);
  const r = await c.request("thread/resume", { threadId, excludeTurns: true });
  if (r.error) fail(`thread/resume 失败: ${JSON.stringify(r.error)}`, "线程 ID 是否正确？");
  out({ event: "watching", threadId });
}

async function cmdDoctor() {
  const checks: { name: string; ok: boolean; hint?: string }[] = [];
  const [maj, min] = Bun.version.split(".").map(Number);
  checks.push({ name: `Bun ${Bun.version}`, ok: maj > 1 || (maj === 1 && min >= 4), hint: "需要 Bun >= 1.4（支持 ws+unix），运行 `bun upgrade`" });
  const codex = run(["codex", "--version"]);
  checks.push({ name: `Codex CLI ${codex.stdout}`, ok: codex.ok, hint: "安装 Codex CLI 并登录" });
  const alive = codex.ok && (await socketAlive());
  checks.push({ name: "Codex daemon 可连接", ok: alive, hint: "运行 `codex app-server daemon start`（start/send/watch 也会自动尝试）" });
  for (const c of checks) out({ check: c.name, ok: c.ok, ...(c.ok ? {} : { hint: c.hint }) });
  process.exit(checks.every(c => c.ok) ? 0 : 1);
}

const [cmd, ...args] = process.argv.slice(2);
const usage = () => fail("用法: duo.ts doctor | start <cwd> <text> [--write] | send <threadId> <text> | watch <threadId>");
const write = args.includes("--write");
const pos = args.filter(a => a !== "--write");

if (cmd === "doctor") await cmdDoctor();
else if (cmd === "start" && pos.length === 2) await cmdStart(pos[0], pos[1], write);
else if (cmd === "send" && pos.length === 2) await cmdSend(pos[0], pos[1]);
else if (cmd === "watch" && pos.length === 1) await cmdWatch(pos[0]);
else usage();
