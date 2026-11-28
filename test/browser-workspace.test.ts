import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { JSDOM } from "jsdom";
import WebSocket from "ws";
import { RoomServer } from "../src/room-server.js";
import { RoomClient } from "../src/room-client.js";
import { BrowserRoomClient } from "../src/browser-protocol.js";
import { mentionsUsername, BrowserWorkspace } from "../src/browser-workspace.js";
import type { ControlCommand, ManagedAgent } from "../src/orchestration-protocol.js";
import { until } from "./browser-fixture.js";
import { RuntimeUpdater } from "../src/updater.js";
import { resolve } from "node:path";
import { draftsStorage, identityStorage, loginStorage, roomsStorage, reloadStorage } from "../src/browser-workspace.js";

function workspace(server: RoomServer, options: { build?: string; saved?: Record<string, string>; reload?: () => void } = {}) {
  const origin = `http://127.0.0.1:${server.statusPort}`, dom = new JSDOM("", { url: `${origin}/chat`, pretendToBeVisual: true });
  const sockets = new Set<WebSocket>();
  if (options.build) { const meta = dom.window.document.createElement("meta"); meta.name = "sideband-build"; meta.content = options.build; dom.window.document.head.append(meta); }
  for (const [key, value] of Object.entries(options.saved ?? {})) (key === loginStorage ? dom.window.localStorage : dom.window.sessionStorage).setItem(key, value);
  const store = new BrowserWorkspace(dom.window as unknown as Window, (url, password, name, key) => new BrowserRoomClient(url, password, name, key,
    address => { const socket = new WebSocket(address, { origin }); sockets.add(socket); socket.once("close", () => sockets.delete(socket)); return socket as unknown as globalThis.WebSocket; }), options.reload);
  return { store, dom, sockets, close() { store.dispose(); dom.window.close(); } };
}

test("browser update reload preserves identity, room membership and drafts across new room IDs, and prevents stale-page loops", async () => {
  const updater = new RuntimeUpdater("server", resolve("dist/src/cli.js"), resolve(".cache/reload-fixture"), async () => {});
  updater.build.commit = "a".repeat(40);
  const server = await RoomServer.start({ host: "127.0.0.1", port: 0, statusPort: 0, graceMs: 0, updater });
  let reloads = 0;
  const page = workspace(server, { build: updater.build.commit, reload: () => reloads++ });
  const pages = [page];
  try {
    await page.store.login("human", server.password); await page.store.openRoom("work");
    const firstRoom = page.store.snapshot().joined[0]!;
    page.store.drafts.set(`room:${firstRoom.id}`, "Unsent\n**room draft**");
    const agentId = randomUUID(); page.store.drafts.set(`agent:${agentId}`, "Private draft");
    await page.store.refreshControl(); assert.equal(page.store.snapshot().serverUpdate, undefined);
    // Same package version, different commit: reconnect is enough, without clicking Check.
    updater.build.commit = "b".repeat(40);
    for (const socket of page.sockets) socket.terminate();
    await until(() => page.store.snapshot().serverUpdate?.build === updater.build.commit);
    const recreated = page.store.snapshot().joined[0]!;
    assert.equal(recreated.id, firstRoom.id);
    assert.equal(page.store.drafts.get(`room:${recreated.id}`), "Unsent\n**room draft**");
    const composer = page.dom.window.document.createElement("form"), input = page.dom.window.document.createElement("textarea");
    composer.className = "composer"; composer.append(input); page.dom.window.document.body.append(composer); input.focus();
    input.dispatchEvent(new page.dom.window.Event("input", { bubbles: true })); page.store.reloadUpdated(); assert.equal(reloads, 0, "active typing defers automatic reload"); input.blur();
    const prototype = Object.getPrototypeOf(page.dom.window.sessionStorage), write = prototype.setItem;
    prototype.setItem = function(key: string, value: string) { if (key === draftsStorage) throw new Error("Storage is full"); return write.call(this, key, value); };
    page.store.reloadUpdated(); assert.equal(reloads, 0); assert.match(page.store.snapshot().error, /Copy your drafts/);
    prototype.setItem = write;
    page.store.reloadUpdated(true); page.store.reloadUpdated(true); assert.equal(reloads, 1);
    const saved = Object.fromEntries([loginStorage, identityStorage, roomsStorage, draftsStorage, reloadStorage].map(key => [key, (key === loginStorage ? page.dom.window.localStorage : page.dom.window.sessionStorage).getItem(key)!]));
    const identity = JSON.parse(saved[identityStorage]!).key;
    page.close();
    await until(() => (server as unknown as { rooms: Map<string, unknown> }).rooms.size === 0);
    const fresh = workspace(server, { build: updater.build.commit, saved }); pages.push(fresh); fresh.store.start();
    await until(() => fresh.store.snapshot().view.kind === "room");
    const room = fresh.store.snapshot().joined[0]!;
    assert.equal(room.name, "work"); assert.equal(room.id, recreated.id);
    assert.equal(fresh.store.drafts.get(`room:${room.id}`), "Unsent\n**room draft**"); assert.equal(fresh.store.drafts.get(`agent:${agentId}`), "Private draft");
    assert.equal(JSON.parse(fresh.dom.window.sessionStorage.getItem(identityStorage)!).key, identity);
    assert.equal(fresh.store.snapshot().serverUpdate, undefined);
    // A stale cache may serve the old HTML again. It must not repeatedly reload itself.
    fresh.close();
    const stale = workspace(server, { build: "a".repeat(40), saved, reload: () => reloads++ }); pages.push(stale); stale.store.start();
    await until(() => !!stale.store.snapshot().serverUpdate);
    assert.equal(stale.store.snapshot().serverUpdate?.automatic, false); stale.store.reloadUpdated(); assert.equal(reloads, 1);
    stale.store.reloadUpdated(true); assert.equal(reloads, 2);
  } finally { for (const page of pages) page.close(); await server.close(); }
});
test("leaving while the browser reconnects cancels room restoration", async () => {
  const server = await RoomServer.start({ host: "127.0.0.1", port: 0, statusPort: 0 }), page = workspace(server);
  const peer = new RoomClient({ server: `127.0.0.1:${server.port}`, password: server.password }, "peer");
  try {
    await peer.connect(); const room = await peer.joinRoom("stay-left"); await page.store.login("human", server.password); await page.store.openRoom(room.id);
    for (const socket of page.sockets) socket.terminate(); await until(() => page.store.snapshot().connection === "reconnecting");
    await page.store.leaveRoom(); await until(() => page.store.snapshot().connection === "on");
    assert.equal(page.store.snapshot().joined.length, 0); assert.equal(page.store.snapshot().view.kind, "home"); await until(async () => (await peer.members()).length === 1);
  } finally { page.close(); await peer.close(); await server.close(); }
});

