import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import piSideband from "../src/pi-extension.js";
import { RoomProfiles } from "../src/room-profiles.js";
import { RoomServer } from "../src/room-server.js";
import { RoomClient } from "../src/room-client.js";
import { PluginPresence, presenceDirectory, readPluginPresence } from "../src/plugin-presence.js";
import { requestPlugin, type PluginEndpoint } from "../src/plugin-control.js";
import { reloadPiPlugins } from "../src/plugin-reload.js";
import { testTimeout } from "./waits.js";
import { STARTUP_TIMEOUT_MS } from "../src/timeouts.js";

async function until(check: () => boolean | Promise<boolean>) { const end = Date.now() + testTimeout(15000); while (!await check()) { if (Date.now() > end) throw new Error("PI reload did not settle."); await new Promise(r => setTimeout(r, 15)); } }
function host(id = "reload-session", file = "reload.jsonl") {
  const handlers = new Map<string, Function[]>(), commands = new Map<string, any>(), tools = new Map<string, any>(), received: string[] = [], prompts: string[] = [], notices: string[] = [];
  let dead = false;
  const ctx = { mode: "tui", hasUI: true, sessionManager: { getSessionId: () => id, getSessionFile: () => file }, ui: { notify(text: string) { notices.push(text); } } };
  piSideband({ registerTool: (tool: any) => tools.set(tool.name, tool), registerCommand: (name: string, command: any) => commands.set(name, command), on: (name: string, handler: Function) => handlers.set(name, [...(handlers.get(name) ?? []), handler]),
    sendUserMessage(text: string) { assert.ok(!dead); assert.notEqual(text, "/sideband-reload", "reload commands must never become model input"); prompts.push(text); },
    sendMessage(message: any) { assert.ok(!dead, "old PI API was used after reload"); received.push(message.content); } });
  const emit = async (event: string, value: object = {}) => { for (const handler of handlers.get(event) ?? []) await handler(value, ctx); if (event === "session_shutdown") dead = true; };
  const call = async (name: string, args: object = {}) => JSON.parse((await tools.get(name).execute("fixture", args, undefined, undefined, ctx)).content[0].text);
  return { ctx, emit, call, received, prompts, notices, command: (name: string, args = "") => commands.get(name).handler(args, ctx) };
}

test("PI reload keeps identity, room, output and queued pushes, with a fresh API; changed sessions and explicit off stay isolated", { timeout: testTimeout(45000) }, async t => {
  const server = await RoomServer.start({ host: "127.0.0.1", port: 0 }), profile = { server: `127.0.0.1:${server.port}`, password: server.password };
  await new RoomProfiles().save("reload-fixture", profile);
  const peer = new RoomClient(profile, "peer"); let current = host();
  try {
    await current.emit("session_start");
    await current.call("sideband_join_room", { name: "reload-user", room: "reload-room", profile: "reload-fixture" });
    await peer.connect(); await peer.joinRoom("reload-room");
    const before = await current.call("sideband_status");
    await current.emit("message_end", { message: { role: "assistant", content: "kept output" } });
    const previous = current; await previous.emit("session_shutdown", { reason: "reload" });
    await peer.send("held during reload");
    current = host(); await current.emit("session_start", { reason: "reload" });
    const after = await current.call("sideband_status");
    assert.equal(after.identity.id, before.identity.id); assert.equal(after.room.id, before.room.id);
    await until(() => current.received.some(text => text.includes("held during reload")));
    assert.equal((await peer.members()).length, 2);
    const endpoints = new Map<string, PluginEndpoint>(); let key = "";
    await until(async () => { const rows = await readPluginPresence(presenceDirectory, undefined, undefined, endpoints); key = rows.find(row => row.harness === "pi")?.key ?? ""; return !!key; });
    assert.equal(endpoints.get(key)!.reload, true);
    assert.ok((await requestPlugin(endpoints.get(key)!, { key, action: "logs" })).events.some((event: any) => event.text === "kept output"));
    await current.emit("session_shutdown", { reason: "reload" });
    current = host("other-session", "other.jsonl"); await current.emit("session_start", { reason: "new" });
    assert.deepEqual(await current.call("sideband_status"), { state: "off" });
    assert.equal((await peer.members()).length, 1, "a different session cannot inherit the handoff");
    await current.call("sideband_join_room", { name: "reload-user", room: "reload-room", profile: "reload-fixture" });
    await current.call("sideband_deactivate"); await current.emit("session_shutdown", { reason: "reload" });
    current = host("other-session", "other.jsonl"); await current.emit("session_start", { reason: "reload" });
    assert.deepEqual(await current.call("sideband_status"), { state: "off" }, "reload never undoes an explicit disconnect");
    await current.call("sideband_join_room", { name: "reload-user", room: "reload-room", profile: "reload-fixture" });
    t.mock.timers.enable({ apis: ["setTimeout"] });
    await current.emit("session_shutdown", { reason: "reload" });
    t.mock.timers.tick(STARTUP_TIMEOUT_MS); t.mock.timers.reset();
    await until(async () => (await peer.members()).length === 1);
    current = host("other-session", "other.jsonl"); await current.emit("session_start", { reason: "reload" });
    assert.deepEqual(await current.call("sideband_status"), { state: "off" }, "a failed reload expires its paused connection instead of leaving an orphan");
  } finally { await current.emit("session_shutdown", { reason: "quit" }); await peer.close(); await server.close(); }
});

