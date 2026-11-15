// 本机 Codex app-server daemon：定位 socket、探活、必要时启动。

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { BridgeError } from "./out";

export const SOCK = join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "app-server-control", "app-server-control.sock");

export function run(cmd: string[]): { ok: boolean; stdout: string } {
  try {
    const p = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe", timeout: 30_000 });
    return { ok: p.exitCode === 0, stdout: new TextDecoder().decode(p.stdout).trim() };
  } catch {
    return { ok: false, stdout: "" };
  }
}

export function socketAlive(): Promise<boolean> {
  return new Promise(resolve => {
    if (!existsSync(SOCK)) return resolve(false);
    const ws = new WebSocket(`ws+unix://${SOCK}:/`);
    const timer = setTimeout(() => { ws.close(); resolve(false); }, 3000);
    ws.onopen = () => { clearTimeout(timer); ws.close(); resolve(true); };
    ws.onerror = () => { clearTimeout(timer); resolve(false); };
  });
}

export async function ensureDaemon(): Promise<void> {
  if (await socketAlive()) return;
  if (!run(["codex", "--version"]).ok) throw new BridgeError("找不到 codex 命令", "先安装 Codex CLI 并登录");
  run(["codex", "app-server", "daemon", "start"]);
  if (!(await socketAlive())) throw new BridgeError("Codex daemon 启动失败", "手动运行 `codex app-server daemon start` 查看错误");
}