test("the Agents page stops output watching, wins over a slow room join and survives reconnect", async () => {
  const server = await RoomServer.start({ host: "127.0.0.1", port: 0, statusPort: 0 }), page = workspace(server);
  const profile = { server: `127.0.0.1:${server.port}`, password: server.password }, worker = new RoomClient(profile), runner = new RoomClient(profile, "watched-agent");
  const machineId = randomUUID(), agentId = randomUUID(), watches: string[] = [];
  let release: (() => void) | undefined;
  const internals = server as unknown as { request: (...args: any[]) => unknown }, original = internals.request.bind(server);
  internals.request = (...args) => {
    const result = original(...args);
    if (args[2] === "control.watch") watches.push(args[3].agentId);
    if (args[2] === "subscribe") return Promise.resolve(result).then(value => new Promise(resolve => { release = () => resolve(value); }));
    return result;
  };
  runner.onEvent((event, command: ControlCommand) => { if (event === "control.command") void runner.request("control.reply", { id: command.id, result: { events: [], first: 1, next: 1 } }).catch(() => {}); });
  try {
    await worker.connect(); await runner.connect(); await worker.request("control.worker", { machine: { id: machineId, name: "machine", platform: "test", harnesses: ["omp"] } });
    await runner.request("control.runner", { agent: { id: agentId, name: "watched-agent", harness: "omp", machineId, machineName: "machine", state: "idle", createdAt: Date.now(), room: "" } });
    await page.store.login("human", server.password); await page.store.selectAgent(agentId); assert.equal(watches.at(-1), agentId);
    page.store.drafts.set(`agent:${agentId}`, "Keep this draft");
    const opening = page.store.openRoom("slow-room"); opening.catch(() => {}); await until(() => !!release);
    page.store.showAgents(); assert.equal(page.store.snapshot().view.kind, "agents"); assert.equal(page.store.snapshot().loading, false);
    await until(() => watches.at(-1) === ""); release!(); await opening;
    assert.equal(page.store.snapshot().view.kind, "agents"); assert.equal(page.store.snapshot().joined[0]?.name, "slow-room");
    // Only the first subscription was delayed; room restoration can now complete.
    internals.request = original;
    for (const socket of page.sockets) socket.terminate(); await until(() => page.store.snapshot().connection === "reconnecting"); await until(() => page.store.snapshot().connection === "on");
    assert.equal(page.store.snapshot().view.kind, "agents"); assert.equal(page.store.drafts.get(`agent:${agentId}`), "Keep this draft");
  } finally { release?.(); page.close(); await runner.close(); await worker.close(); await server.close(); }
});
test("room switching fences sends by the displayed room id and never sends an old draft to the newly subscribed room", async () => {
  const server = await RoomServer.start({ host: "127.0.0.1", port: 0, statusPort: 0 }); const profile = { server: `127.0.0.1:${server.port}`, password: server.password };
  const a = new RoomClient(profile, "alice"), b = new RoomClient(profile, "bob"), page = workspace(server); const received: string[] = [];
  try {
    await a.connect(); await b.connect(); const alpha = await a.joinRoom("Alpha"), beta = await b.joinRoom("Beta"); a.onMessage(item => received.push(`alpha:${item.text}`)); b.onMessage(item => received.push(`beta:${item.text}`));
    await page.store.login("human", server.password); await page.store.openRoom(alpha.id);
    const switching = page.store.openRoom(beta.id);
    await assert.rejects(page.store.sendRoom(alpha.id, "old draft"), /room changed/i); await switching;
    await assert.rejects(page.store.sendRoom(alpha.id, "still old"), /room changed/i);
    assert.deepEqual(received, []); await page.store.sendRoom(beta.id, "correct room"); await until(() => received.length === 1);
    assert.deepEqual(received, ["beta:correct room"]);
  } finally { page.close(); await a.close(); await b.close(); await server.close(); }
});
test("a stale in-flight control list cannot hide a just-launched agent or leave a synthetic preparing entry after removal", async () => {
  const server = await RoomServer.start({ host: "127.0.0.1", port: 0, statusPort: 0 }), page = workspace(server);
  const profile = { server: `127.0.0.1:${server.port}`, password: server.password }, worker = new RoomClient(profile), runner = new RoomClient(profile, "new-agent");
  const machineId = randomUUID(); let release: (() => void) | undefined, hold = false, agent: ManagedAgent | undefined;
  const errors: unknown[] = [];
  worker.onEvent((event, command: ControlCommand) => {
    if (event !== "control.command") return;
    void (async () => {
      agent = { ...(command.params.spec as ManagedAgent), id: command.params.id as string, machineId, machineName: "machine", state: "preparing", online: true, room: "", createdAt: Date.now() };
      await runner.request("control.runner", { agent }); await worker.request("control.reply", { id: command.id, result: {} });
    })().catch(error => errors.push(error));
  });
  runner.onEvent((event, command: ControlCommand) => { if (event === "control.command") void runner.request("control.reply", { id: command.id, result: { events: [], first: 1, next: 1 } }).catch(error => errors.push(error)); });
  try {
    await worker.connect(); await runner.connect(); await worker.request("control.worker", { machine: { id: machineId, name: "machine", platform: "test", harnesses: ["omp"] } });
    await page.store.login("human", server.password);
    // Delay a real protocol response after its old snapshot is captured, while allowing launch RPCs through.
    const internals = server as unknown as { request: (...args: any[]) => unknown }, original = internals.request.bind(server);
    internals.request = (...args) => {
      const result = original(...args);
      if (args[2] === "control.list" && hold) { hold = false; return Promise.resolve(result).then(snapshot => new Promise(resolve => { release = () => resolve(snapshot); })); }
      return result;
    };
    hold = true; const oldList = page.store.refreshControl(); await until(() => !!release);
    const launch = page.store.launch({ machineId, harness: "omp", name: "new-agent", repository: "https://example.org/repo.git" });
    await until(() => page.store.snapshot().view.kind === "agent");
    assert.ok(page.store.snapshot().control.agents.some(value => value.name === "new-agent"));
    release!(); await oldList; await launch;
    assert.equal(page.store.snapshot().error, ""); assert.equal(page.store.snapshot().control.agents[0]?.identityId, runner.identity.id);
    await runner.close(); await until(() => page.store.snapshot().control.agents[0]?.online === false);
    await page.store.action(agent!.id, "dispose");
    assert.equal(page.store.snapshot().control.agents.length, 0); assert.equal(page.store.snapshot().view.kind, "home"); assert.deepEqual(errors, []);
  } finally { release?.(); page.close(); await runner.close(); await worker.close(); await server.close(); }
});

test("duplicate-name mentions reach all matches while ID-qualified mentions select one", () => {
  assert.equal(mentionsUsername("@admin hello", "admin", "agent-first"), true);
  assert.equal(mentionsUsername("@ADMIN hello", "admin", "agent-second"), true);
  assert.equal(mentionsUsername("@admin#first hello", "admin", "agent-first"), true);
  assert.equal(mentionsUsername("@admin#first hello", "admin", "agent-second"), false);
  assert.equal(mentionsUsername("@administrator hello", "admin", "agent-first"), false);
});
