// 一个线程的监听会话：翻译事件、处理审批、断线重连并补发漏掉的结果。
// Codex daemon 与自建 agy-daemon 使用同构 JSON-RPC 协议，共用此状态机。

import { Client } from "./client";
import { ensureDaemon as ensureCodexDaemon } from "./daemon";
import { out, sleep } from "./out";
import {
  type Backend,
  type PendingApprovalSummary,
  appendEvent,
  releaseWatcher,
  takeDecision,
  writeLastEmitted,
  writeStatus,
} from "./state";

const HEARTBEAT_MS = 30_000;
const POLL_MS = 500;
const APPROVAL_TIMEOUT_MS = 10 * 60_000;
const RECONNECT_GIVE_UP_MS = 10 * 60_000;

type PendingApproval = { reqId: unknown; deadline: number; summary: PendingApprovalSummary };

const APPROVAL_KIND: Record<string, string> = {
  "item/commandExecution/requestApproval": "command",
  "item/fileChange/requestApproval": "fileChange",
};

export type SessionBackendHooks = {
  backend?: Backend;
  ensureDaemon?: () => Promise<void>;
  connect?: () => Promise<Client>;
  idleExitMs?: number;
  onIdleExit?: () => void;
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
  private crashedTurn?: string; // 断线时正在跑的轮次；重连后它若没正常完成，就是执行端崩了
  private quietTimer?: ReturnType<typeof setTimeout>;
  private idleTimer?: ReturnType<typeof setTimeout>;
  private readonly backend: Backend;
  private readonly ensureDaemonFn: () => Promise<void>;
  private readonly connectFn: () => Promise<Client>;
  private readonly idleExitMs: number;
  private readonly onIdleExitFn?: () => void;

  // baseline: 最后一个已上报的完成轮，之后完成的轮次都要上报。
  // null 表示还没上报过任何轮次（线程刚创建）；
  // undefined 表示没有记录，以挂上时线程已有的最后一个完成轮为起点，不重放历史。
  //
  // quietMs: 最长静默时间，0 表示不限。Claude 每被唤醒一次（我们输出一个事件），它的 prompt 缓存有效期
  // 就从头算；静默太久缓存会失效，下一次唤醒要按全价重读上下文。所以在缓存失效之前输出一个
  // heartbeat 事件把 Claude 唤醒一次，执行端不受影响，继续跑。
  constructor(
    readonly threadId: string,
    private baseline?: string | null,
    private quietMs = 0,
    hooks: SessionBackendHooks = {},
  ) {
    if (baseline !== undefined) this.lastEmitted = baseline ?? undefined;
    this.backend = hooks.backend ?? "codex";
    this.ensureDaemonFn = hooks.ensureDaemon ?? ensureCodexDaemon;
    this.connectFn = hooks.connect ?? (() => Client.connect());
    this.idleExitMs = hooks.idleExitMs ?? 0;
    this.onIdleExitFn = hooks.onIdleExit;
  }

  // 所有对外事件都经过这里：输出即唤醒了宿主，同时落盘 events.jsonl 供 wait/--once 消费。
  private emit(o: Record<string, unknown>) {
    const payload = { agent: this.backend, ...o };
    appendEvent(this.threadId, payload);
    out(payload);
    this.rearmQuiet();
    this.rearmIdle();
  }

  // 只在有一轮正在跑、且没有审批在等用户时计时（等审批时宿主已经在等用户，不算静默）。
  private rearmQuiet() {
    if (this.quietTimer) clearTimeout(this.quietTimer);
    this.quietTimer = undefined;
    const turnId = this.activeTurnId;
    if (this.quietMs <= 0 || !turnId || this.approvals.size > 0) return;
    // emit 会重新计时，所以这一轮没结束就会按间隔一直发下去。
    this.quietTimer = setTimeout(
      () => this.emit({ event: "heartbeat", threadId: this.threadId, turnId, quietMinutes: this.quietMs / 60_000 }),
      this.quietMs,
    );
  }

  // 后台托管监听进程（--idle-exit）在无活跃轮次且无待审请求持续超过阈值时自动退出，防止孤儿进程堆积。
  private rearmIdle() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
    if (this.idleExitMs <= 0 || this.activeTurnId || this.approvals.size > 0) return;
    this.idleTimer = setTimeout(() => {
      this.stop();
      releaseWatcher(this.threadId);
      if (this.onIdleExitFn) this.onIdleExitFn();
      else process.exit(0);
    }, this.idleExitMs);
    this.idleTimer.unref?.();
  }

  private setActiveTurn(turnId?: string) {
    this.activeTurnId = turnId;
    this.rearmQuiet();
    this.rearmIdle();
  }

  // 标记监听进程已挂接就绪（供 start --once / send --wait 确认后台监听已订阅后再发轮次）。
  markReady(threadStatus?: string) {
    this.saveStatus("up", threadStatus, true);
    this.rearmIdle();
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
    this.setActiveTurn(running?.id); // 没有在跑的轮也要清掉，否则会对已结束的轮继续计时
    const done = (thread.turns ?? []).filter((t: any) => t.status !== "inProgress");
    const firstAttach = !this.baselined;
    this.baselined = true;
    if (firstAttach && this.baseline === undefined) {
      this.lastEmitted = done.at(-1)?.id;
      writeLastEmitted(this.threadId, this.lastEmitted ?? null);
      return;
    }
    // 补发上次上报之后完成的所有轮次；记录的那一轮找不到时只发最后一轮，避免重放整段历史。
    const idx = done.findIndex((t: any) => t.id === this.lastEmitted);
    const missed = idx >= 0 || !this.lastEmitted ? done.slice(idx + 1) : done.slice(-1);
    for (const t of missed) {
      if (t.id === this.crashedTurn && t.status !== "completed") this.emitLost(t.id, t.status, reportOf(t), t.errorDetail);
      else this.emitTurn(t.id, t.status, reportOf(t), t.actualModel);
    }
    this.crashedTurn = undefined;
  }

  run() {
    this.timers.push(setInterval(() => void this.heartbeat(), HEARTBEAT_MS));
    this.timers.push(setInterval(() => this.pollApprovals(), POLL_MS));
  }

  stop() {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    if (this.quietTimer) clearTimeout(this.quietTimer);
    this.quietTimer = undefined;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
  }

  private emitTurn(turnId: string, status: string, text: string, actualModel?: string) {
    this.lastEmitted = turnId;
    writeLastEmitted(this.threadId, turnId);
    this.emit({
      event: "turn_completed",
      threadId: this.threadId,
      turnId,
      status,
      text,
      ...(actualModel ? { actualModel } : {}),
    });
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
      this.emitTurn(t.id, t.status, text, t.actualModel);
    } else if (m.method === "thread/closed") {
      // 执行端自己卸载了线程（正常回收），不是异常：不推送，只把"在跑"的记录清掉。
      this.setActiveTurn(undefined);
      this.saveStatus("up", "closed");
    } else if (m.method === "thread/status/changed" && m.params.status?.type === "systemError") {
      this.lost("systemError", m.params.status?.detail);
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
    takeDecision(this.threadId, requestId); // 丢弃同 ID 的残留决定，避免旧的批准落到新请求上
    const summary: PendingApprovalSummary = {
      requestId,
      kind,
      ...(m.params.command ? { command: m.params.command } : {}),
      ...(m.params.grantRoot ? { grantRoot: m.params.grantRoot } : {}),
      ...(m.params.cwd ? { cwd: m.params.cwd } : {}),
      ...(m.params.reason ? { reason: m.params.reason } : {}),
    };
    this.approvals.set(requestId, { reqId: m.id, deadline: Date.now() + APPROVAL_TIMEOUT_MS, summary });
    this.saveStatus("up");
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
      this.saveStatus("up");
      // 正常批准或拒绝是宿主刚执行的，不用再唤醒一次；只有超时自动拒绝才上报。
      if (decision) {
        this.rearmQuiet();
        this.rearmIdle();
      } else {
        this.emit({ event: "approval_resolved", threadId: this.threadId, requestId, decision: "decline", timedOut: true });
      }
    }
  }

  private saveStatus(daemon: "up" | "reconnecting" | "down", thread?: string, ready = true) {
    const pendingApprovals = [...this.approvals.values()].map(a => a.summary);
    writeStatus(this.threadId, {
      backend: this.backend,
      daemon,
      thread,
      activeTurnId: this.activeTurnId,
      ready,
      ...(pendingApprovals.length ? { pendingApprovals } : {}),
    });
  }

  // 这一轮正在跑，执行端却已经没了（进程崩溃、daemon 重启把线程卸载）：不会再有 turn_completed，主动告诉 Claude。
  private lost(status: string, detail?: string) {
    const turnId = this.activeTurnId;
    if (!turnId) return;
    this.setActiveTurn(undefined);
    this.emitLost(turnId, status, undefined, detail);
  }

  private emitLost(turnId: string, status: string, text?: string, detail?: string) {
    this.lastEmitted = turnId;
    writeLastEmitted(this.threadId, turnId);
    const label = this.backend === "codex" ? "Codex" : "Antigravity (agy)";
    const event = this.backend === "codex" ? "codex_lost" : "agy_lost";
    this.emit({
      event,
      threadId: this.threadId,
      turnId,
      status,
      ...(text ? { partial: text } : {}),
      ...(detail ? { detail } : {}),
      hint: `${label} 异常退出，这一轮不会再有结果；用 history 看已有进展，需要就 send 重发`,
    });
  }

  // 探活：读一次线程状态，顺便落盘供 `status` 查询。读失败就断开连接，交给 reconnect。
  private async heartbeat() {
    if (this.reconnecting || !this.client) return;
    try {
      const { thread } = await this.client.request("thread/read", { threadId: this.threadId, includeTurns: false }, 8000);
      const status = thread?.status?.type as string | undefined;
      if (status === "notLoaded" || status === "systemError") this.lost(status, thread?.status?.detail);
      this.saveStatus("up", status);
    } catch { this.client.close(); }
  }

  private async reconnect() {
    if (this.reconnecting) return;
    this.reconnecting = true;
    this.crashedTurn ??= this.activeTurnId;
    this.saveStatus("reconnecting");
    const dropped = [...this.approvals.keys()]; // 旧连接上的审批请求随连接失效
    this.approvals.clear();
    const giveUp = Date.now() + RECONNECT_GIVE_UP_MS;
    let delay = 1000;
    while (Date.now() < giveUp) {
      try {
        await this.ensureDaemonFn();
        const c = await this.connectFn();
        this.attach(c);
        await this.resume(c);
        this.reconnecting = false;
        this.saveStatus("up");
        // 重连成功不出声，省一次唤醒；只有作废了未决审批才需要让 Claude 知道。
        if (dropped.length) this.emit({ event: "approvals_dropped", threadId: this.threadId, requestIds: dropped });
        return;
      } catch {
        this.saveStatus("reconnecting");
        await sleep(delay);
        delay = Math.min(delay * 2, 15_000);
      }
    }
    this.saveStatus("down");
    const closed = { agent: this.backend, event: "closed", threadId: this.threadId, reason: "重连超时" };
    appendEvent(this.threadId, closed);
    out(closed);
    releaseWatcher(this.threadId);
    process.exit(1);
  }
}
