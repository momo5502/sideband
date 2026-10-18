import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { Duplex } from "node:stream";
import WebSocket from "ws";

export class RpcError extends Error {
  constructor(message: string, readonly code?: number) { super(message); this.name = "RpcError"; }
}
export interface RpcConnection {
  request<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
  close(): Promise<void>;
}

export class CodexRpc implements RpcConnection {
  private nextId = 1;
  private readonly pending = new Map<number, {
    resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout;
  }>();
  private constructor(private readonly socket: WebSocket, private readonly child?: ChildProcessWithoutNullStreams) {
    socket.on("message", (data) => {
      let message: { id?: number; result?: unknown; error?: { message: string; code: number }; method?: string };
      try { message = JSON.parse(data.toString()); } catch { return; }
      if (message.id === undefined) return;
      if (message.method) {
        // Delivery does not subscribe/resume threads. Leave any broadcast approval/user-input
        // request to the existing harness UI; even an error response could consume its request.
        return;
      }
      const request = this.pending.get(message.id);
      if (!request) return;
      this.pending.delete(message.id);
      clearTimeout(request.timer);
      if (message.error) request.reject(new RpcError(message.error.message, message.error.code));
      else request.resolve(message.result);
    });
    socket.on("error", (error) => this.fail(error));
    socket.on("close", () => this.fail(new Error("Codex app-server connection closed.")));
    child?.on("error", (error) => this.fail(error));
  }

  static async connect(options: { command?: string; url?: string; socketPath?: string; timeoutMs?: number } = {}): Promise<CodexRpc> {
    let child: ChildProcessWithoutNullStreams | undefined;
    let socket: WebSocket;
    if (options.url) {
      // Remote authentication is intentionally not added to this local-session adapter.
      const url = new URL(options.url);
      if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || url.protocol !== "ws:") {
        throw new Error("Sideband accepts only a local ws:// Codex endpoint.");
      }
      socket = new WebSocket(options.url, { handshakeTimeout: options.timeoutMs ?? 10_000 });
    } else {
      child = spawn(options.command ?? process.env.CODEX_BIN ?? "codex", [
        "app-server", "proxy", ...(options.socketPath ? ["--sock", options.socketPath] : []),
      ], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
      // A raw WebSocket upgrade runs over the proxy's stdio, not a JSONL stream.
      const stream = Duplex.from({ writable: child.stdin, readable: child.stdout });
      child.stderr.resume();
      socket = new WebSocket("ws://localhost/rpc", {
        createConnection: () => stream,
        handshakeTimeout: options.timeoutMs ?? 10_000,
      });
    }
    const connection = new CodexRpc(socket, child);
    try {
      await new Promise<void>((resolve, reject) => {
        socket.once("open", resolve);
        socket.once("error", reject);
        child?.once("error", reject);
      });
      await connection.request("initialize", {
        clientInfo: { name: "sideband", title: "Sideband", version: "0.3.0" },
        capabilities: { experimentalApi: true },
      });
      socket.send(JSON.stringify({ method: "initialized" }));
      return connection;
    } catch (error) {
      await connection.close();
      throw error;
    }
  }

  request<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (this.socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error("Codex connection is not open."));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        // A timeout has ambiguous delivery status. Never automatically resubmit the input.
        reject(new Error(`Codex ${method} timed out; delivery status is unknown.`));
      }, 10_000);
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }), (error) => {
        if (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
      });
    });
  }

  private fail(error: Error): void {
    for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(error); }
    this.pending.clear();
  }

  async close(): Promise<void> {
    this.fail(new Error("Codex connection closed."));
    this.socket.terminate();
    this.child?.stdin.end();
    this.child?.kill();
  }
}
