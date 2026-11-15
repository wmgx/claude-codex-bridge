// app-server JSON-RPC 客户端（WebSocket over Unix socket）。

import { SOCK } from "./daemon";
import { BridgeError } from "./out";

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> };

export class Client {
  private seq = 0;
  private pending = new Map<number, Pending>();
  private closed = false;
  onNotification: (m: any) => void = () => {};
  onServerRequest: (m: any) => void = () => {};
  onClose: () => void = () => {};

  private constructor(private ws: WebSocket) {}

  static async connect(): Promise<Client> {
    const ws = new WebSocket(`ws+unix://${SOCK}:/`);
    const c = new Client(ws);
    ws.onmessage = e => c.route(JSON.parse(String(e.data)));
    ws.onclose = () => c.handleClose();
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new BridgeError("连接 daemon 超时")), 5000);
      ws.onopen = () => { clearTimeout(timer); resolve(); };
      ws.onerror = () => { clearTimeout(timer); reject(new BridgeError("连接 daemon 失败")); };
    });
    await c.request("initialize", { clientInfo: { name: "claude-codex-bridge", version: "0.2.0" }, capabilities: { experimentalApi: true } });
    ws.send(JSON.stringify({ method: "initialized" }));
    return c;
  }

  private route(m: any) {
    if (m.method && m.id !== undefined) return this.onServerRequest(m);
    if (m.method) return this.onNotification(m);
    const p = this.pending.get(m.id);
    if (!p) return;
    this.pending.delete(m.id);
    clearTimeout(p.timer);
    if (m.error) p.reject(new BridgeError(`${m.error.message ?? "app-server 返回错误"} (code ${m.error.code})`));
    else p.resolve(m.result);
  }

  private handleClose() {
    if (this.closed) return;
    this.closed = true;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new BridgeError("连接已断开")); }
    this.pending.clear();
    this.onClose();
  }

  request(method: string, params: unknown, timeoutMs = 15_000): Promise<any> {
    return new Promise((resolve, reject) => {
      if (this.closed) return reject(new BridgeError("连接已断开"));
      const id = ++this.seq;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new BridgeError(`${method} 超时`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  respond(id: unknown, result: unknown) { this.ws.send(JSON.stringify({ id, result })); }

  respondError(id: unknown, message: string) { this.ws.send(JSON.stringify({ id, error: { code: -32601, message } })); }

  close() {
    try { this.ws.close(); } catch {}
    this.handleClose();
  }
}
