// Antigravity CLI (`agy acp --sandbox`) ACP stdio JSON-RPC 2.0 客户端。
// 负责子进程托管、帧解析、流式内容拼接（过滤 thought chunk）、mode/model 协商、stderr 诊断和崩溃回调。

import { agyBin } from "../backend";
import { BridgeError } from "../out";

type PendingRpc = {
  resolve: (v: any) => void;
  reject: (e: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
};

export type AcpPermissionOption = {
  optionId: string;
  name?: string;
  kind?: "allow_once" | "allow_always" | "reject_once" | "reject_always" | string;
};

export type AcpPermissionRequest = {
  id: unknown;
  sessionId: string;
  toolCall: {
    toolCallId?: string;
    title?: string;
    kind?: string;
    status?: string;
    rawInput?: Record<string, unknown>;
    locations?: Array<{ path?: string; line?: number }>;
    content?: unknown[];
  };
  options: AcpPermissionOption[];
};

export type AcpConfigOption = {
  id: string;
  name?: string;
  category?: string;
  currentValue?: string;
  options?: Array<{ value: string; name?: string; description?: string }>;
};

export type AcpSessionInfo = {
  sessionId: string;
  currentModeId?: string;
  availableModes: Array<{ id: string; name?: string; description?: string }>;
  currentModelId?: string;
  availableModels: Array<{ modelId: string; name?: string; description?: string }>;
  configOptions: AcpConfigOption[];
};

export type AgySpawnOptions = {
  cwd: string;
  bin?: string;
  extraArgs?: string[];
  allowUnsandboxed?: boolean;
  logFile?: string;
};

// 组装 `agy acp --sandbox` 启动参数（agy acp 默认 --sandbox=false，这里必须显式打开）。
export function buildAgySpawnSpec(opts: AgySpawnOptions): { cmd: string[]; env: Record<string, string>; sandboxed: boolean } {
  const bin = opts.bin ?? agyBin();
  const allowUnsandboxed = opts.allowUnsandboxed ?? process.env.BRIDGE_AGY_ALLOW_UNSANDBOXED === "1";

  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) env[k] = v;
  }

  // 允许单测或自定义包装器注入自定义命令（如 `BRIDGE_AGY_CMD="bun fake-acp.ts"`）
  const customCmd = process.env.BRIDGE_AGY_CMD?.trim();
  if (customCmd) {
    const parts = customCmd.split(/\s+/).filter(Boolean);
    return { cmd: [...parts, ...(opts.extraArgs ?? [])], env, sandboxed: !allowUnsandboxed };
  }

  const cmd = [bin, "acp"];
  if (!allowUnsandboxed) cmd.push("--sandbox");
  if (opts.logFile) cmd.push("--log-file", opts.logFile);
  if (opts.extraArgs?.length) cmd.push(...opts.extraArgs);
  return { cmd, env, sandboxed: !allowUnsandboxed };
}

export type TurnProgress = {
  toolCalls: number;
  lastTool?: string;
  lastToolStatus?: string;
  tokensUsed?: number;
  tokenLimit?: number;
  updatedAt: string;
};

// 从流式 session/update 中提取最终汇报：过滤 agent_thought_chunk，优先取最后一次工具调用后的最终消息段，
// 同时实时累计工具步数与 token 用量供 status 观测长跑任务进度。
export class TurnAccumulator {
  private allText = "";
  private segmentText = "";
  private sawToolAfterText = false;
  actualModel?: string;
  currentModeId?: string;
  readonly toolCalls: Array<{ id?: string; title?: string; kind?: string; status?: string }> = [];
  private seenToolIds = new Set<string>();
  private lastTool?: string;
  private lastToolStatus?: string;
  private tokensUsed?: number;
  private tokenLimit?: number;
  private lastProgressAt = new Date().toISOString();

