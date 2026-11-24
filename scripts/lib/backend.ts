// 多执行端抽象：统一管理 codex 与 agy（Antigravity CLI）的 daemon 定位、拉起、探活、停止与自检。

import { readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { Client } from "./client";
import { SOCK, ensureDaemon as ensureCodexDaemon, run, socketAlive } from "./daemon";
import { BridgeError, sleep } from "./out";
import { type Backend, agyDaemonPidFile, agySockPath } from "./state";

export type BackendFilter = Backend | "all";

const SCRIPTS_DIR = dirname(import.meta.dir);
const AGY_DAEMON_SCRIPT = join(SCRIPTS_DIR, "agy-daemon.ts");

export function parseBackend(raw: string | true | undefined, fallback: Backend = "codex"): Backend {
  if (raw === undefined || raw === true) return fallback;
  if (raw === "codex" || raw === "agy") return raw;
  if (raw === "gemini") {
    throw new BridgeError(
      '不支持 "--agent gemini"，请使用 "--agent agy"',
      "Google 已将个人订阅与 Gemini 模型终端能力整合至 Antigravity CLI（agy），请安装 agy 并用 --agent agy",
    );
  }
  throw new BridgeError(`不支持的执行端 "${raw}"`, "可选值：codex | agy");
}

export function parseBackendFilter(raw: string | true | undefined, fallback: BackendFilter = "all"): BackendFilter {
  if (raw === undefined || raw === true) return fallback;
  if (raw === "codex" || raw === "agy" || raw === "all") return raw;
  throw new BridgeError(`不支持的执行端过滤 "${raw}"`, "可选值：codex | agy | all");
}

export const agyBin = () => process.env.BRIDGE_AGY_BIN || "agy";

export const backendSocket = (backend: Backend) => (backend === "codex" ? SOCK : agySockPath());

export const backendAlive = (backend: Backend) => socketAlive(backendSocket(backend));

// 同时验证 --version 与 `acp --help`，避免命中 cmux 等仅打印 "agy not found" 的包装脚本。
export function probeAgyCli(bin = agyBin()): { ok: boolean; version: string; acpOk: boolean; hint?: string } {
  const ver = run([bin, "--version"]);
  if (!ver.ok) {
    return {
      ok: false,
      version: "",
      acpOk: false,
      hint: "先安装 Antigravity CLI（agy）并登录（`agy acp --login`），确保 `agy` 在 PATH 中",
    };
  }
  const acp = run([bin, "acp", "--help"]);
  return {
    ok: true,
    version: ver.stdout.split("\n")[0] || "installed",
    acpOk: acp.ok,
    hint: acp.ok ? undefined : "当前 agy 版本不支持 `agy acp`，请升级 Antigravity CLI",
  };
}

export function detectAgySandbox(): { ok: boolean; kind?: string; hint?: string } {
  if (process.platform === "darwin") {
    const sb = run(["which", "sandbox-exec"]);
    return sb.ok ? { ok: true, kind: "macOS Seatbelt (sandbox-exec)" } : { ok: false, hint: "macOS 未找到 sandbox-exec" };
  }
  if (process.platform === "linux") {
    return { ok: true, kind: "Linux Kernel Namespaces" };
  }
  return { ok: false, hint: `当前平台 (${process.platform}) 的 agy 原生终端沙箱支持未验证` };
}

export async function ensureAgyDaemon(): Promise<void> {
  const sock = agySockPath();
  if (await socketAlive(sock)) return;

  if (process.env.BRIDGE_AGY_ALLOW_UNSANDBOXED !== "1") {
    const cli = probeAgyCli();
    if (!cli.ok) throw new BridgeError(`找不到可用的 ${agyBin()} 命令`, cli.hint);
    if (!cli.acpOk) throw new BridgeError(`${agyBin()} 不支持 acp 子命令`, cli.hint);
    const sb = detectAgySandbox();
    if (!sb.ok) throw new BridgeError("未检测到可用的 agy 终端沙箱环境", sb.hint);
  }

  rmSync(sock, { force: true });
  const child = Bun.spawn([process.execPath, AGY_DAEMON_SCRIPT], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
    detached: true,
    env: process.env,
  });
  child.unref();

  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    if (await socketAlive(sock)) return;
    await sleep(150);
  }
  throw new BridgeError("agy-daemon 启动失败", `手动运行 \`bun ${AGY_DAEMON_SCRIPT}\` 查看错误`);
}

export async function ensureBackendDaemon(backend: Backend): Promise<void> {
  if (backend === "codex") return ensureCodexDaemon();
  return ensureAgyDaemon();
}

export async function connectBackend(backend: Backend): Promise<Client> {
  await ensureBackendDaemon(backend);
  return Client.connect(backendSocket(backend));
}

export async function stopBackendDaemon(backend: Backend): Promise<{ stopped: boolean; detail: string }> {
  if (backend === "codex") {
    const r = run(["codex", "app-server", "daemon", "stop"]);
    return { stopped: r.ok, detail: r.stdout || r.stderr || (r.ok ? "已停止" : "停止失败") };
  }
  const sock = agySockPath();
  if (await socketAlive(sock)) {
    try {
      const c = await Client.connect(sock);
      await c.request("daemon/shutdown", {}, 3000);
      c.close();
      await sleep(200);
      if (!(await socketAlive(sock))) return { stopped: true, detail: "agy-daemon 已优雅停止" };
    } catch {
      // 走 PID 兜底
    }
  }
  try {
    const pid = Number(readFileSync(agyDaemonPidFile(), "utf8").trim());
    if (pid > 0) {
      process.kill(pid, "SIGTERM");
      await sleep(300);
      rmSync(sock, { force: true });
      return { stopped: true, detail: `已发送 SIGTERM 给 agy-daemon (pid ${pid})` };
    }
  } catch {}
  rmSync(sock, { force: true });
  return { stopped: true, detail: "agy-daemon 未在运行" };
}

// Codex 支持多端实时旁观；agy 按需求不做实时 observe。
export function observeCommand(backend: Backend, threadId: string): string | undefined {
  return backend === "codex" ? `codex resume ${threadId} --remote unix://` : undefined;
}
