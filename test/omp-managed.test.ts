import test from "node:test";
import assert from "node:assert/strict";
import { createServer, connect, type Socket } from "node:net";
import { randomBytes } from "node:crypto";
import * as zod from "zod/v4";
import sideband, { type OmpApi, type OmpContext, type OmpTool } from "../src/omp-extension.js";
import { writeLocal, readLocal } from "../src/local-wire.js";

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check: () => boolean) { const end = Date.now() + 5000; while (!check()) { if (Date.now() > end) throw new Error("Managed plugin condition timed out."); await pause(10); } }
class Host implements OmpApi {
  zod = zod;
  tools = new Map<string, OmpTool>(); handlers = new Map<string, Function[]>();
  user: { text: string; options: unknown }[] = []; asides: object[] = []; aborted = 0; closed = 0; rejectPrompt = false;
  session = "root"; file = "/fixture/root.jsonl";
  active = ["read", "custom_tool", "sideband_send", "sideband_room_send"];
  getActiveTools() { return this.active; }
  getAllTools() { return this.active.map(name => ({ name, sourceInfo: { source: name === "sideband_send" ? "extension" : "builtin" } })); }
  async setActiveTools(names: string[]) { this.active = names; }
  ctx: OmpContext = { mode: "tui", hasUI: true, sessionManager: { getSessionId: () => this.session, getSessionFile: () => this.file },
    isIdle: () => true, abort: () => { this.aborted++; }, shutdown: () => { this.closed++; }, ui: { input: async () => undefined, select: async () => undefined, notify: () => {} } };
  registerTool(tool: OmpTool) { this.tools.set(tool.name, tool); }
  registerCommand() {}
  on(name: string, handler: Function) { this.handlers.set(name, [...(this.handlers.get(name) ?? []), handler]); }
  sendMessage(message: Parameters<OmpApi["sendMessage"]>[0], options: Parameters<OmpApi["sendMessage"]>[1]) { this.asides.push({ message, options }); }
  async sendUserMessage(text: string, options?: unknown) { if (this.rejectPrompt) throw new Error("Message dropped by OMP"); this.user.push({ text, options }); }
  async emit(name: string, event: object = {}) { for (const handler of this.handlers.get(name) ?? []) await handler(event, this.ctx); }
}
test("the existing OMP plugin manages native UI input, room tools, events, session switches and reconnects without subagent binding", async () => {
  const original = process.env.SIDEBAND_MANAGED_BRIDGE, originalMarker = process.env.SIDEBAND_MANAGED_DESCENDANT, token = randomBytes(32).toString("base64url"), reconnect = randomBytes(32).toString("base64url");
  const packets: any[] = [], sockets = new Set<Socket>(); let current: Socket | undefined;
  const server = createServer(socket => {
    sockets.add(socket); socket.on("close", () => sockets.delete(socket));
    readLocal(socket, packet => {
      packets.push(packet);
      if (packet.type === "hello") { assert.ok(packet.token === token || packet.token === reconnect); current = socket; writeLocal(socket, { type: "ready", token: reconnect }); }
      if (packet.type === "tool") writeLocal(socket, { type: "reply", id: packet.id, result: { text: packet.args.text } });
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as import("node:net").AddressInfo).port;
  const host = new Host(); process.env.SIDEBAND_MANAGED_BRIDGE = JSON.stringify({ port, token }); sideband(host);
  try {
    assert.equal(process.env.SIDEBAND_MANAGED_BRIDGE, undefined, "subprocesses must not inherit launch credentials");
    await host.emit("session_start"); await until(() => packets.some(packet => packet.type === "session"));
    assert.deepEqual(host.active, ["read", "custom_tool", "sideband_room_send"], "only the legacy room tools are removed");
    assert.equal((await host.handlers.get("tool_call")![0]!({ toolName: "sideband_send" }, host.ctx)).block, true);
    const child = new Host(); sideband(child); assert.equal(child.tools.size, 0, "a subagent or duplicate factory cannot claim the managed identity");
    const send = async (method: string, fields: object = {}) => {
      const id = String(Math.random()); writeLocal(current, { type: "command", id, method, ...fields });
      await until(() => packets.some(packet => packet.type === "reply" && packet.id === id)); return packets.find(packet => packet.type === "reply" && packet.id === id);
    };
    assert.equal((await send("prompt", { text: "Web instructions" })).error, undefined);
    assert.deepEqual(host.user, [{ text: "Web instructions", options: { deliverAs: "steer", attribution: "user" } }]);
    host.rejectPrompt = true; assert.match((await send("prompt", { text: "Rejected" })).error, /Message dropped/); host.rejectPrompt = false;
    await send("aside", { text: '<sideband sender="peer">hi</sideband>' }); assert.equal(host.asides.length, 1);
    await send("interrupt"); assert.equal(host.aborted, 1);
    const result = await host.tools.get("sideband_room_send")!.execute("tool", { text: "Explicit room send" }, undefined, undefined, host.ctx); assert.match(result.content[0]!.text, /Explicit room send/);
    await host.emit("message_update", { assistantMessageEvent: { type: "text_delta", delta: "Native output" } });
    await host.emit("message_end", { message: { role: "user", content: [{ type: "text", text: "Typed locally" }] } });
    await until(() => packets.some(packet => packet.type === "events" && packet.events.some((event: any) => event.text === "Typed locally")));
    await host.emit("message_start", { message: { role: "assistant" } });
    await host.emit("message_end", { message: { role: "assistant", content: [{ type: "text", text: "Non-streamed response" }] } });
    await until(() => packets.some(packet => packet.type === "events" && packet.events.some((event: any) => event.text === "Non-streamed response")));
    host.session = "switched"; host.file = "/fixture/switched.jsonl"; await host.emit("session_switch");
    await until(() => packets.some(packet => packet.type === "session" && packet.sessionFile === host.file));
    current!.destroy(); await until(() => packets.filter(packet => packet.type === "hello").length === 2);
    assert.equal(packets.filter(packet => packet.type === "hello")[1].token, reconnect);
    await until(() => packets.filter(packet => packet.type === "session").length >= 3);
    await send("shutdown"); await until(() => host.closed === 1);
  } finally {
    await host.emit("session_shutdown"); for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve()));
    if (original === undefined) delete process.env.SIDEBAND_MANAGED_BRIDGE; else process.env.SIDEBAND_MANAGED_BRIDGE = original;
    if (originalMarker === undefined) delete process.env.SIDEBAND_MANAGED_DESCENDANT; else process.env.SIDEBAND_MANAGED_DESCENDANT = originalMarker;
  }
});
test("a managed descendant cannot acquire manual room tools using inherited profiles", async () => {
  const previous = process.env.SIDEBAND_MANAGED_DESCENDANT; process.env.SIDEBAND_MANAGED_DESCENDANT = "1";
  try {
    const child = new Host(); sideband(child); assert.equal(child.tools.size, 0);
    await child.emit("session_start"); assert.ok(!child.active.includes("sideband_send"));
    assert.equal((await child.handlers.get("tool_call")![0]!({ toolName: "sideband_send" }, child.ctx)).block, true);
  }
  finally { if (previous === undefined) delete process.env.SIDEBAND_MANAGED_DESCENDANT; else process.env.SIDEBAND_MANAGED_DESCENDANT = previous; }
});
