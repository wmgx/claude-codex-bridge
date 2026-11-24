// agy-daemon 核心协议与线程生命周期管理器（与 WebSocket 传输层解耦，便于单元测试）。
// 对外暴露与 Codex app-server 同构的 JSON-RPC 子集，对内单进程多 sessionId 复用 `agy acp --sandbox`，
// 把后续新开线程和模型查询的冷启动耗时从 ~12s 压到 < 1s。

import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { BridgeError } from "../out";
import { agyStateDir, appendAudit } from "../state";
import {
  AcpClient,
  type AcpConfigOption,
  type AcpPermissionRequest,
  type AcpSessionInfo,
  type AgyModelCatalogEntry,
  TurnAccumulator,
  type TurnProgress,
  buildAgySpawnSpec,
  buildModelCatalog,
  diagnoseAgyStderr,
  pickPermissionOption,
} from "./acp";
import {
  type NormalizedPermission,
  type UserPolicyConfig,
  evaluatePermission,
  loadUserPolicy,
  normalizePermission,
} from "./policy";
import { type ReviewerFn, runAutoReview } from "./reviewer";
import {
  type StoredAgyThread,
  type StoredTurn,
  listStoredAgyThreads,
  loadAgyThread,
  recoverInterruptedThreads,
  saveAgyThread,
  toBridgeThreadShape,
} from "./store";

export type DaemonPeer = {
  id: string;
  send: (msg: Record<string, unknown>) => void;
};

type EscalatedApproval = {
  rpcId: number;
  acpReq: AcpPermissionRequest;
  norm: NormalizedPermission;
  method: "item/commandExecution/requestApproval" | "item/fileChange/requestApproval";
  params: Record<string, unknown>;
  timer: ReturnType<typeof setTimeout>;
};

type SharedAcpHost = {
  acp: AcpClient;
  sandboxed: boolean;
  ready: Promise<void>;
};

type ThreadRuntime = {
  threadId: string;
  acp: AcpClient;
  sandboxed: boolean;
  sessionInfo: AcpSessionInfo;
  activeTurn?: { turn: StoredTurn; acc: TurnAccumulator };
  pendingApprovals: Map<number, EscalatedApproval>;
  sessionAllows: Set<string>;
  lastActivityAt: number;
};

export type DaemonCoreOptions = {
  reviewer?: ReviewerFn;
  userPolicy?: () => UserPolicyConfig;
  spawnAcp?: (cwd: string, logTag?: string) => { acp: AcpClient; sandboxed: boolean };
  onShutdown?: () => void;
  threadIdleMs?: number;
  daemonIdleMs?: number;
  approvalTimeoutMs?: number;
};

const DEFAULT_THREAD_IDLE_MS = 2 * 60 * 60_000; // 2 小时无活动关闭该 session（保留磁盘状态，下次 send 自动 resume）
const DEFAULT_DAEMON_IDLE_MS = 4 * 60 * 60_000; // 4 小时全空载自动退出
const DEFAULT_APPROVAL_TIMEOUT_MS = 10 * 60_000;

export class AgyDaemonCore {
  private peers = new Map<string, DaemonPeer>();
  private subscribers = new Map<string, Set<string>>(); // threadId -> peerIds
  private sharedHost?: SharedAcpHost;
  private runtimes = new Map<string, ThreadRuntime>(); // threadId -> runtime
  private sessionToThread = new Map<string, string>(); // acpSessionId -> threadId
  private approvalSeq = 0;
  private cachedModels?: AgyModelCatalogEntry[];
  private lastDaemonActivityAt = Date.now();
  private sweepTimer?: ReturnType<typeof setInterval>;

  private readonly reviewer: ReviewerFn;
  private readonly getUserPolicy: () => UserPolicyConfig;
  private readonly spawnAcpFn: (cwd: string, logTag?: string) => { acp: AcpClient; sandboxed: boolean };
  private readonly onShutdownFn: () => void;
  private readonly threadIdleMs: number;
  private readonly daemonIdleMs: number;
  private readonly approvalTimeoutMs: number;

