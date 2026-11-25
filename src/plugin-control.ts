import { createServer, connect, type Server, type Socket } from "node:net";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readLocal, writeLocal } from "./local-wire.js";
import { REQUEST_TIMEOUT_MS } from "./timeouts.js";

export type PluginEndpoint = { port: number; token: string; reload?: true; version?: string };
export type PluginCommand = { key: string; action: "prompt" | "logs" | "reload"; text?: string; after?: number };
export function pluginEndpoint(value: any): PluginEndpoint | undefined {
  return value && Number.isInteger(value.port) && value.port > 0 && value.port <= 65535 && typeof value.token === "string" && /^[A-Za-z0-9_-]{43}$/.test(value.token) ? { port: value.port, token: value.token, ...(value.reload === true ? { reload: true } : {}), ...(typeof value.version === "string" && /^[0-9A-Za-z.+-]{1,128}$/.test(value.version) ? { version: value.version } : {}) } : undefined;
}
/** Loopback only; the bearer token stays in the user's private presence file. */
export class PluginControl {
  private readonly token = randomBytes(32).toString("base64url");
  private server?: Server;
  private sockets = new Set<Socket>();
  private prompting = false;
  private launches: number[] = [];
  constructor(private readonly command: (request: PluginCommand) => Promise<unknown>, private readonly afterReply?: (request: PluginCommand) => void) {}
  async start(): Promise<PluginEndpoint> {
    const server = this.server = createServer(socket => {
      if (this.sockets.size >= 16) { socket.destroy(); return; }
      this.sockets.add(socket); socket.once("close", () => this.sockets.delete(socket));
      socket.setTimeout(REQUEST_TIMEOUT_MS, () => socket.destroy()); let received = false;
      readLocal(socket, packet => {
        if (received) { socket.destroy(); return; } received = true;
        void (async () => {
          let prompt = false, accepted: PluginCommand | undefined;
          try {
            if (typeof packet.token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(packet.token) || !timingSafeEqual(Buffer.from(packet.token), Buffer.from(this.token))) throw new Error("Unauthenticated plugin request.");
            if (packet.type !== "request" || !/^[a-f0-9]{64}$/.test(packet.key) || !["prompt", "logs", "reload"].includes(packet.action)) throw new Error("Invalid plugin request.");
            if (packet.action === "prompt") {
              if (typeof packet.text !== "string" || !packet.text.trim() || packet.text.length > 16000) throw new Error("Invalid instructions.");
              this.launches = this.launches.filter(at => Date.now() - at < 10000);
              if (this.prompting || this.launches.length >= 10) throw new Error("This session is accepting another instruction. Try again shortly.");
              this.launches.push(Date.now()); this.prompting = prompt = true;
            } else if (packet.after !== undefined && (!Number.isSafeInteger(packet.after) || packet.after < 0)) throw new Error("Invalid output position.");
            const request: PluginCommand = { key: packet.key, action: packet.action, ...(packet.action === "prompt" ? { text: packet.text } : packet.action === "logs" ? { after: packet.after ?? 0 } : {}) };
            const result = await this.command(request); accepted = request;
            writeLocal(socket, { type: "reply", result });
          } catch (error) { writeLocal(socket, { type: "reply", error: error instanceof Error ? error.message.slice(0, 2048) : "Plugin request failed." }); }
          finally {
            if (prompt) this.prompting = false;
            // Reload tears down this endpoint. Flush its acknowledgement first.
            socket.end(() => {
              try { if (accepted) this.afterReply?.(accepted); }
              catch { process.stderr.write("Sideband: plugin reload could not start; reload manually.\n"); }
            });
          }
        })();
      });
    });
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen({ host: "127.0.0.1", port: 0 }, resolve); });
    return { port: (server.address() as { port: number }).port, token: this.token };
  }
  async close(): Promise<void> { for (const socket of this.sockets) socket.destroy(); if (this.server) await new Promise<void>(resolve => this.server!.close(() => resolve())); }
}
export function requestPlugin(endpoint: PluginEndpoint, command: PluginCommand, signal?: AbortSignal): Promise<any> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port: endpoint.port }); let settled = false;
    const finish = (error?: Error, result?: unknown) => { if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener("abort", abort); socket.destroy(); error ? reject(error) : resolve(result); };
    const abort = () => finish(new Error("Plugin request cancelled; acceptance is unknown."));
    const timer = setTimeout(() => finish(new Error("Plugin request timed out; acceptance is unknown. Check the terminal before resending.")), REQUEST_TIMEOUT_MS);
    socket.once("error", () => finish(new Error("The session's plugin is no longer reachable.")));
    socket.once("close", () => finish(new Error("Plugin connection lost; acceptance is unknown. Check the terminal before resending.")));
    socket.once("connect", () => { if (!writeLocal(socket, { type: "request", token: endpoint.token, ...command })) finish(new Error("Could not send plugin request.")); });
    readLocal(socket, packet => { if (packet.type !== "reply") finish(new Error("Invalid plugin response.")); else finish(packet.error ? new Error(String(packet.error).slice(0, 2048)) : undefined, packet.result); });
    signal?.addEventListener("abort", abort, { once: true }); if (signal?.aborted) abort();
  });
}