  feed(update: any) {
    if (!update || typeof update !== "object") return;
    const kind = update.sessionUpdate ?? update.type;

    if (typeof update.model === "string" && update.model) this.actualModel = update.model;
    if (typeof update.modelId === "string" && update.modelId) this.actualModel = update.modelId;

    if (kind === "current_mode_update" && typeof update.currentModeId === "string") {
      this.currentModeId = update.currentModeId;
      return;
    }
    if (kind === "usage_update") {
      if (typeof update.used === "number") this.tokensUsed = update.used;
      if (typeof update.size === "number") this.tokenLimit = update.size;
      this.lastProgressAt = new Date().toISOString();
      return;
    }
    if (kind === "agent_thought_chunk") return;
    if (kind === "agent_message_chunk") {
      const chunk = extractTextChunk(update.content ?? update);
      if (!chunk) return;
      if (this.sawToolAfterText) {
        this.segmentText = "";
        this.sawToolAfterText = false;
      }
      this.allText += chunk;
      this.segmentText += chunk;
      this.lastProgressAt = new Date().toISOString();
      return;
    }
    if (kind === "tool_call" || kind === "tool_call_update") {
      if (this.segmentText.trim()) this.sawToolAfterText = true;
      const id = typeof update.toolCallId === "string" ? update.toolCallId : undefined;
      const label = [update.name, update.title].filter(Boolean).join(": ").slice(0, 120) || update.kind || "tool";
      this.lastTool = label;
      if (typeof update.status === "string") this.lastToolStatus = update.status;
      this.lastProgressAt = new Date().toISOString();
      if (kind === "tool_call" && (!id || !this.seenToolIds.has(id))) {
        if (id) this.seenToolIds.add(id);
        this.toolCalls.push({
          id,
          title: update.title,
          kind: update.kind,
          status: update.status,
        });
      }
    }
  }

  progress(): TurnProgress {
    return {
      toolCalls: this.toolCalls.length,
      ...(this.lastTool ? { lastTool: this.lastTool } : {}),
      ...(this.lastToolStatus ? { lastToolStatus: this.lastToolStatus } : {}),
      ...(this.tokensUsed !== undefined ? { tokensUsed: this.tokensUsed } : {}),
      ...(this.tokenLimit !== undefined ? { tokenLimit: this.tokenLimit } : {}),
      updatedAt: this.lastProgressAt,
    };
  }

  finalText(): string {
    const seg = this.segmentText.trim();
    return seg || this.allText.trim();
  }
}

function extractTextChunk(content: any): string {
  if (typeof content === "string") return content;
  if (!content || typeof content !== "object") return "";
  if (content.type === "text" && typeof content.text === "string") return content.text;
  if (typeof content.text === "string") return content.text;
  if (Array.isArray(content)) return content.map(extractTextChunk).join("");
  return "";
}

export function diagnoseAgyStderr(stderrTail: string): string | undefined {
  const s = stderrTail.trim();
  if (!s) return undefined;
  if (/login|oauth|authenticate|unauthenticated|credentials|not signed in|sign in/i.test(s)) {
    return "Antigravity (agy) 未登录或凭据已过期，请先运行 `agy acp --login` 或 `agy` 完成登录";
  }
  if (/429|resource_exhausted|quota|rate\s*limit/i.test(s)) {
    return "Antigravity (agy) 触发限流或配额耗尽（429 / quota），请稍后重试或切换模型";
  }
  if (/sandbox|seatbelt|namespace|operation not permitted/i.test(s)) {
    return "agy 终端沙箱启动或权限受限，请检查本机 sandbox-exec / Linux namespace 环境";
  }
  return undefined;
}

export type AgyModelCatalogEntry = {
  model: string;
  displayName?: string;
  supportedReasoningEfforts: string[];
  defaultReasoningEffort?: string;
  note?: string;
};

