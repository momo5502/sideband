import { spawn, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";
import { SHUTDOWN_TIMEOUT_MS, STARTUP_TIMEOUT_MS } from "./timeouts.js";
import { parsePassword, serverUrl, type ConnectionProfile } from "./room-protocol.js";
import { presenceDirectory } from "./plugin-presence.js";

export type LocalWorkerBootstrap = { profile: ConnectionProfile; directory: string; name?: string };
/** Internal bootstrap is requested over IPC; never put the server password in argv or a profile file. */
export function requestWorkerBootstrap(): Promise<LocalWorkerBootstrap> {
  if (!process.send) return Promise.reject(new Error("Embedded workers must be launched by sideband server --worker."));
  return new Promise((resolvePromise, reject) => {
    const cleanup = () => { clearTimeout(timer); process.off("message", message); process.off("disconnect", disconnected); };
    const disconnected = () => { cleanup(); reject(new Error("The parent server disconnected before worker setup.")); };
    const message = (packet: any) => {
      if (packet?.type === "sideband.shutdown") { cleanup(); reject(new Error("Embedded worker setup was stopped.")); return; }
      if (packet?.type !== "sideband.worker.bootstrap") return;
      cleanup();
      try {
        const value = packet.value as LocalWorkerBootstrap; parsePassword(value.profile.password);
        if (typeof value.directory !== "string" || value.name !== undefined && typeof value.name !== "string") throw new Error();
        resolvePromise({ ...value, profile: { server: serverUrl(value.profile.server), password: value.profile.password } });
      } catch { reject(new Error("Invalid embedded worker setup.")); }
    };
    const timer = setTimeout(() => { cleanup(); reject(new Error("Embedded worker setup timed out.")); }, STARTUP_TIMEOUT_MS);
    process.on("message", message); process.once("disconnect", disconnected); process.send!({ type: "sideband.worker.bootstrap.request" });
  });
}

/** Restarts the worker supervisor independently. Closing the server leaves agent runners alive. */
export class ServerWorker {
  private child?: ChildProcess;
  private timer?: NodeJS.Timeout;
  private stopping = false;
  private exited?: Promise<void>;
  private attempts = 0;
  constructor(private readonly entry: string, private readonly state: string, private readonly bootstrap: LocalWorkerBootstrap, private readonly log = (message: string) => console.error(message)) {}
  start(): void {
    if (this.stopping || this.child?.pid && this.child.exitCode === null && this.child.signalCode === null) return;
    const endpoint = new URL(serverUrl(this.bootstrap.profile.server));
    const noProxy = [process.env.no_proxy ?? process.env.NO_PROXY ?? "", endpoint.hostname, "127.0.0.1", "localhost", "::1"].filter(Boolean).join(",");
    const child = this.child = spawn(process.execPath, [resolve(this.entry), "worker", "--embedded"], { windowsHide: true, stdio: ["ignore", "inherit", "inherit", "ipc"],
      env: { ...process.env, SIDEBAND_STATE_DIR: resolve(this.state), SIDEBAND_PRESENCE_DIR: resolve(presenceDirectory), NO_PROXY: noProxy, no_proxy: noProxy } });
    let finished = false;
    this.exited = new Promise(resolvePromise => {
      const finish = () => { if (finished) return; finished = true; resolvePromise(); if (!this.stopping) { const delay = Math.min(10000, 500 * 2 ** Math.min(this.attempts++, 5)); this.log(`Local worker stopped; restarting in ${delay / 1000}s.`); this.timer = setTimeout(() => this.start(), delay); } };
      child.once("exit", finish); child.once("error", () => { this.log("Could not start the local worker."); finish(); });
    });
    child.on("message", (message: any) => {
      if (message?.type === "sideband.worker.bootstrap.request" && child.connected) child.send(this.stopping ? { type: "sideband.shutdown" } : { type: "sideband.worker.bootstrap", value: this.bootstrap });
      if (message?.type === "sideband.worker.ready") this.attempts = 0;
    });
  }
  get pid(): number | undefined { return this.child?.pid; }
  async close(): Promise<void> {
    this.stopping = true; if (this.timer) clearTimeout(this.timer);
    const child = this.child; if (!child || child.exitCode !== null || child.signalCode !== null) return;
    if (child.connected) child.send({ type: "sideband.shutdown" }); else child.kill();
    // Do not taskkill the tree: detached agents must survive server/worker restarts.
    const timer = setTimeout(() => child.kill(), SHUTDOWN_TIMEOUT_MS);
    try { await this.exited; } finally { clearTimeout(timer); }
  }
}
