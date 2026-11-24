#!/usr/bin/env bun
// 本机常驻 agy-daemon：监听 Unix socket，托管 `agy acp --sandbox` 子进程并持久化线程状态，
// 让任务可以跨 30 分钟 Monitor 到期继续运行，并在重新 watch 后无损补发结果与待审请求。

import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { AgyDaemonCore, type DaemonPeer } from "./lib/agy/daemon-core";
import { agyDaemonPidFile, agySockPath, agyStateDir, stateBase } from "./lib/state";

type WsData = { peer: DaemonPeer };

let peerSeq = 0;

if (import.meta.main) {
  mkdirSync(stateBase(), { recursive: true, mode: 0o700 });
  mkdirSync(agyStateDir(), { recursive: true, mode: 0o700 });

  const sock = agySockPath();
  rmSync(sock, { force: true });

  let server: ReturnType<typeof Bun.serve<WsData>> | undefined;
  const cleanup = () => {
    try { server?.stop(true); } catch {}
    rmSync(sock, { force: true });
    rmSync(agyDaemonPidFile(), { force: true });
    process.exit(0);
  };

  const core = new AgyDaemonCore({ onShutdown: cleanup });
  core.startSweep();

  server = Bun.serve<WsData>({
    unix: sock,
    fetch(req, srv) {
      const id = `peer-${++peerSeq}`;
      const peer: DaemonPeer = { id, send: () => {} };
      if (srv.upgrade(req, { data: { peer } })) return;
      return new Response("agy-daemon", { status: 200 });
    },
    websocket: {
      open(ws) {
        ws.data.peer.send = msg => {
          try { ws.send(JSON.stringify(msg)); } catch {}
        };
        core.registerPeer(ws.data.peer);
      },
      message(ws, raw) {
        try {
          const msg = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw));
          void core.handleMessage(ws.data.peer, msg);
        } catch {}
      },
      close(ws) {
        core.unregisterPeer(ws.data.peer.id);
      },
    },
  });

  try { chmodSync(sock, 0o600); } catch {}
  writeFileSync(agyDaemonPidFile(), String(process.pid), { mode: 0o600 });

  const onSignal = () => {
    core.stop();
    cleanup();
  };
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);
}