test("PI without a command context requests manual reload and stays interactive; a late reload failure closes its detached room", { timeout: testTimeout(30000) }, async () => {
  const server = await RoomServer.start({ host: "127.0.0.1", port: 0 }), profile = { server: `127.0.0.1:${server.port}`, password: server.password };
  await new RoomProfiles().save("failure-fixture", profile);
  const peer = new RoomClient(profile, "peer"); let current = host("failure-session");
  try {
    await current.emit("session_start"); await current.call("sideband_join_room", { name: "reload-user", room: "failure-room", profile: "failure-fixture" });
    await peer.connect(); await peer.joinRoom("failure-room");
    const endpoints = new Map<string, PluginEndpoint>(); let key = "";
    await until(async () => { key = (await readPluginPresence(presenceDirectory, undefined, undefined, endpoints)).find(row => row.harness === "pi")?.key ?? ""; return !!key; });
    const endpoint = endpoints.get(key)!;
    assert.deepEqual(await requestPlugin(endpoint, { key, action: "reload" }), { queued: false });
    await until(() => current.notices.some(text => text.includes("/sideband-reload")));
    assert.deepEqual(current.prompts, []);
    await requestPlugin(endpoint, { key, action: "prompt", text: "still usable" }); assert.deepEqual(current.prompts, ["still usable"]);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    Object.assign(current.ctx, { waitForIdle: () => gate, reload: async () => { await current.emit("session_shutdown", { reason: "reload" }); throw new Error("Synthetic resource reload failure"); } });
    await current.command("sideband", "status");
    assert.deepEqual(await requestPlugin(endpoint, { key, action: "reload" }), { queued: true });
    release(); await until(async () => (await peer.members()).length === 1);
    current = host("failure-session"); await current.emit("session_start", { reason: "reload" });
    assert.deepEqual(await current.call("sideband_status"), { state: "off" });
  } finally { await current.emit("session_shutdown", { reason: "quit" }); await peer.close(); await server.close(); }
});

test("PI updater queues supported reloads after acknowledgement, skips current versions and reports older plugins", { timeout: testTimeout(30000) }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "sideband-reload-")); let queued = 0;
  const plugin = new PluginPresence("pi", dir, async () => ({}), { version: "0.28.3", reload: () => { queued++; void plugin.close(); } });
  const current = new PluginPresence("pi", dir, async () => ({}), { version: "0.29.0", reload: () => assert.fail("already-current plugin reloaded") });
  const old = new PluginPresence("pi", dir, async () => ({}));
  const omp = new PluginPresence("omp", dir, async () => ({}));
  try {
    plugin.replace([{ session: "outdated" }]); current.replace([{ session: "current" }]); old.replace([{ session: "old" }]); omp.replace([{ session: "omp" }]);
    await Promise.all([plugin.idle(), current.idle(), old.idle(), omp.idle()]);
    const result = await reloadPiPlugins("0.29.0", undefined, dir);
    assert.match(result.message, /queued for 1/); assert.match(result.message, /1 PI session\(s\) need/); assert.match(result.message, /1 PI session\(s\) already/);
    assert.equal(result.restartRequired, true); await until(() => queued === 1);
    const endpoints = new Map<string, PluginEndpoint>(), rows = await readPluginPresence(dir, undefined, undefined, endpoints), row = rows.find(row => row.harness === "omp")!;
    await assert.rejects(requestPlugin(endpoints.get(row.key)!, { key: row.key, action: "reload" }), /manual restart/);
  } finally { await Promise.all([plugin.close(), current.close(), old.close(), omp.close()]); await rm(dir, { recursive: true, force: true }); }
});
