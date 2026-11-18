import { createServer, connect, type Socket } from "node:net";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile, unlink } from "node:fs/promises";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { managedTools, type OmpHost } from "./managed-omp.js";
import { privateJson } from "./update-runtime.js";
import { readLocal, writeLocal } from "./local-wire.js";

/** Local MCP bridge: the harness never receives the central server's password or signing key. */
export class ManagedRoomTools {
  private readonly token = randomBytes(32).toString("base64url");
  private readonly sockets = new Set<Socket>();
  private readonly server = createServer(socket => {
    if (this.sockets.size >= 8) { socket.destroy(); return; }
    this.sockets.add(socket); socket.once("close", () => this.sockets.delete(socket));
    let authenticated = false, active = 0;
    const timer = setTimeout(() => socket.destroy(), 5000);
    socket.once("close", () => clearTimeout(timer));
    readLocal(socket, packet => {
      if (!authenticated) {
        if (packet.type !== "hello" || typeof packet.token !== "string" || packet.token.length !== this.token.length || !timingSafeEqual(Buffer.from(packet.token), Buffer.from(this.token))) { socket.destroy(); return; }
        authenticated = true; clearTimeout(timer); writeLocal(socket, { type: "ready" }); return;
      }
      if (packet.type === "hook" && this.hook && typeof packet.id === "string" && active < 16) {
        active++;
        void Promise.resolve().then(() => this.hook!(packet.event)).then(() => writeLocal(socket, { type: "result", id: packet.id, result: {} }))
          .catch(() => writeLocal(socket, { type: "result", id: packet.id, error: "Native hook failed." })).finally(() => { active--; }); return;
      }
      if (packet.type !== "tool" || typeof packet.id !== "string" || packet.id.length > 100 || !managedTools.some(tool => tool.name === packet.name) || active >= 16) { socket.destroy(); return; }
      active++;
      void this.host.tool(packet.name, packet.args).then(result => writeLocal(socket, { type: "result", id: packet.id, result }))
        .catch(error => writeLocal(socket, { type: "result", id: packet.id, error: error instanceof Error ? error.message : "Room tool failed." })).finally(() => { active--; });
    });
  });
  private closing?: Promise<void>;
  constructor(private readonly host: OmpHost, readonly path: string, private readonly hook?: (event: any) => void | Promise<void>) {}
  async start(): Promise<void> {
    await new Promise<void>((resolve, reject) => { this.server.once("error", reject); this.server.listen(0, "127.0.0.1", () => { this.server.off("error", reject); resolve(); }); });
    await privateJson(this.path, { port: (this.server.address() as { port: number }).port, token: this.token });
  }
  close(): Promise<void> { return this.closing ??= (async () => { for (const socket of this.sockets) socket.destroy(); await new Promise<void>(resolve => this.server.close(() => resolve())); await unlink(this.path).catch(() => {}); })(); }
}

/** Claude runs this explicit per-session hook; it never reads another session's transcript or credentials. */
export async function runManagedHook(path: string): Promise<void> {
  let input = ""; for await (const chunk of process.stdin) { input += chunk.toString(); if (Buffer.byteLength(input) > 512 * 1024) return; }
  let socket: Socket | undefined;
  try {
    const event = JSON.parse(input), config = JSON.parse(await readFile(path, "utf8"));
    if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535 || !/^[\w-]{43}$/.test(config.token)) return;
    socket = connect({ host: "127.0.0.1", port: config.port });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { socket!.destroy(); reject(new Error("Hook timed out.")); }, 3000);
      const finish = (error?: Error) => { clearTimeout(timer); error ? reject(error) : resolve(); };
      socket!.once("error", finish); socket!.once("close", () => finish(new Error("Controller disconnected.")));
      socket!.once("connect", () => writeLocal(socket, { type: "hello", token: config.token }));
      readLocal(socket!, packet => { if (packet.type === "ready") writeLocal(socket, { type: "hook", id: "hook", event }); else if (packet.type === "result") finish(packet.error ? new Error(packet.error) : undefined); });
    });
  } catch { /* A missing controller must not prevent local use of the native harness. */ }
  finally { socket?.destroy(); }
}

export async function runManagedMcp(path: string): Promise<void> {
  const config = JSON.parse(await readFile(path, "utf8"));
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535 || typeof config.token !== "string" || !/^[\w-]{43}$/.test(config.token)) throw new Error("Invalid managed MCP bootstrap.");
  const socket = connect({ host: "127.0.0.1", port: config.port }); let next = 0;
  const pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
  const server = new Server({ name: "sideband-managed", version: "1.0.0" }, { capabilities: { tools: {} } });
  const ready = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { socket.destroy(); reject(new Error("Managed room bridge timed out.")); }, 5000);
    socket.once("error", reject); socket.once("connect", () => writeLocal(socket, { type: "hello", token: config.token }));
    socket.once("close", () => { clearTimeout(timer); reject(new Error("Managed room bridge disconnected.")); });
    readLocal(socket, packet => {
      if (packet.type === "ready") { clearTimeout(timer); resolve(); }
      else if (packet.type === "result") { const item = pending.get(packet.id); if (!item) return; clearTimeout(item.timer); pending.delete(packet.id); packet.error ? item.reject(new Error(packet.error)) : item.resolve(packet.result); }
    });
  });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: managedTools.map(tool => ({ name: tool.name, description: tool.description, inputSchema: tool.parameters as any })) }));
  server.setRequestHandler(CallToolRequestSchema, async request => {
    try {
      const result = await new Promise((resolve, reject) => {
        const id = String(++next), timer = setTimeout(() => { pending.delete(id); reject(new Error("Room tool timed out; acceptance is unknown.")); }, 25000);
        if (pending.size >= 16) { clearTimeout(timer); reject(new Error("Too many room requests.")); return; }
        pending.set(id, { resolve, reject, timer });
        if (!writeLocal(socket, { type: "tool", id, name: request.params.name, args: request.params.arguments ?? {} })) { clearTimeout(timer); pending.delete(id); reject(new Error("Room bridge is disconnected.")); }
      });
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (error) { return { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : "Room tool failed." }] }; }
  });
  let closing = false;
  const close = () => { if (closing) return; closing = true; for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error("Managed room bridge closed.")); } pending.clear(); socket.destroy(); void server.close(); };
  socket.once("close", close); server.onclose = close;
  try { await ready; await server.connect(new StdioServerTransport()); } catch (error) { close(); throw error; }
}
