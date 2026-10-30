import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import * as zod from "zod/v4";
import sideband, { OmpAdapter, type OmpApi, type OmpContext, type OmpTool } from "../src/omp-extension.js";
import { RoomProfiles } from "../src/room-profiles.js";
import { RoomServer } from "../src/room-server.js";
import { RoomClient } from "../src/room-client.js";
import { sidebandInstructions } from "../src/room-tools.js";

async function until(check: () => boolean) {
  const deadline = Date.now() + 4000;
  while (!check()) { if (Date.now() > deadline) throw new Error("No native OMP delivery."); await new Promise(resolve => setTimeout(resolve, 10)); }
}
class Host implements OmpApi {
  zod = zod;
  id = "main";
  tools = new Map<string, OmpTool>();
  commands = new Map<string, Parameters<OmpApi["registerCommand"]>[1]>();
  handlers = new Map<string, Parameters<OmpApi["on"]>[1][]>();
  messages: { message: Parameters<OmpApi["sendMessage"]>[0]; options: Parameters<OmpApi["sendMessage"]>[1] }[] = [];
  notices: string[] = [];
  inputs: { title: string; options: unknown }[] = [];
  answers: (string | undefined)[] = [];
  ctx: OmpContext = { mode: "tui", hasUI: true, sessionManager: { getSessionId: () => this.id }, ui: {
    input: async (title, _placeholder, options) => { this.inputs.push({ title, options }); return this.answers.shift(); },
    select: async () => this.answers.shift(), notify: text => { this.notices.push(text); },
  } };
  registerTool(tool: OmpTool) { this.tools.set(tool.name, tool); }
  registerCommand(name: string, command: Parameters<OmpApi["registerCommand"]>[1]) { this.commands.set(name, command); }
  on(event: string, handler: Parameters<OmpApi["on"]>[1]) { this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]); }
  sendMessage(message: Parameters<OmpApi["sendMessage"]>[0], options: Parameters<OmpApi["sendMessage"]>[1]) { this.messages.push({ message, options }); }
  async emit(name: string, event = {}) { return Promise.all((this.handlers.get(name) ?? []).map(handler => handler(event, this.ctx))); }
  async call(name: string, args: Record<string, unknown> = {}, signal?: AbortSignal) {
    const result = await this.tools.get(name)!.execute("call", args, signal, undefined, this.ctx);
    return JSON.parse(result.content[0]!.text);
  }
  command(args: string) { return this.commands.get("sideband")!.handler(args, this.ctx); }
}
async function fixture(saved = true) {
  const directory = await mkdtemp(join(tmpdir(), "sideband-omp-"));
  const server = await RoomServer.start({ host: "127.0.0.1", port: 0 });
  const profile = { server: `127.0.0.1:${server.port}`, password: server.password };
  const profiles = new RoomProfiles(directory); if (saved) await profiles.save("vps", profile);
  const host = new Host(); sideband(host, profiles);
  const peer = new RoomClient(profile, "peer");
  await host.emit("session_start"); await peer.connect();
  return { directory, server, profile, profiles, host, peer,
    async close() { await host.emit("session_shutdown"); await peer.close(); await server.close(); await rm(directory, { recursive: true, force: true }); },
  };
}

test("OMP native tools connect on named join and receive signed push at step boundaries with no polling", async () => {
  const f = await fixture(); const h = f.host;
  try {
    assert.equal(h.tools.size, 10); assert.deepEqual(await h.call("sideband_status"), { state: "off" });
    await assert.rejects(h.call("sideband_join_room", { room: "work" }), /Ask the user/);
    assert.equal(h.tools.get("sideband_join_room")!.parameters.safeParse({ room: "work" }).success, false);
    await assert.rejects(h.call("sideband_join_room", { room: "work", name: "" }), /Ask the user/);
    await assert.rejects(h.call("sideband_join_room", { room: "work", name: "worker", sender: "forged" }), /Unexpected/);
    const room = await h.call("sideband_join_room", { room: "work", name: "worker" });
    await f.peer.joinRoom(room.id); await until(() => h.messages.length === 1);
    await f.peer.send("Hello from another harness"); await until(() => h.messages.length === 2);
    assert.deepEqual(h.messages[1], { message: { customType: "sideband", content: '<sideband sender="peer">\nHello from another harness\n</sideband>', display: true, attribution: "agent" }, options: { deliverAs: "aside", triggerTurn: true } });
    const received: string[] = []; f.peer.onMessage(message => received.push(message.text));
    await h.call("sideband_send", { text: "Explicit reply only" }); await until(() => received.length === 1);
    assert.deepEqual(received, ["Explicit reply only"]); assert.equal(h.messages.length, 2, "no self-echo");
    assert.equal((await h.call("sideband_history")).length, 2);
    await h.call("sideband_join_room", { room: "other-task", name: "worker" });
    await f.peer.send("Old room"); await h.call("sideband_members");
    assert.equal(h.messages.length, 2, "no cross-room messages or implicit history injection");
    const controller = new AbortController(); controller.abort();
    await assert.rejects(h.call("sideband_send", { text: "Cancelled" }, controller.signal), /cancelled/);
  } finally { await f.close(); }
});

