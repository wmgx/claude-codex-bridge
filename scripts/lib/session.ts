// 一个线程的监听会话：翻译事件、处理审批、断线重连并补发漏掉的结果。

import { Client } from "./client";
import { ensureDaemon } from "./daemon";
import { out, sleep } from "./out";
import { takeDecision } from "./state";

const HEARTBEAT_MS = 30_000;
const POLL_MS = 500;
const APPROVAL_TIMEOUT_MS = 10 * 60_000;
const RECONNECT_GIVE_UP_MS = 10 * 60_000;

type PendingApproval = { reqId: unknown; deadline: number };

const APPROVAL_KIND: Record<string, string> = {
  "item/commandExecution/requestApproval": "command",
  "item/fileChange/requestApproval": "fileChange",
};

// 一个 turn 里最后的汇报：优先 final_answer，没有就取最后一条 agentMessage。
export function reportOf(turn: any): string {
  const msgs = (turn.items ?? []).filter((i: any) => i.type === "agentMessage");
  const final = msgs.filter((i: any) => i.phase === "final_answer").at(-1) ?? msgs.at(-1);
  return final?.text ?? "";
}

export class Session {
  private client?: Client;
  private lastEmitted?: string;
  private texts = new Map<string, { text: string; final: boolean }>();
  private approvals = new Map<string, PendingApproval>();
  private reconnecting = false;
  private baselined = false;
  private timers: ReturnType<typeof setInterval>[] = [];
  private activeTurnId?: string;
  private quietTimer?: ReturnType<typeof setTimeout>;

  // baseline: undefined 表示"以挂上时线程已有的最后一个完成轮为起点，不重放历史"；
  // null 表示线程是刚创建的，之后出现的任何完成轮都要上报。
  //
  // quietMs: 最长静默时间，0 表示不限。Claude 每被唤醒一次（我们输出一个事件），它的 prompt 缓存有效期
  // 就从头算；静默太久缓存会失效，下一次唤醒要按全价重读上下文。所以在缓存失效之前就中断 Codex
  // 并上报，趁缓存还热时唤醒 Claude，由它问用户是否继续。
  constructor(readonly threadId: string, private baseline?: string | null, private quietMs = 0) {
    if (baseline !== undefined) this.lastEmitted = baseline ?? undefined;
  }

  // 所有对外事件都经过这里：输出即唤醒了 Claude，静默计时重新开始。
  private emit(o: Record<string, unknown>) {
    out(o);
    this.rearmQuiet();
  }

  // 只在有一轮正在跑、且没有审批在等用户时计时（等审批时 Claude 已经在等用户，不算静默）。
  private rearmQuiet() {
    if (this.quietTimer) clearTimeout(this.quietTimer);
    this.quietTimer = undefined;
    const turnId = this.activeTurnId;
    if (this.quietMs <= 0 || !turnId || this.approvals.size > 0) return;
    this.quietTimer = setTimeout(() => void this.quietExceeded(turnId), this.quietMs);
  }

  private async quietExceeded(turnId: string) {
    this.quietTimer = undefined;
    this.activeTurnId = undefined; // 触发过就不再重复计时
    let interrupted = true;
    try { await this.client?.request("turn/interrupt", { threadId: this.threadId, turnId }); }
    catch { interrupted = false; }
    this.emit({ event: "quiet_timeout", threadId: this.threadId, turnId, minutes: this.quietMs / 60_000, interrupted });
  }

  private setActiveTurn(turnId?: string) {
    this.activeTurnId = turnId;
    this.rearmQuiet();
  }

  // 接管一条已建立的连接（start 用同一条连接开线程，避免漏事件）。
  attach(c: Client) {
    this.client = c;
    c.onNotification = m => this.onNotification(m);
    c.onServerRequest = m => this.onServerRequest(m);
    c.onClose = () => void this.reconnect();
  }