// 从 session/new 的 configOptions + models.availableModels 推导每个基础模型实际支持的思考深度。
export function buildModelCatalog(info: AcpSessionInfo): AgyModelCatalogEntry[] {
  const modelOpt = info.configOptions.find(o => o.category === "model" || o.id === "model");
  const effortOpt = info.configOptions.find(
    o => o.category === "thought_level" || o.category === "reasoning_effort" || /effort|thinking|reasoning/i.test(o.id),
  );
  const allEfforts = (effortOpt?.options ?? []).map(o => o.value);
  const flatIds = new Set(info.availableModels.map(m => m.modelId));

  if (modelOpt?.options?.length) {
    return modelOpt.options.map(opt => {
      // 按扁平模型 ID（如 gemini-4-neon-xhigh）精确反推该模型支持哪些思考档位
      const matched = allEfforts.filter(e => flatIds.has(`${opt.value}-${e}`));
      const defaultEffort = matched.length && effortOpt?.currentValue && matched.includes(effortOpt.currentValue)
        ? effortOpt.currentValue
        : matched[0];
      return {
        model: opt.value,
        displayName: opt.name ?? opt.value,
        supportedReasoningEfforts: matched,
        ...(defaultEffort ? { defaultReasoningEffort: defaultEffort } : {}),
      };
    });
  }

  return info.availableModels.map(m => ({
    model: m.modelId,
    displayName: m.name ?? m.modelId,
    supportedReasoningEfforts: allEfforts,
    ...(effortOpt?.currentValue ? { defaultReasoningEffort: effortOpt.currentValue } : {}),
  }));
}

export function parseSessionInfo(res: any): AcpSessionInfo {
  const modesRaw = res?.modes;
  const availableModes = Array.isArray(modesRaw?.availableModes)
    ? modesRaw.availableModes.map((m: any) => ({ id: String(m.id), name: m.name, description: m.description }))
    : [];
  const modelsRaw = res?.models;
  const availableModels = Array.isArray(modelsRaw?.availableModels)
    ? modelsRaw.availableModels.map((m: any) => ({
        modelId: String(m.modelId ?? m.id ?? m.model),
        name: m.name ?? m.displayName,
        description: m.description,
      }))
    : [];
  const configOptions: AcpConfigOption[] = Array.isArray(res?.configOptions) ? res.configOptions : [];

  // 如果 models / modes 是通过 configOptions 暴露的，也合并提取出来
  for (const opt of configOptions) {
    if ((opt.category === "mode" || opt.id === "mode") && availableModes.length === 0 && Array.isArray(opt.options)) {
      for (const o of opt.options) availableModes.push({ id: o.value, name: o.name, description: o.description });
    }
    if ((opt.category === "model" || opt.id === "model") && availableModels.length === 0 && Array.isArray(opt.options)) {
      for (const o of opt.options) availableModels.push({ modelId: o.value, name: o.name, description: o.description });
    }
  }

  return {
    sessionId: String(res?.sessionId ?? ""),
    currentModeId: modesRaw?.currentModeId ?? configOptions.find(o => o.category === "mode" || o.id === "mode")?.currentValue,
    availableModes,
    currentModelId: modelsRaw?.currentModelId ?? configOptions.find(o => o.category === "model" || o.id === "model")?.currentValue,
    availableModels,
    configOptions,
  };
}

export class AcpClient {
  private seq = 0;
  private pending = new Map<number, PendingRpc>();
  private stderrLines: string[] = [];
  private exited = false;
  private proc: Bun.Subprocess<"pipe", "pipe", "pipe">;

  onNotification: (method: string, params: any) => void = () => {};
  onPermissionRequest: (req: AcpPermissionRequest) => void = () => {};
  onUnknownRequest: (id: unknown, method: string, params: any) => void = () => {};
  onExit: (exitCode: number | null, stderrTail: string) => void = () => {};