test("OMP lifecycle disconnects on session switch/branch/shutdown and factory bindings do not share connections", async () => {
  const f = await fixture(); const h = f.host; const child = new Host(); child.id = "child"; sideband(child, f.profiles);
  try {
    const room = await h.call("sideband_join_room", { room: "work", name: "parent" }); await f.peer.joinRoom(room.id);
    await child.emit("session_start"); assert.deepEqual(await child.call("sideband_status"), { state: "off" });
    await child.emit("session_shutdown"); assert.equal((await h.call("sideband_status")).state, "on");
    h.id = "new-session"; await h.emit("session_switch");
    assert.deepEqual(await h.call("sideband_status"), { state: "off" }); assert.equal((await f.peer.members()).length, 1);
    await h.call("sideband_join_room", { room: "work", name: "parent" }); await h.emit("session_branch");
    assert.deepEqual(await h.call("sideband_status"), { state: "off" });
    await h.call("sideband_join_room", { room: "work", name: "parent" }); await h.emit("session_tree");
    assert.deepEqual(await h.call("sideband_status"), { state: "off" });
    await h.call("sideband_join_room", { room: "work", name: "parent" });
    const before = h.messages.length; await h.emit("session_shutdown"); await f.peer.send("After shutdown");
    assert.equal(h.messages.length, before); assert.equal((await f.peer.members()).length, 1);
  } finally { await child.emit("session_shutdown"); await f.close(); }
});

test("OMP session changes fence a delayed join and the adapter refuses stale delivery", async () => {
  const f = await fixture(); let release!: () => void;
  try {
    const gate = new Promise<void>(resolve => { release = resolve; }); const original = f.profiles.resolve.bind(f.profiles);
    let loading = false;
    f.profiles.resolve = async name => { loading = true; await gate; return original(name); };
    const joining = f.host.call("sideband_join_room", { room: "work", name: "worker" });
    const rejected = assert.rejects(joining, /cancelled|changed/);
    await until(() => loading); f.host.id = "switched"; const switched = f.host.emit("session_switch"); release();
    await switched; await rejected; assert.deepEqual(await f.host.call("sideband_status"), { state: "off" });
    assert.deepEqual(await f.peer.listRooms(), []);
    const adapter = new OmpAdapter(f.host, () => false);
    await assert.rejects(adapter.deliver({ messageId: "m", channelId: "r", sender: { id: "a" }, senderAccountId: "a", text: "stale", attachments: [], createdAt: 1 }), /changed/);
    assert.equal(f.host.messages.length, 0);
  } finally { release?.(); await f.close(); }
});

test("OMP native login uses a masked dialog outside model context and joins with the user's chosen name", async () => {
  const f = await fixture(false); const h = f.host;
  try {
    h.answers.push(f.server.password); await h.command(`login ${f.profile.server}`);
    assert.equal((h.inputs[0]!.options as { secret: boolean }).secret, true);
    assert.equal((await f.profiles.load("default")).password, f.server.password);
    assert.deepEqual(await h.call("sideband_status"), { state: "off" });
    assert.ok(!JSON.stringify(h.notices).includes(f.server.password)); assert.equal(h.messages.length, 0);
    h.answers.push("momo"); await h.command("join named-room");
    assert.equal((await h.call("sideband_status")).identity.name, "momo");
    assert.equal((await h.call("sideband_status")).room.name, "named-room");
    await h.command("join second-room"); assert.equal(h.inputs.length, 2, "reuse the user's chosen name");
    await h.command("off"); assert.deepEqual(await h.call("sideband_status"), { state: "off" });
    h.ctx.mode = "rpc"; await h.command(`login ${f.profile.server}`); assert.match(h.notices.at(-1)!, /interactive/);
    assert.equal(h.inputs.length, 2, "headless login never requests an unmasked password");
  } finally { await f.close(); }
});

test("OMP cancellation, session change during credential entry, and invalid login never overwrite saved credentials", async () => {
  const f = await fixture(); const h = f.host;
  try {
    h.answers.push(undefined); await h.command(`login ${f.profile.server}`);
    h.answers.push("not-a-password"); await h.command(`login ${f.profile.server}`);
    assert.equal((await f.profiles.load("vps")).password, f.server.password);
    assert.ok(h.notices.length > 0, "failed login is reported to the user");
    let complete!: (value: string) => void; let asked = false;
    h.ctx.ui.input = async () => { asked = true; return new Promise<string>(resolve => { complete = resolve; }); };
    const loggingIn = h.command(`login ${f.profile.server}`); await until(() => asked);
    h.id = "different"; await h.emit("session_switch"); complete("not-a-password"); await loggingIn;
    assert.equal((await f.profiles.load("vps")).password, f.server.password);
    assert.ok(!h.notices.some(text => text.includes("not-a-password")));
    const before = await h.emit("before_agent_start", { systemPrompt: ["Original policy", sidebandInstructions] });
    assert.equal((before[0] as { systemPrompt: string[] }).systemPrompt.filter(line => line === sidebandInstructions).length, 1);
    assert.equal((before[0] as { systemPrompt: string[] }).systemPrompt[0], "Original policy");
  } finally { await f.close(); }
});

test("standalone OMP extension loads without node_modules and registers its native command/tools", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sideband-omp-bundle-"));
  const h = new Host();
  try {
    const path = join(directory, "sideband-omp.cjs"); await copyFile(resolve("dist/sideband-omp.cjs"), path);
    const extension = createRequire(import.meta.url)(path);
    extension(h, new RoomProfiles(directory)); await h.emit("session_start");
    assert.ok(h.commands.has("sideband")); assert.equal(h.tools.size, 10); assert.deepEqual(await h.call("sideband_status"), { state: "off" });
  } finally { await h.emit("session_shutdown"); await rm(directory, { recursive: true, force: true }); }
});