  // 订阅已有线程，并补发挂上之前就已完成、但还没上报的轮次。
  async resume(c: Client) {
    await c.request("thread/resume", { threadId: this.threadId, excludeTurns: true });
    const { thread } = await c.request("thread/read", { threadId: this.threadId, includeTurns: true });
    const running = (thread.turns ?? []).find((t: any) => t.status === "inProgress");
    if (running) this.setActiveTurn(running.id);
    const done = (thread.turns ?? []).filter((t: any) => t.status !== "inProgress");
    const last = done.at(-1);
    const firstAttach = !this.baselined;
    this.baselined = true;
    if (firstAttach && this.baseline === undefined) {
      this.lastEmitted = last?.id;
    } else if (last && last.id !== this.lastEmitted) {
      this.emitTurn(last.id, last.status, reportOf(last));
    }
  }

  run() {
    this.timers.push(setInterval(() => void this.heartbeat(), HEARTBEAT_MS));
    this.timers.push(setInterval(() => this.pollApprovals(), POLL_MS));
  }

  private emitTurn(turnId: string, status: string, text: string) {
    this.lastEmitted = turnId;
    this.emit({ event: "turn_completed", threadId: this.threadId, turnId, status, text });
  }

  private onNotification(m: any) {
    if (m.params?.threadId !== this.threadId) return;
    if (m.method === "item/completed" && m.params.item?.type === "agentMessage") {
      const { turnId, item } = m.params;
      const final = item.phase === "final_answer";
      const prev = this.texts.get(turnId);
      if (final || !prev?.final) this.texts.set(turnId, { text: item.text ?? "", final });
    } else if (m.method === "turn/started") {
      this.setActiveTurn(m.params.turn.id);
    } else if (m.method === "turn/completed") {
      this.setActiveTurn(undefined);
      const t = m.params.turn;
      const text = this.texts.get(t.id)?.text ?? reportOf(t);
      this.texts.delete(t.id);
      this.emitTurn(t.id, t.status, text);
    } else if (m.method === "error") {
      this.emit({ event: "error", threadId: this.threadId, detail: m.params });
    }
  }

  private onServerRequest(m: any) {
    const kind = APPROVAL_KIND[m.method];
    if (!kind) {
      this.client?.respondError(m.id, "claude-codex-bridge 不支持这类请求");
      this.emit({ event: "unsupported_request", threadId: this.threadId, method: m.method });
      return;
    }
    const requestId = String(m.id);
    this.approvals.set(requestId, { reqId: m.id, deadline: Date.now() + APPROVAL_TIMEOUT_MS });
    this.emit({
      event: "approval_requested",
      threadId: this.threadId,
      requestId,
      kind,
      command: m.params.command,
      cwd: m.params.cwd,
      grantRoot: m.params.grantRoot,
      reason: m.params.reason,
      timeoutSec: APPROVAL_TIMEOUT_MS / 1000,
    });
  }

  private pollApprovals() {
    for (const [requestId, p] of this.approvals) {
      const decision = takeDecision(this.threadId, requestId);
      const expired = Date.now() > p.deadline;
      if (!decision && !expired) continue;
      this.approvals.delete(requestId);
      this.client?.respond(p.reqId, { decision: decision ?? "decline" });
      this.emit({ event: "approval_resolved", threadId: this.threadId, requestId, decision: decision ?? "decline", timedOut: !decision });
    }
  }

  private async heartbeat() {
    if (this.reconnecting || !this.client) return;
    try { await this.client.request("thread/loaded/list", {}, 8000); }
    catch { this.client.close(); }
  }

  private async reconnect() {
    if (this.reconnecting) return;
    this.reconnecting = true;
    this.approvals.clear(); // 旧连接上的审批请求随连接失效
    this.emit({ event: "reconnecting", threadId: this.threadId });
    const giveUp = Date.now() + RECONNECT_GIVE_UP_MS;
    let delay = 1000;
    while (Date.now() < giveUp) {
      try {
        await ensureDaemon();
        const c = await Client.connect();
        this.attach(c);
        await this.resume(c);
        this.reconnecting = false;
        this.emit({ event: "reconnected", threadId: this.threadId });
        return;
      } catch {
        await sleep(delay);
        delay = Math.min(delay * 2, 15_000);
      }
    }
    out({ event: "closed", threadId: this.threadId, reason: "重连超时" });
    process.exit(1);
  }
}
