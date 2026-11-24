// 线程操作：开、发、列表、历史、命名。Codex daemon 与自建 agy-daemon 共用此客户端接口。

import { Client } from "./client";
import { BridgeError } from "./out";
import { reportOf } from "./session";
import { type Backend } from "./state";

// claude-codex-bridge 开的线程名统一带这个前缀：`list` 靠它过滤，执行端列表里也能认出来。
export const PREFIX = "[bridge] ";

const DIRECT_ID = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-|agy-[0-9a-f]{8}-[0-9a-f]{3})/i;

export const isAgyThreadId = (ref: string) => /^agy-[0-9a-f]{8}-[0-9a-f]{3}/i.test(ref);
export const isDirectThreadId = (ref: string) => DIRECT_ID.test(ref);

export const defaultName = (text: string) => text.split("\n")[0].trim().slice(0, 40) || "任务";

export type StartThreadOptions = {
  backend?: Backend;
  network?: boolean;
  model?: string;
  effort?: string;
};

// Codex 默认 auto（workspace-write + on-request + auto_review）；
// agy 额外把 network / model / effort 带给 agy-daemon，以便初始化沙箱与 ACP session 配置。
export async function startThread(c: Client, cwd: string, name: string, opts: StartThreadOptions = {}): Promise<string> {
  const params: Record<string, unknown> = {
    cwd,
    sandbox: "workspace-write",
    approvalPolicy: "on-request",
    approvalsReviewer: "auto_review",
    serviceName: "claude-codex-bridge",
  };
  if (opts.backend === "agy") {
    if (opts.network !== undefined) params.network = opts.network;
    if (opts.model) params.model = opts.model;
    if (opts.effort) params.effort = opts.effort;
  }
  const r = await c.request("thread/start", params, opts.backend === "agy" ? 65_000 : 15_000);
  const threadId = r.thread.id as string;
  await c.request("thread/name/set", { threadId, name: PREFIX + name });
  return threadId;
}

// 每轮可选的覆盖项，执行端会沿用到后续轮次。未给的字段不传，沿用线程现有设置。
export type TurnOptions = { model?: string; effort?: string; network?: boolean };

export const sendTurn = (c: Client, threadId: string, text: string, opts: TurnOptions = {}) =>
  c.request("turn/start", {
    threadId,
    input: [{ type: "text", text }],
    ...(opts.model ? { model: opts.model } : {}),
    ...(opts.effort ? { effort: opts.effort } : {}),
    // 只改联网开关，其余与 thread/start 的 workspace-write 一致：工作目录和系统临时目录可写。
    ...(opts.network === undefined ? {} : {
      sandboxPolicy: { type: "workspaceWrite", writableRoots: [], networkAccess: opts.network, excludeTmpdirEnvVar: false, excludeSlashTmp: false },
    }),
  }, 65_000);

// 可选模型及各自支持的思考深度。
export async function listModels(c: Client) {
  const { data } = await c.request("model/list", {}, 65_000);
  return (data as any[]).map(m => ({
    model: m.model,
    displayName: m.displayName,
    efforts: (m.supportedReasoningEfforts ?? []).map((e: any) => e.reasoningEffort ?? e),
    defaultEffort: m.defaultReasoningEffort,
    ...(m.note ? { note: m.note } : {}),
  }));
}

// 线程引用可以是 ID，也可以是 start 时起的名字。
export async function resolveThread(c: Client, ref: string): Promise<string> {
  if (isDirectThreadId(ref)) return ref;
  const { data } = await c.request("thread/list", { limit: 100, searchTerm: ref });
  const mine = (data as any[]).filter(t => typeof t.name === "string" && t.name.startsWith(PREFIX));
  const exact = mine.filter(t => t.name === PREFIX + ref);
  const hits = exact.length ? exact : mine.filter(t => t.name.includes(ref));
  if (hits.length === 1) return hits[0].id;
  if (hits.length === 0) throw new BridgeError(`找不到名为 "${ref}" 的线程`, "用 `list` 查看，或直接传线程 ID");
  throw new BridgeError(`"${ref}" 匹配到 ${hits.length} 个线程`, hits.map(t => `${t.id} ${t.name}`).join("; "));
}

export async function listThreads(c: Client, backend: Backend = "codex") {
  const { data } = await c.request("thread/list", { limit: 100 });
  return (data as any[])
    .filter(t => typeof t.name === "string" && t.name.startsWith(PREFIX))
    .map(t => ({
      agent: backend,
      threadId: t.id,
      name: t.name.slice(PREFIX.length),
      cwd: t.cwd,
      status: t.status?.type,
      updatedAt: new Date(t.updatedAt * 1000).toISOString(),
      preview: t.preview,
    }));
}

export async function threadHistory(c: Client, threadId: string, limit: number) {
  const { thread } = await c.request("thread/read", { threadId, includeTurns: true });
  return (thread.turns as any[]).slice(-limit).map(t => {
    const ask = (t.items ?? []).find((i: any) => i.type === "userMessage")?.content?.[0]?.text ?? "";
    return {
      turnId: t.id,
      status: t.status,
      ask,
      report: reportOf(t),
      ...(t.actualModel ? { actualModel: t.actualModel } : {}),
    };
  });
}

export const renameThread = (c: Client, threadId: string, name: string) =>
  c.request("thread/name/set", { threadId, name: PREFIX + name });

export async function interruptTurn(
  c: Client,
  threadId: string,
  backend: Backend,
): Promise<{ interrupted: boolean; turnId?: string; detail?: string }> {
  if (backend === "agy") {
    return c.request("turn/interrupt", { threadId }, 15_000);
  }
  const { thread } = await c.request("thread/read", { threadId, includeTurns: true }, 15_000);
  const running = (thread?.turns ?? []).find((t: any) => t.status === "inProgress");
  if (!running?.id) {
    return { interrupted: false, detail: "当前没有正在运行的轮次" };
  }
  await c.request("turn/interrupt", { threadId, turnId: running.id }, 15_000);
  return { interrupted: true, turnId: running.id };
}