  constructor(opts: DaemonCoreOptions = {}) {
    this.reviewer = opts.reviewer ?? runAutoReview;
    this.getUserPolicy = opts.userPolicy ?? loadUserPolicy;
    this.spawnAcpFn = opts.spawnAcp ?? ((cwd, logTag) => {
      let logFile: string | undefined;
      if (logTag) {
        const logDir = join(agyStateDir(), "logs");
        mkdirSync(logDir, { recursive: true, mode: 0o700 });
        logFile = join(logDir, `${logTag}.log`);
      }
      const spec = buildAgySpawnSpec({ cwd, logFile });
      return { acp: new AcpClient(spec.cmd, cwd, spec.env), sandboxed: spec.sandboxed };
    });
    this.onShutdownFn = opts.onShutdown ?? (() => {});
    this.threadIdleMs = opts.threadIdleMs ?? DEFAULT_THREAD_IDLE_MS;
    this.daemonIdleMs = opts.daemonIdleMs ?? DEFAULT_DAEMON_IDLE_MS;
    this.approvalTimeoutMs = opts.approvalTimeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS;
    recoverInterruptedThreads();
  }

  startSweep(intervalMs = 60_000) {
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => void this.sweepIdle(), intervalMs);
    this.sweepTimer.unref?.();
  }

  stop() {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = undefined;
    for (const rt of this.runtimes.values()) {
      for (const a of rt.pendingApprovals.values()) clearTimeout(a.timer);
      rt.pendingApprovals.clear();
    }
    this.runtimes.clear();
    this.sessionToThread.clear();
    if (this.sharedHost) {
      const host = this.sharedHost;
      this.sharedHost = undefined;
      host.acp.kill();
    }
  }

  registerPeer(peer: DaemonPeer) {
    this.peers.set(peer.id, peer);
    this.lastDaemonActivityAt = Date.now();
  }

  unregisterPeer(peerId: string) {
    this.peers.delete(peerId);
    for (const set of this.subscribers.values()) set.delete(peerId);
  }

  private subscribe(threadId: string, peerId: string) {
    let set = this.subscribers.get(threadId);
    if (!set) {
      set = new Set();
      this.subscribers.set(threadId, set);
    }
    set.add(peerId);
  }

  private broadcast(threadId: string, msg: Record<string, unknown>) {
    const set = this.subscribers.get(threadId);
    if (!set) return;
    for (const peerId of set) {
      const peer = this.peers.get(peerId);
      if (peer) {
        try { peer.send(msg); } catch {}
      }
    }
  }

  // 单进程多路复用：所有 session 共用同一个已初始化的 agy acp --sandbox 进程，避免重复冷启动。
  private async ensureSharedHost(cwd: string): Promise<SharedAcpHost> {
    if (this.sharedHost && this.sharedHost.acp.alive) {
      await this.sharedHost.ready;
      return this.sharedHost;
    }
    const { acp, sandboxed } = this.spawnAcpFn(cwd, "shared-acp");
    const host: SharedAcpHost = {
      acp,
      sandboxed,
      ready: acp.initialize(20_000).then(() => {}),
    };
    this.sharedHost = host;

    acp.onNotification = (m, p) => this.routeAcpNotification(m, p);
    acp.onPermissionRequest = req => void this.routeAcpPermissionRequest(req);
    acp.onUnknownRequest = (reqId, m) => acp.respondError(reqId, -32601, `agy-bridge-daemon 不支持请求 ${m}`);
    acp.onExit = (code, stderrTail) => this.onSharedAcpExit(host, code, stderrTail);

    try {
      await host.ready;
      return host;
    } catch (e) {
      if (this.sharedHost === host) this.sharedHost = undefined;
      acp.kill();
      throw e;
    }
  }

  async handleMessage(peer: DaemonPeer, msg: any) {
    this.lastDaemonActivityAt = Date.now();
    if (!msg || typeof msg !== "object") return;

    // 客户端对服务端审批请求的回复（含 id，无 method）
    if (msg.id !== undefined && !msg.method) {
      this.handleApprovalReply(Number(msg.id), msg.result, msg.error);
      return;
    }

    // 通知（无 id）
    if (msg.method && msg.id === undefined) {
      return;
    }

    const id = msg.id;
    try {
      const result = await this.dispatchRpc(peer, msg.method, msg.params ?? {});
      peer.send({ id, result });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const hint = e instanceof BridgeError && e.hint ? `（${e.hint}）` : "";
      peer.send({ id, error: { code: -32000, message: `${message}${hint}` } });
    }
  }

  private async dispatchRpc(peer: DaemonPeer, method: string, params: any): Promise<any> {
    if (method === "initialize") {
      return { serverInfo: { name: "agy-bridge-daemon", version: "0.5.0" }, capabilities: {} };
    }
    if (method === "daemon/shutdown") {
      setTimeout(() => {
        this.stop();
        this.onShutdownFn();
      }, 20);
      return { ok: true };
    }
    if (method === "thread/start") return this.rpcThreadStart(peer, params);
    if (method === "thread/name/set") return this.rpcThreadNameSet(params);
    if (method === "thread/resume") return this.rpcThreadResume(peer, params);
    if (method === "thread/read") return this.rpcThreadRead(params);
    if (method === "thread/list") return this.rpcThreadList(params);
    if (method === "turn/start") return this.rpcTurnStart(params);
    if (method === "turn/interrupt") return this.rpcTurnInterrupt(params);
    if (method === "model/list") return this.rpcModelList();
    throw new BridgeError(`agy-daemon 不支持方法 ${method}`);
  }

  private cacheModelsFromSession(info: AcpSessionInfo) {
    const catalog = buildModelCatalog(info);
    if (catalog.length > 0) this.cachedModels = catalog;
  }

  private async bootRuntime(stored: StoredAgyThread, isResume: boolean): Promise<ThreadRuntime> {
    const host = await this.ensureSharedHost(stored.cwd);
    const { acp, sandboxed } = host;

    let sessionInfo: AcpSessionInfo;
    if (isResume && stored.acpSessionId) {
      sessionInfo = await acp.resumeOrLoadSession(stored.acpSessionId, stored.cwd);
    } else {
      sessionInfo = await acp.newSession(stored.cwd);
    }
    this.cacheModelsFromSession(sessionInfo);

    const nativeAutoActive = await this.negotiateMode(acp, sessionInfo);

    if (stored.model) {
      await this.applyModel(acp, sessionInfo, stored.model);
    }
    if (stored.effort) {
      await this.applyEffort(acp, sessionInfo, stored.effort);
    }

    stored.acpSessionId = sessionInfo.sessionId || stored.acpSessionId;
    stored.nativeAutoActive = nativeAutoActive;
    stored.updatedAt = Math.floor(Date.now() / 1000);
    saveAgyThread(stored);

    const rt: ThreadRuntime = {
      threadId: stored.id,
      acp,
      sandboxed,
      sessionInfo,
      pendingApprovals: new Map(),
      sessionAllows: new Set(),
      lastActivityAt: Date.now(),
    };

    this.runtimes.set(stored.id, rt);
    if (sessionInfo.sessionId) {
      this.sessionToThread.set(sessionInfo.sessionId, stored.id);
    }
    return rt;
  }

  private async negotiateMode(acp: AcpClient, info: AcpSessionInfo): Promise<boolean> {
    const modeOpt = info.configOptions.find(o => o.category === "mode" || o.id === "mode");
    const ids = new Set(info.availableModes.map(m => m.id));
    if (info.currentModeId === "auto") return true;

    if (ids.has("auto")) {
      try {
        await acp.setMode(info.sessionId, "auto", modeOpt);
        info.currentModeId = "auto";
        return true;
      } catch {}
    }
    if (ids.has("accept-edits") && info.currentModeId !== "accept-edits") {
      try {
        await acp.setMode(info.sessionId, "accept-edits", modeOpt);
        info.currentModeId = "accept-edits";
      } catch {}
    }
    return false;
  }

  private async applyModel(acp: AcpClient, info: AcpSessionInfo, modelId: string) {
    const modelOpt = info.configOptions.find(o => o.category === "model" || o.id === "model");
    await acp.setModel(info.sessionId, modelId, modelOpt);
    info.currentModelId = modelId;
  }

  private async applyEffort(acp: AcpClient, info: AcpSessionInfo, effort: string) {
    const effortOpt = findEffortConfigOption(info.configOptions);
    if (!effortOpt) {
      throw new BridgeError(
        `当前 agy ACP 会话未暴露思考深度配置，无法设置 --effort ${effort}`,
        "可去掉 --effort 使用 agy 默认思考配置",
      );
    }
    await acp.setConfigOption(info.sessionId, effortOpt.id, effort);
    effortOpt.currentValue = effort;
  }

  private liveProgressOf(threadId: string): TurnProgress | undefined {
    const rt = this.runtimes.get(threadId);
    return rt?.activeTurn?.acc.progress();
  }

  private async rpcThreadStart(peer: DaemonPeer, params: any) {
    const cwd = String(params.cwd ?? process.cwd());
    const id = `agy-${randomUUID().slice(0, 12)}`;
    const stored: StoredAgyThread = {
      id,
      name: "",
      cwd,
      network: params.network !== false,
      model: typeof params.model === "string" ? params.model : undefined,
      effort: typeof params.effort === "string" ? params.effort : undefined,
      nativeAutoActive: false,
      taskSummary: "",
      status: { type: "idle" },
      updatedAt: Math.floor(Date.now() / 1000),
      turns: [],
    };
    saveAgyThread(stored);
    try {
      await this.bootRuntime(stored, false);
    } catch (e) {
      stored.status = { type: "systemError", detail: e instanceof Error ? e.message : String(e) };
      saveAgyThread(stored);
      throw e;
    }
    this.subscribe(id, peer.id);
    return { thread: toBridgeThreadShape(stored, false) };
  }

  private rpcThreadNameSet(params: any) {
    const stored = loadAgyThread(String(params.threadId ?? ""));
    if (!stored) throw new BridgeError(`找不到 agy 线程 ${params.threadId}`);
    stored.name = String(params.name ?? "");
    stored.updatedAt = Math.floor(Date.now() / 1000);
    saveAgyThread(stored);
    return {};
  }

  private rpcThreadResume(peer: DaemonPeer, params: any) {
    const threadId = String(params.threadId ?? "");
    const stored = loadAgyThread(threadId);
    if (!stored) throw new BridgeError(`找不到 agy 线程 ${threadId}`);
    this.subscribe(threadId, peer.id);

    const rt = this.runtimes.get(threadId);
    if (rt && rt.pendingApprovals.size > 0) {
      queueMicrotask(() => {
        for (const a of rt.pendingApprovals.values()) {
          try { peer.send({ id: a.rpcId, method: a.method, params: a.params }); } catch {}
        }
      });
    }
    const progress = this.liveProgressOf(threadId);
    return { thread: { ...toBridgeThreadShape(stored, false), ...(progress ? { progress } : {}) } };
  }

  private rpcThreadRead(params: any) {
    const threadId = String(params.threadId ?? "");
    const stored = loadAgyThread(threadId);
    if (!stored) throw new BridgeError(`找不到 agy 线程 ${threadId}`);
    const progress = this.liveProgressOf(threadId);
    return {
      thread: {
        ...toBridgeThreadShape(stored, Boolean(params.includeTurns)),
        ...(progress ? { progress } : {}),
      },
    };
  }

  private rpcThreadList(params: any) {
    const limit = Number(params.limit) || 100;
    const term = typeof params.searchTerm === "string" ? params.searchTerm.toLowerCase() : "";
    let list = listStoredAgyThreads();
    if (term) {
      list = list.filter(t => t.name.toLowerCase().includes(term) || t.id.toLowerCase().includes(term));
    }
    return { data: list.slice(0, limit).map(t => toBridgeThreadShape(t, false)) };
  }

  private async rpcTurnStart(params: any) {
    const threadId = String(params.threadId ?? "");
    const stored = loadAgyThread(threadId);
    if (!stored) throw new BridgeError(`找不到 agy 线程 ${threadId}`);

    let rt = this.runtimes.get(threadId);
    if (rt?.activeTurn) {
      throw new BridgeError("该线程当前已有轮次正在运行，请等待本轮结束后再发送（或先 `bridge cancel` 中断）");
    }

    const text = Array.isArray(params.input)
      ? params.input.map((i: any) => (typeof i?.text === "string" ? i.text : "")).join("\n")
      : String(params.text ?? "");
    if (!text.trim()) throw new BridgeError("消息文本为空");

    if (!rt || !rt.acp.alive) {
      rt = await this.bootRuntime(stored, Boolean(stored.acpSessionId));
    }

    if (typeof params.model === "string" && params.model && params.model !== stored.model) {
      await this.applyModel(rt.acp, rt.sessionInfo, params.model);
      stored.model = params.model;
    }
    if (typeof params.effort === "string" && params.effort && params.effort !== stored.effort) {
      await this.applyEffort(rt.acp, rt.sessionInfo, params.effort);
      stored.effort = params.effort;
    }

    const turnId = `aturn-${stored.turns.length + 1}`;
    const turn: StoredTurn = {
      id: turnId,
      status: "inProgress",
      ask: text,
      report: "",
      startedAt: new Date().toISOString(),
    };
    if (!stored.taskSummary) stored.taskSummary = text.slice(0, 600);
    stored.turns.push(turn);
    stored.status = { type: "active" };
    stored.updatedAt = Math.floor(Date.now() / 1000);
    saveAgyThread(stored);

    const acc = new TurnAccumulator();
    rt.activeTurn = { turn, acc };
    rt.lastActivityAt = Date.now();

    this.broadcast(threadId, { method: "turn/started", params: { threadId, turn: { id: turnId } } });

    void this.runTurnPrompt(rt, stored, turn, acc, text);
    return { turn: { id: turnId } };
  }

  private rpcTurnInterrupt(params: any) {
    const threadId = String(params.threadId ?? "");
    const rt = this.runtimes.get(threadId);
    if (!rt || !rt.activeTurn) {
      return { interrupted: false, detail: "当前没有正在运行的轮次" };
    }
    const turnId = rt.activeTurn.turn.id;
    // 先释放该线程上所有挂起审批，避免 agy 卡在等待审批无法响应 cancel
    for (const [rpcId, pending] of rt.pendingApprovals) {
      clearTimeout(pending.timer);
      rt.pendingApprovals.delete(rpcId);
      rt.acp.respond(pending.acpReq.id, { outcome: { outcome: "cancelled" } });
    }
    rt.acp.cancel(rt.sessionInfo.sessionId);
    rt.lastActivityAt = Date.now();
    return { interrupted: true, turnId };
  }

  private async runTurnPrompt(
    rt: ThreadRuntime,
    stored: StoredAgyThread,
    turn: StoredTurn,
    acc: TurnAccumulator,
    text: string,
  ) {
    try {
      const res = await rt.acp.prompt(rt.sessionInfo.sessionId, text);
      if (!rt.activeTurn || rt.activeTurn.turn.id !== turn.id) return;
      rt.activeTurn = undefined;
      rt.lastActivityAt = Date.now();

      const report = acc.finalText() || (typeof res?.text === "string" ? res.text : "");
      const actualModel = acc.actualModel ?? (typeof res?.model === "string" ? res.model : undefined);
      const stopReason = String(res?.stopReason ?? "end_turn");

      turn.report = report;
      turn.status = stopReason === "cancelled" ? "cancelled" : "completed";
      if (actualModel) turn.actualModel = actualModel;
      turn.completedAt = new Date().toISOString();

      stored.status = { type: "idle" };
      stored.updatedAt = Math.floor(Date.now() / 1000);
      saveAgyThread(stored);

      this.broadcast(stored.id, {
        method: "item/completed",
        params: { threadId: stored.id, turnId: turn.id, item: { type: "agentMessage", phase: "final_answer", text: report } },
      });
      this.broadcast(stored.id, {
        method: "turn/completed",
        params: {
          threadId: stored.id,
          turn: {
            id: turn.id,
            status: turn.status,
            ...(actualModel ? { actualModel } : {}),
          },
        },
      });
    } catch (e) {
      if (!rt.activeTurn || rt.activeTurn.turn.id !== turn.id) return;
      rt.activeTurn = undefined;
      const detail = e instanceof Error ? e.message : String(e);
      const hint = e instanceof BridgeError && e.hint ? `；${e.hint}` : "";
      const fullDetail = `${detail}${hint}`;

      turn.report = acc.finalText();
      turn.status = "failed";
      turn.errorDetail = fullDetail;
      turn.completedAt = new Date().toISOString();

      stored.status = { type: "systemError", detail: fullDetail };
      stored.updatedAt = Math.floor(Date.now() / 1000);
      saveAgyThread(stored);

      this.broadcast(stored.id, {
        method: "thread/status/changed",
        params: { threadId: stored.id, status: { type: "systemError", detail: fullDetail } },
      });
    }
  }

  private findRuntimeBySession(sessionId: string): ThreadRuntime | undefined {
    const tid = this.sessionToThread.get(sessionId);
    if (tid) return this.runtimes.get(tid);
    // 兜底：若仅有一个活跃 runtime，避免某些 ACP 通知漏带 sessionId
    if (!sessionId && this.runtimes.size === 1) return this.runtimes.values().next().value;
    return undefined;
  }

  private routeAcpNotification(method: string, params: any) {
    if (method !== "session/update") return;
    const rt = this.findRuntimeBySession(String(params?.sessionId ?? ""));
    if (!rt) return;
    rt.lastActivityAt = Date.now();
    const update = params?.update ?? params;
    if (rt.activeTurn) rt.activeTurn.acc.feed(update);
    const kind = update?.sessionUpdate ?? update?.type;
    if (kind === "current_mode_update" && typeof update?.currentModeId === "string") {
      rt.sessionInfo.currentModeId = update.currentModeId;
      const stored = loadAgyThread(rt.threadId);
      if (stored) {
        stored.nativeAutoActive = update.currentModeId === "auto";
        saveAgyThread(stored);
      }
    }
  }

  private async routeAcpPermissionRequest(req: AcpPermissionRequest) {
    const rt = this.findRuntimeBySession(req.sessionId);
    if (!rt) {
      this.sharedHost?.acp.respond(req.id, { outcome: { outcome: "cancelled" } });
      return;
    }
    await this.onAcpPermissionRequest(rt, req);
  }

  private async onAcpPermissionRequest(rt: ThreadRuntime, req: AcpPermissionRequest) {
    rt.lastActivityAt = Date.now();
    const stored = loadAgyThread(rt.threadId);
    const cwd = stored?.cwd ?? process.cwd();
    const network = stored?.network ?? true;
    const nativeAutoActive = stored?.nativeAutoActive ?? (rt.sessionInfo.currentModeId === "auto");
    const norm = normalizePermission(req);

    const decision = evaluatePermission(req, {
      cwd,
      network,
      nativeAutoActive,
      sessionAllows: rt.sessionAllows,
      userConfig: this.getUserPolicy(),
    });

    if (decision.action === "allow") {
      appendAudit(rt.threadId, {
        stage: decision.stage,
        decision: "allow",
        reason: decision.reason,
        kind: norm.kind,
        title: norm.title,
        command: norm.command,
        locations: norm.locations,
      });
      rt.acp.respond(req.id, { outcome: pickPermissionOption(req.options, "accept") });
      return;
    }

    if (decision.action === "deny") {
      appendAudit(rt.threadId, {
        stage: decision.stage,
        decision: "deny",
        reason: decision.reason,
        kind: norm.kind,
        title: norm.title,
        command: norm.command,
        locations: norm.locations,
      });
      rt.acp.respond(req.id, { outcome: pickPermissionOption(req.options, "decline") });
      return;
    }

    let finalReason = decision.reason;
    if (decision.action === "review") {
      const review = await this.reviewer({
        permission: norm,
        cwd,
        network,
        sandboxed: rt.sandboxed,
        taskSummary: stored?.taskSummary ?? "",
      });
      appendAudit(rt.threadId, {
        stage: `auto_review_${review.source}`,
        decision: review.decision,
        reason: review.reason,
        kind: norm.kind,
        title: norm.title,
        command: norm.command,
        locations: norm.locations,
      });
      if (review.decision === "allow") {
        rt.acp.respond(req.id, { outcome: pickPermissionOption(req.options, "accept") });
        return;
      }
      if (review.decision === "deny") {
        rt.acp.respond(req.id, { outcome: pickPermissionOption(req.options, "decline") });
        return;
      }
      finalReason = review.reason;
    } else {
      appendAudit(rt.threadId, {
        stage: decision.stage,
        decision: "ask_user",
        reason: decision.reason,
        kind: norm.kind,
        title: norm.title,
        command: norm.command,
        locations: norm.locations,
      });
    }

    const rpcId = ++this.approvalSeq;
    const isFile = norm.kind === "fileChange";
    const method: EscalatedApproval["method"] = isFile
      ? "item/fileChange/requestApproval"
      : "item/commandExecution/requestApproval";
    const params: Record<string, unknown> = isFile
      ? {
          grantRoot: norm.locations.join(", ") || norm.title,
          cwd,
          reason: finalReason,
        }
      : {
          command: norm.command ?? `${norm.title}${norm.locations.length ? ` (${norm.locations.join(", ")})` : ""}`,
          cwd,
          reason: finalReason,
        };

    const timer = setTimeout(() => {
      const pending = rt.pendingApprovals.get(rpcId);
      if (!pending) return;
      rt.pendingApprovals.delete(rpcId);
      appendAudit(rt.threadId, {
        stage: "timeout",
        decision: "decline",
        requestId: String(rpcId),
        kind: norm.kind,
        command: norm.command,
      });
      rt.acp.respond(pending.acpReq.id, { outcome: pickPermissionOption(pending.acpReq.options, "decline") });
    }, this.approvalTimeoutMs);

    rt.pendingApprovals.set(rpcId, { rpcId, acpReq: req, norm, method, params, timer });
    this.broadcast(rt.threadId, { id: rpcId, method, params });
  }

  private handleApprovalReply(rpcId: number, result: any, error: any) {
    for (const rt of this.runtimes.values()) {
      const pending = rt.pendingApprovals.get(rpcId);
      if (!pending) continue;
      rt.pendingApprovals.delete(rpcId);
      clearTimeout(pending.timer);

      const raw = error ? "decline" : result?.decision;
      const decision: "accept" | "acceptForSession" | "decline" =
        raw === "accept" || raw === "acceptForSession" ? raw : "decline";

      if (decision === "acceptForSession") {
        rt.sessionAllows.add(pending.norm.signature);
      }
      appendAudit(rt.threadId, {
        stage: "user_decision",
        decision,
        requestId: String(rpcId),
        kind: pending.norm.kind,
        command: pending.norm.command,
        locations: pending.norm.locations,
      });
      rt.acp.respond(pending.acpReq.id, { outcome: pickPermissionOption(pending.acpReq.options, decision) });
      return;
    }
  }

  private onSharedAcpExit(host: SharedAcpHost, code: number | null, stderrTail: string) {
    if (this.sharedHost === host) this.sharedHost = undefined;

    const affected = [...this.runtimes.values()].filter(rt => rt.acp === host.acp);
    for (const rt of affected) {
      this.runtimes.delete(rt.threadId);
      if (rt.sessionInfo.sessionId) this.sessionToThread.delete(rt.sessionInfo.sessionId);
      for (const a of rt.pendingApprovals.values()) clearTimeout(a.timer);
      rt.pendingApprovals.clear();

      const stored = loadAgyThread(rt.threadId);
      if (!stored) continue;

      if (rt.activeTurn) {
        const { turn, acc } = rt.activeTurn;
        rt.activeTurn = undefined;
        const hint = diagnoseAgyStderr(stderrTail);
        const detail = `agy acp 异常退出 (code ${code ?? "null"})${hint ? `：${hint}` : stderrTail ? `：${stderrTail.split("\n").at(-1)}` : ""}`;
        turn.report = acc.finalText();
        turn.status = "failed";
        turn.errorDetail = detail;
        turn.completedAt = new Date().toISOString();
        stored.status = { type: "systemError", detail };
        stored.updatedAt = Math.floor(Date.now() / 1000);
        saveAgyThread(stored);
        this.broadcast(rt.threadId, {
          method: "thread/status/changed",
          params: { threadId: rt.threadId, status: { type: "systemError", detail } },
        });
      } else if (stored.status.type !== "systemError") {
        stored.status = { type: "idle" };
        stored.updatedAt = Math.floor(Date.now() / 1000);
        saveAgyThread(stored);
      }
    }
  }

  private async rpcModelList() {
    if (!this.cachedModels) {
      // 复用 sharedHost 探测并保留热进程，下一次 start --agent agy 即可秒开
      try {
        const host = await this.ensureSharedHost(process.cwd());
        const info = await host.acp.newSession(process.cwd(), 60_000);
        this.cacheModelsFromSession(info);
        if (info.sessionId) await host.acp.closeSession(info.sessionId);
      } catch {}
    }
    if (this.cachedModels?.length) {
      return { data: this.cachedModels };
    }
    return {
      data: [
        {
          model: "default",
          displayName: "Antigravity 默认模型（按 ~/.gemini/antigravity-cli/settings.json）",
          supportedReasoningEfforts: [],
          note: "未能从 agy acp 动态探测模型列表，可在 `agy` 内运行 `/model` 查看当前账号可选模型",
        },
      ],
    };
  }

  private async sweepIdle() {
    const now = Date.now();
    for (const [threadId, rt] of this.runtimes) {
      if (rt.activeTurn || rt.pendingApprovals.size > 0) continue;
      if (now - rt.lastActivityAt > this.threadIdleMs) {
        this.runtimes.delete(threadId);
        if (rt.sessionInfo.sessionId) {
          this.sessionToThread.delete(rt.sessionInfo.sessionId);
          await rt.acp.closeSession(rt.sessionInfo.sessionId);
        }
      }
    }
    if (this.runtimes.size === 0 && this.peers.size === 0 && now - this.lastDaemonActivityAt > this.daemonIdleMs) {
      this.stop();
      this.onShutdownFn();
    }
  }
}

function findEffortConfigOption(options: AcpConfigOption[]): AcpConfigOption | undefined {
  return options.find(
    o =>
      o.category === "thought_level" ||
      o.category === "reasoning_effort" ||
      /effort|thinking|reasoning/i.test(o.id),
  );
}
