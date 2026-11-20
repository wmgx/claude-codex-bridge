// 线程操作：开、发、列表、历史、命名。

import { Client } from "./client";
import { BridgeError } from "./out";
import { reportOf } from "./session";

// claude-codex-bridge 开的线程名统一带这个前缀：`list` 靠它过滤，Codex 自己的列表里也能认出来。
export const PREFIX = "[bridge] ";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-/i;

export const defaultName = (text: string) => text.split("\n")[0].trim().slice(0, 40) || "任务";

// 默认 auto：沙箱内的操作直接做，越出沙箱的请求交给 Codex 的 auto_review 子代理按风险审批，不打扰用户。
export async function startThread(c: Client, cwd: string, name: string): Promise<string> {
  const r = await c.request("thread/start", {
    cwd,
    sandbox: "workspace-write",
    approvalPolicy: "on-request",
    approvalsReviewer: "auto_review",
    serviceName: "claude-codex-bridge",
  });
  const threadId = r.thread.id as string;
  await c.request("thread/name/set", { threadId, name: PREFIX + name });
  return threadId;
}

// 每轮可选的覆盖项，Codex 会沿用到后续轮次。未给的字段不传，沿用线程现有设置（首轮即 Codex 的 config.toml）。
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
  });

// 可选模型及各自支持的思考深度。
export async function listModels(c: Client) {
  const { data } = await c.request("model/list", {});
  return (data as any[]).map(m => ({
    model: m.model,
    displayName: m.displayName,
    efforts: (m.supportedReasoningEfforts ?? []).map((e: any) => e.reasoningEffort ?? e),
    defaultEffort: m.defaultReasoningEffort,
  }));
}

// 线程引用可以是 ID，也可以是 start 时起的名字。
export async function resolveThread(c: Client, ref: string): Promise<string> {
  if (UUID.test(ref)) return ref;
  const { data } = await c.request("thread/list", { limit: 100, searchTerm: ref });
  const mine = (data as any[]).filter(t => typeof t.name === "string" && t.name.startsWith(PREFIX));
  const exact = mine.filter(t => t.name === PREFIX + ref);
  const hits = exact.length ? exact : mine.filter(t => t.name.includes(ref));
  if (hits.length === 1) return hits[0].id;
  if (hits.length === 0) throw new BridgeError(`找不到名为 "${ref}" 的线程`, "用 `list` 查看，或直接传线程 ID");
  throw new BridgeError(`"${ref}" 匹配到 ${hits.length} 个线程`, hits.map(t => `${t.id} ${t.name}`).join("; "));
}

export async function listThreads(c: Client) {
  const { data } = await c.request("thread/list", { limit: 100 });
  return (data as any[])
    .filter(t => typeof t.name === "string" && t.name.startsWith(PREFIX))
    .map(t => ({
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
    return { turnId: t.id, status: t.status, ask, report: reportOf(t) };
  });
}

export const renameThread = (c: Client, threadId: string, name: string) =>
  c.request("thread/name/set", { threadId, name: PREFIX + name });