  constructor(cmd: string[], cwd: string, env: Record<string, string>) {
    this.proc = Bun.spawn(cmd, {
      cwd,
      env,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    void this.readStdout();
    void this.readStderr();
    void this.watchExit();
  }

  get alive(): boolean {
    return !this.exited;
  }

  get pid(): number {
    return this.proc.pid;
  }

  stderrTail(): string {
    return this.stderrLines.join("\n").slice(-4000);
  }

  private async readStdout() {
    const reader = this.proc.stdout.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (line) this.handleLine(line);
        }
      }
      const rest = (buf + decoder.decode()).trim();
      if (rest) this.handleLine(rest);
    } catch {}
  }

  private async readStderr() {
    const reader = this.proc.stderr.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trimEnd();
          buf = buf.slice(nl + 1);
          if (line) this.pushStderr(line);
        }
      }
      const rest = (buf + decoder.decode()).trim();
      if (rest) this.pushStderr(rest);
    } catch {}
  }

  private pushStderr(line: string) {
    this.stderrLines.push(line);
    if (this.stderrLines.length > 40) this.stderrLines.shift();
  }

  private async watchExit() {
    const code = await this.proc.exited;
    if (this.exited) return;
    this.exited = true;
    const tail = this.stderrTail();
    const hint = diagnoseAgyStderr(tail);
    const msg = `agy acp 子进程已退出 (code ${code ?? "null"})${tail ? `: ${tail.split("\n").at(-1)}` : ""}`;
    for (const p of this.pending.values()) {
      if (p.timer) clearTimeout(p.timer);
      p.reject(new BridgeError(msg, hint));
    }
    this.pending.clear();
    this.onExit(code, tail);
  }

  private handleLine(line: string) {
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      this.pushStderr(`[stdout] ${line}`);
      return;
    }
    if (!msg || typeof msg !== "object") return;

    if (typeof msg.method === "string" && msg.id !== undefined) {
      if (msg.method === "session/request_permission") {
        const p = msg.params ?? {};
        this.onPermissionRequest({
          id: msg.id,
          sessionId: String(p.sessionId ?? ""),
          toolCall: p.toolCall ?? {},
          options: Array.isArray(p.options) ? p.options : [],
        });
      } else {
        this.onUnknownRequest(msg.id, msg.method, msg.params);
      }
      return;
    }

    if (typeof msg.method === "string") {
      this.onNotification(msg.method, msg.params);
      return;
    }

    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    if (p.timer) clearTimeout(p.timer);
    if (msg.error) {
      const errMsg = msg.error.message ?? "ACP 返回错误";
      p.reject(new BridgeError(`${errMsg} (code ${msg.error.code ?? "unknown"})`, diagnoseAgyStderr(`${errMsg}\n${this.stderrTail()}`)));
    } else {
      p.resolve(msg.result);
    }
  }

  private sendRaw(payload: Record<string, unknown>) {
    if (this.exited) throw new BridgeError("agy acp 子进程已退出");
    this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...payload }) + "\n");
  }

  request(method: string, params: unknown, timeoutMs?: number): Promise<any> {
    return new Promise((resolve, reject) => {
      if (this.exited) return reject(new BridgeError("agy acp 子进程已退出", diagnoseAgyStderr(this.stderrTail())));
      const id = ++this.seq;
      const timer = timeoutMs
        ? setTimeout(() => {
            this.pending.delete(id);
            reject(new BridgeError(`agy acp ${method} 超时 (${timeoutMs}ms)`, diagnoseAgyStderr(this.stderrTail())));
          }, timeoutMs)
        : undefined;
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.sendRaw({ id, method, params });
      } catch (e) {
        this.pending.delete(id);
        if (timer) clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  notify(method: string, params: unknown) {
    this.sendRaw({ method, params });
  }

  respond(id: unknown, result: unknown) {
    if (this.exited) return;
    this.sendRaw({ id, result });
  }

  respondError(id: unknown, code: number, message: string) {
    if (this.exited) return;
    this.sendRaw({ id, error: { code, message } });
  }

  async initialize(timeoutMs = 20_000) {
    // 刻意不声明 fs / terminal proxy 能力，让 agy 在自身原生终端沙箱内执行工具。
    return this.request(
      "initialize",
      {
        protocolVersion: 1,
        clientCapabilities: {},
        clientInfo: { name: "claude-codex-bridge", version: "0.5.0" },
      },
      timeoutMs,
    );
  }

  async newSession(cwd: string, timeoutMs = 60_000): Promise<AcpSessionInfo> {
    const res = await this.request("session/new", { cwd, mcpServers: [] }, timeoutMs);
    return parseSessionInfo(res);
  }

  // 优先走 session/resume（不重放完整历史流），不支持时回退 session/load。
  async resumeOrLoadSession(sessionId: string, cwd: string, timeoutMs = 60_000): Promise<AcpSessionInfo> {
    try {
      const res = await this.request("session/resume", { sessionId, cwd, mcpServers: [] }, timeoutMs);
      return parseSessionInfo({ sessionId, ...res });
    } catch {
      const res = await this.request("session/load", { sessionId, cwd, mcpServers: [] }, timeoutMs);
      return parseSessionInfo({ sessionId, ...res });
    }
  }

  async setMode(sessionId: string, modeId: string, configOpt?: AcpConfigOption, timeoutMs = 15_000) {
    if (configOpt) {
      try {
        return await this.request("session/set_config_option", { sessionId, configId: configOpt.id, value: modeId }, timeoutMs);
      } catch {
        // 回退标准 session/set_mode
      }
    }
    return this.request("session/set_mode", { sessionId, modeId }, timeoutMs);
  }

  async setModel(sessionId: string, modelId: string, configOpt?: AcpConfigOption, timeoutMs = 15_000) {
    const inConfigOptions = !!configOpt?.options?.some(o => o.value === modelId);
    if (configOpt && inConfigOptions) {
      try {
        return await this.request("session/set_config_option", { sessionId, configId: configOpt.id, value: modelId }, timeoutMs);
      } catch {
        // 回退标准 session/set_model
      }
    }
    try {
      return await this.request("session/set_model", { sessionId, modelId }, timeoutMs);
    } catch (e) {
      if (configOpt && !inConfigOptions) {
        return await this.request("session/set_config_option", { sessionId, configId: configOpt.id, value: modelId }, timeoutMs);
      }
      throw e;
    }
  }

  async setConfigOption(sessionId: string, configId: string, value: string, timeoutMs = 15_000) {
    return this.request("session/set_config_option", { sessionId, configId, value }, timeoutMs);
  }

  // 长跑任务可能运行数小时，session/prompt 不设短超时，靠子进程退出监听与心跳探活。
  prompt(sessionId: string, text: string) {
    return this.request("session/prompt", { sessionId, prompt: [{ type: "text", text }] });
  }

  cancel(sessionId: string) {
    if (!this.exited) this.notify("session/cancel", { sessionId });
  }

  async closeSession(sessionId: string, timeoutMs = 5_000) {
    if (this.exited) return;
    try {
      await this.request("session/close", { sessionId }, timeoutMs);
    } catch {
      // 旧版或 mock ACP 可能未实现 session/close，静默忽略
    }
  }

  kill() {
    if (this.exited) return;
    try { this.proc.kill("SIGTERM"); } catch {}
    const ref = this.proc;
    setTimeout(() => { try { ref.kill("SIGKILL"); } catch {} }, 3000).unref?.();
  }
}

// 将 bridge 的审批决定映射到 ACP session/request_permission 的具体 optionId。
export function pickPermissionOption(
  options: AcpPermissionOption[],
  decision: "accept" | "acceptForSession" | "decline",
): { outcome: "selected"; optionId: string } | { outcome: "cancelled" } {
  const byKind = (k: string) => options.find(o => o.kind === k)?.optionId;
  let optionId: string | undefined;
  if (decision === "acceptForSession") {
    optionId = byKind("allow_always") ?? byKind("allow_once");
  } else if (decision === "accept") {
    optionId = byKind("allow_once") ?? byKind("allow_always");
  } else {
    optionId = byKind("reject_once") ?? byKind("reject_always");
  }
  if (!optionId) return { outcome: "cancelled" };
  return { outcome: "selected", optionId };
}
