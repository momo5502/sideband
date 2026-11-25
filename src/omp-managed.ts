import { STARTUP_TIMEOUT_MS, REQUEST_TIMEOUT_MS } from "./timeouts.js";
import { connect, type Socket } from "node:net";
import { isMainThread } from "node:worker_threads";
import { writeLocal, readLocal } from "./local-wire.js";
import { emitOmpEvent, managedInstructions, managedTools } from "./managed-omp.js";
import type { OmpApi, OmpContext } from "./omp-extension.js";
import { sidebandInstructions, sidebandTools } from "./room-tools.js";
import { toolParameters } from "./omp-extension.js";
import { randomUUID } from "node:crypto";

export type ManagedExtensionOptions = { pi?: boolean; onToken?(token: string): void; onRetire?(token: string, reason: string): void };

const ownerKey = Symbol.for("sideband.managed.omp.owner");
type GlobalOwner = typeof globalThis & { [ownerKey]?: boolean };
const legacyNames = new Set(sidebandTools.map(tool => tool.name));
function guardLegacyTools(api: OmpApi, descendant = false): () => Promise<void> {
  api.on("tool_call", event => {
    const name = (event as { toolName?: string }).toolName;
    if (name && legacyNames.has(name)) return { block: true, reason: descendant ? "Subagents must relay room communication through the parent agent." : "This session is managed by Sideband. Use the assigned sideband_room_* tools instead." };
  });
  return async () => {
    if (!api.getActiveTools || !api.getAllTools || !api.setActiveTools) return;
    const legacy = new Set(api.getAllTools().filter(tool => tool.sourceInfo?.source === "extension" && legacyNames.has(tool.name)).map(tool => tool.name));
    const active = api.getActiveTools(), kept = active.filter(name => !legacy.has(name));
    if (kept.length !== active.length) await api.setActiveTools(kept);
  };
}
function descendant(api: OmpApi): true { const hide = guardLegacyTools(api, true); api.on("session_start", async () => hide()); return true; }
/** Returns true when this factory belongs to a managed session (or one of its subagents). */
export function managedOmp(api: OmpApi, options: ManagedExtensionOptions = {}): boolean {
  const encoded = process.env.SIDEBAND_MANAGED_BRIDGE;
  if (!encoded) return (globalThis as GlobalOwner)[ownerKey] || process.env.SIDEBAND_MANAGED_DESCENDANT === "1" ? descendant(api) : false;
  // Consume before OMP can start subagents. Workers also reject the one-time token after use.
  delete process.env.SIDEBAND_MANAGED_BRIDGE;
  process.env.SIDEBAND_MANAGED_DESCENDANT = "1";
  if (!isMainThread || (globalThis as GlobalOwner)[ownerKey]) return descendant(api);
  const bootstrap = JSON.parse(encoded);
  const instance = randomUUID();
  if (!Number.isInteger(bootstrap.port) || bootstrap.port < 1 || bootstrap.port > 65535 || !/^[A-Za-z0-9_-]{43}$/.test(bootstrap.token)) throw new Error("Invalid managed Sideband bootstrap.");
  (globalThis as GlobalOwner)[ownerKey] = true;
  let current: OmpContext | undefined, socket: Socket | undefined, ready = false, closed = false, token = bootstrap.token;
  let retry: NodeJS.Timeout | undefined, flush: NodeJS.Timeout | undefined, sequence = 0, bytes = 0, nextId = 0;
  let reconnects = 0, reconnectUntil = 0;
  let textStreamed = false, thinkingStreamed = false;
  const pending = new Map<string, { resolve(value: any): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
  const hideLegacyTools = guardLegacyTools(api);
  const events: { seq: number; kind: string; text: string; bytes: number }[] = [];
  const record = (kind: string, value: string) => {
    const text = Buffer.byteLength(value) > 4096 ? Buffer.from(value).subarray(0, 4000).toString("utf8") + "\n[truncated]" : value;
    const size = Buffer.byteLength(text) + 128;
    events.push({ seq: ++sequence, kind, text, bytes: size }); bytes += size;
    while (events.length > 1000 || bytes > 2 * 1024 * 1024) bytes -= events.shift()!.bytes;
  };
  const session = () => current?.sessionManager.getSessionFile?.();
  const publishSession = () => { if (ready) writeLocal(socket, { type: "session", sessionFile: session() }); };
  const request = (type: string, params: object): Promise<any> => {
    const id = `omp-${++nextId}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error("Sideband controller request timed out; acceptance is unknown.")); }, REQUEST_TIMEOUT_MS);
      pending.set(id, { resolve, reject, timer });
      if (!ready || !writeLocal(socket, { type, id, ...params })) { clearTimeout(timer); pending.delete(id); reject(new Error("Sideband controller is disconnected.")); }
    });
  };
  const shutdown = (notify = true) => {
    if (closed) return; closed = true;
    if (retry) clearTimeout(retry); if (flush) clearInterval(flush);
    if (notify) writeLocal(socket, { type: "exit" }); socket?.end();
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error("OMP session closed.")); } pending.clear();
    delete (globalThis as GlobalOwner)[ownerKey];
  };
  const command = async (packet: any) => {
    const ctx = current;
    try {
      if (!ctx) throw new Error("OMP session is not ready.");
      if (packet.method === "prompt") {
        if (typeof packet.text !== "string" || !packet.text.trim() || packet.text.length > 16000 || !api.sendUserMessage) throw new Error("Invalid managed instructions or unsupported OMP version.");
        await api.sendUserMessage(packet.text, { deliverAs: "steer", attribution: "user" });
      } else if (packet.method === "aside") {
        if (typeof packet.text !== "string" || packet.text.length > 20000) throw new Error("Invalid room delivery.");
        api.sendMessage({ customType: "sideband", content: packet.text, display: true, attribution: "agent" }, { deliverAs: "aside", triggerTurn: true });
      } else if (packet.method === "interrupt") { if (!ctx.abort) throw new Error("OMP cannot interrupt this session."); ctx.abort(); }
      else if (packet.method === "shutdown") { if (!ctx.shutdown) throw new Error("OMP cannot shut down this session."); }
      else throw new Error("Unknown managed instruction.");
      writeLocal(socket, { type: "reply", id: packet.id, result: { accepted: true } });
      if (packet.method === "shutdown") setTimeout(() => ctx.shutdown?.(), 0);
    } catch (error) { writeLocal(socket, { type: "reply", id: packet.id, error: error instanceof Error ? error.message : "OMP instruction failed." }); }
  };
  const open = () => {
    if (closed || !current || socket) return;
    const file = session();
    if (!file) { current.ui.notify("Managed Sideband requires a saved OMP session.", "error"); return; }
    const connection = connect(bootstrap.port, "127.0.0.1"); socket = connection;
    connection.once("connect", () => writeLocal(connection, { type: "hello", role: "plugin", token, instance, sessionFile: file, hasUI: current?.hasUI, mode: current?.mode, busy: current?.isIdle ? !current.isIdle() : false }));
    readLocal(connection, packet => {
      if (packet.type === "ready" && typeof packet.token === "string") { token = packet.token; options.onToken?.(token); ready = true; reconnects = 0; reconnectUntil = 0; publishSession(); return; }
      if (!ready) return;
      if (packet.type === "command" && typeof packet.id === "string") void command(packet);
      if (packet.type === "reply") {
        const item = pending.get(packet.id); if (!item) return;
        pending.delete(packet.id); clearTimeout(item.timer);
        packet.error ? item.reject(new Error(String(packet.error))) : item.resolve(packet.result);
      }
    });
    connection.on("close", () => {
      if (socket !== connection) return; socket = undefined; ready = false;
      for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error("Sideband controller connection was lost; acceptance is unknown.")); } pending.clear();
      reconnectUntil ||= Date.now() + STARTUP_TIMEOUT_MS;
      if (!closed && Date.now() < reconnectUntil) { retry = setTimeout(open, Math.min(10000, 500 * 2 ** Math.min(reconnects++, 5), reconnectUntil - Date.now())); retry.unref(); }
      else if (!closed) { current?.ui.notify("Sideband controller was lost. This OMP terminal remains available locally; managed controls are disconnected.", "warning"); shutdown(); }
    });
  };
  flush = setInterval(() => {
    if (!ready || !events.length) return;
    const batch = events.slice(0, 16);
    if (writeLocal(socket, { type: "events", events: batch.map(({ bytes: _bytes, ...event }) => event) })) for (const event of events.splice(0, batch.length)) bytes -= event.bytes;
  }, 40); flush.unref();
  const bind = (ctx: OmpContext) => { current = ctx; if (!socket) open(); else publishSession(); };
  for (const event of ["session_start", "session_switch", "session_branch", "session_tree"]) api.on(event, async (_event, ctx) => { bind(ctx); await hideLegacyTools(); });
  api.on("session_shutdown", event => { const reason = (event as { reason?: string }).reason ?? "quit"; options.onRetire?.(token, reason); shutdown(!options.pi || reason === "quit"); });
  api.on("before_agent_start", async (event, ctx) => { bind(ctx); await hideLegacyTools(); return { systemPrompt: [...(event.systemPrompt ?? []).filter(line => line !== managedInstructions && line !== sidebandInstructions && !line.startsWith("On oh-my-pi, /sideband login")), managedInstructions] }; });
  for (const type of ["agent_start", "agent_end", "message_start", "message_update", "message_end", "tool_execution_start", "tool_execution_end", "tool_execution_update", "tool_stream_update", "extension_error"]) api.on(type, (event, ctx) => {
    current = ctx;
    const message = (event as { message?: { role?: string; content?: string | { type: string; text?: string; thinking?: string }[] } }).message;
    const delta = (event as { assistantMessageEvent?: { type?: string } }).assistantMessageEvent;
    if (type === "message_start" && message?.role === "assistant") { textStreamed = false; thinkingStreamed = false; }
    if (delta?.type === "text_delta") textStreamed = true;
    if (delta?.type === "thinking_delta") thinkingStreamed = true;
    if (type === "message_end" && message?.role === "assistant") {
      const parts = Array.isArray(message.content) ? message.content : [{ type: "text", text: message.content ?? "" }];
      if (!textStreamed) { const text = parts.filter(part => part.type === "text").map(part => part.text ?? "").join("\n"); if (text) record("assistant", text); }
      if (!thinkingStreamed) { const text = parts.filter(part => part.type === "thinking").map(part => part.thinking ?? "").join("\n"); if (text) record("thinking", text); }
      textStreamed = false; thinkingStreamed = false;
    }
    if (type === "message_end" && message?.role === "user") record("user", typeof message.content === "string" ? message.content : (message.content ?? []).filter(part => part.type === "text").map(part => part.text ?? "").join("\n"));
    try { emitOmpEvent({ event: record, state: state => { writeLocal(socket, { type: "state", state }); } }, { ...event, type }); }
    catch { record("error", "Could not serialize an OMP event."); }
  });
  for (const tool of managedTools) api.registerTool({ name: tool.name, label: tool.label, description: tool.description, loadMode: "essential",
    parameters: toolParameters(api, tool.parameters),
    async execute(_id, args, _signal, _update, ctx) {
      if (!current || ctx.sessionManager.getSessionId() !== current.sessionManager.getSessionId()) throw new Error("Subagents must relay room communication through the parent agent.");
      const result = await request("tool", { name: tool.name, args }); return { content: [{ type: "text", text: JSON.stringify(result) }], details: {} };
    },
  });
  api.registerCommand("sideband", { description: "Managed Sideband connection status", async handler(args, ctx) {
    ctx.ui.notify(args.trim() && args.trim() !== "status" ? "This agent's identity and room are managed from Sideband. Use its web panel to change rooms." : `Sideband managed session: ${closed ? "disconnected (local session only)" : ready ? "connected" : "reconnecting"}.`, "info");
  } });
  return true;
}
