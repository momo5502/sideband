import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { JSDOM } from "jsdom";
import WebSocket from "ws";
import { RoomServer } from "../src/room-server.js";
import { RoomClient } from "../src/room-client.js";
import { BrowserRoomClient } from "../src/browser-protocol.js";
import { BrowserWorkspace } from "../src/browser-workspace.js";
import type { ControlCommand, ManagedAgent } from "../src/orchestration-protocol.js";
import { until } from "./browser-fixture.js";

function workspace(server: RoomServer) {
  const origin = `http://127.0.0.1:${server.statusPort}`, dom = new JSDOM("", { url: `${origin}/chat`, pretendToBeVisual: true });
  const sockets = new Set<WebSocket>();
  const store = new BrowserWorkspace(dom.window as unknown as Window, (url, password, name, key) => new BrowserRoomClient(url, password, name, key,
    address => { const socket = new WebSocket(address, { origin }); sockets.add(socket); socket.once("close", () => sockets.delete(socket)); return socket as unknown as globalThis.WebSocket; }));
  return { store, sockets, close() { store.dispose(); dom.window.close(); } };
}
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
