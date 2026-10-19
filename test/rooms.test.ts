import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { connect as connectTcp } from "node:net";
import WebSocket from "ws";
import { RoomServer } from "../src/room-server.js";
import { RoomClient } from "../src/room-client.js";
import { AgentKeys, loginProof, messageProof, parsePassword, verifyMessage, validPresence, type PresenceEvent, type SignedMessage } from "../src/room-protocol.js";
import { RoomSession } from "../src/room-session.js";
import { RoomRegistry, callerKey } from "../src/room-registry.js";
import type { DeliveryAdapter } from "../src/adapters/codex.js";
import type { Delivery } from "../src/protocol.js";

async function until(check: () => boolean | Promise<boolean>): Promise<void> {
  const end = Date.now() + 4000;
  while (!(await check())) { if (Date.now() > end) throw new Error("Condition timed out."); await new Promise((resolve) => setTimeout(resolve, 10)); }
}
async function fixture(options: { graceMs?: number } = {}) {
  const server = await RoomServer.start({ host: "127.0.0.1", port: 0, graceMs: 100, ...options });
  const profile = { server: `127.0.0.1:${server.port}`, password: server.password };
  const clients: RoomClient[] = [];
  return { server, profile, clients,
    async client(name?: string, reconnectMs?: number) { const client = new RoomClient(profile, name, { reconnectMs }); clients.push(client); await client.connect(); return client; },
    async close() { await Promise.all(clients.map((client) => client.close())); await server.close(); },
  };
}
test("real TLS push: three agents, broadcasts exclude sender, different rooms isolated; no inbox polling", async () => {
  const f = await fixture();
  try {
    const a = await f.client("alice"); const b = await f.client("bob"); const c = await f.client("charlie");
    const received = [[], [], []] as SignedMessage[][];
    [a, b, c].forEach((client, index) => client.onMessage((message) => received[index]!.push(message)));
    const methods: string[] = []; const request = b.request.bind(b);
    b.request = async (method, params) => { methods.push(method); return request(method, params) as never; };
    const room = await a.createRoom("task-one"); await b.joinRoom(room.id); await c.createRoom("task-two");
    await a.send("Explicit tool message");
    await until(() => received[1]!.length === 1);
    assert.deepEqual(received.map((messages) => messages.length), [0, 1, 0]);
    assert.equal(received[1]![0]!.text, "Explicit tool message");
    assert.equal(verifyMessage(received[1]![0]), true);
    assert.equal(methods.includes("history"), false);
    await c.joinRoom(room.name); await b.send("Now everyone else");
    await until(() => received[0]!.length === 1 && received[2]!.length === 1);
    assert.deepEqual(received.map((messages) => messages.length), [1, 1, 1]);
    assert.equal((await a.listRooms()).length, 1, "switching leaves and deletes the formerly sole-member room");
  } finally { await f.close(); }
});
test("history bounded to latest 50; join and history reads never push past messages", async () => {
  const f = await fixture();
  try {
    const a = await f.client(); const b = await f.client(); const room = await a.createRoom("history");
    for (let index = 0; index < 60; index++) await a.send(`message-${index}`);
    const pushed: SignedMessage[] = []; b.onMessage((message) => pushed.push(message)); await b.joinRoom(room.id);
    const history = await b.history();
    assert.equal(history.length, 50); assert.equal(history[0]!.text, "message-10"); assert.equal(history.at(-1)!.text, "message-59");
    assert.equal(pushed.length, 0); assert.equal((await b.history(2)).length, 2);
    await assert.rejects(b.history(51), /1-50/);
  } finally { await f.close(); }
});
test("graceful last departure deletes room and history; failed join keeps previous membership", async () => {
  const f = await fixture();
  try {
    const a = await f.client(); const b = await f.client(); const room = await a.createRoom("temporary"); await a.send("ephemeral");
    await assert.rejects(a.joinRoom("missing"), /does not exist/);
    assert.equal(a.room!.id, room.id); assert.equal((await a.history()).length, 1);
    await a.leaveRoom(); assert.deepEqual(await b.listRooms(), []);
    await assert.rejects(b.joinRoom(room.id), /does not exist/);
    const fresh = await a.createRoom("temporary"); assert.notEqual(fresh.id, room.id); assert.deepEqual(await a.history(), []);
  } finally { await f.close(); }
});
test("reconnect retains private-key identity and membership during grace without replaying history", async () => {
  const f = await fixture({ graceMs: 2000 });
  try {
    const a = await f.client("reconnector", 20); const b = await f.client(); const room = await a.createRoom("reconnect"); await b.joinRoom(room.id);
    const id = a.identity.id; const messages: SignedMessage[] = []; a.onMessage((message) => messages.push(message));
    a.dropConnection(); await until(() => a.state === "reconnecting"); await until(() => a.state === "on");
    assert.equal(a.identity.id, id); assert.equal(a.room!.id, room.id); assert.equal((await b.members()).length, 2);
    await b.send("live after reconnect"); await until(() => messages.length === 1);
  } finally { await f.close(); }
});
test("crashed last member is reaped and its room disappears after disconnect grace", async () => {
  const f = await fixture({ graceMs: 30 });
  try {
    const a = await f.client("crashed", 100_000); const observer = await f.client(); await a.createRoom("crash");
    a.dropConnection(); await until(async () => (await observer.listRooms()).length === 0);
  } finally { await f.close(); }
});
test("a fresh process/session gets a fresh ID; names cannot claim an existing registered agent", async () => {
  const f = await fixture();
  try {
    const a = await f.client("reviewer"); const b = new RoomClient(f.profile, "REVIEWER"); f.clients.push(b);
    await assert.rejects(b.connect(), /already registered/);
    const c = await f.client("other"); assert.notEqual(a.identity.id, c.identity.id);
    await a.close(); const restarted = await f.client("reviewer"); assert.notEqual(a.identity.id, restarted.identity.id);
  } finally { await f.close(); }
});
test("signed text cannot be changed, sender forged, or replayed into a different room", async () => {
  const f = await fixture();
  try {
    const a = await f.client("alice"); const b = await f.client("attacker"); const room = await a.createRoom("signed"); await b.joinRoom(room.id);
    await a.send("Original"); const message = (await b.history())[0]!;
    assert.equal(verifyMessage({ ...message, text: "Forged" }), false);
    assert.equal(verifyMessage({ ...message, sender: { ...message.sender, id: b.identity.id } }), false);
    await assert.rejects(b.request("send", { id: randomUUID(), text: message.text, signature: message.signature }), /signature/);
    await assert.rejects(b.request("send", { id: message.id, text: message.text, signature: message.signature, sender: a.identity }), /Unexpected field/);
    const own = { id: randomUUID(), roomId: room.id, sender: b.identity, text: "Signed for old room" };
    const signature = b.keys.sign(messageProof(own)); await b.createRoom("other room");
    await assert.rejects(b.request("send", { id: own.id, text: own.text, signature }), /signature/);
    assert.deepEqual(await b.history(), []);
  } finally { await f.close(); }
});
test("wrong secret fails authentication, wrong certificate pin fails before authentication", async () => {
  const f = await fixture();
  try {
    const wrongSecret = new RoomClient({ ...f.profile, password: `sb1.${parsePassword(f.profile.password).fingerprint}.${"x".repeat(43)}` }); f.clients.push(wrongSecret);
    await assert.rejects(wrongSecret.connect(), /Password or identity proof/);
    const wrongPin = new RoomClient({ ...f.profile, password: `sb1.${"x".repeat(43)}.${parsePassword(f.profile.password).secret}` }); f.clients.push(wrongPin);
    await assert.rejects(wrongPin.connect(), /certificate/);
    assert.throws(() => new RoomClient({ ...f.profile, server: "ws://127.0.0.1:123" }), /IP:port/);
  } finally { await f.close(); }
});
async function rawPeer(endpoint: string) {
  const socket = new WebSocket(`wss://${endpoint}/ws`, { rejectUnauthorized: false }); socket.on("error", () => {});
  await new Promise<void>((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
  return { socket, request(method: string, params: object) {
    return new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Raw test peer timeout")), 2000);
      socket.once("message", (raw) => { clearTimeout(timer); resolve(JSON.parse(raw.toString())); });
      socket.send(JSON.stringify({ v: 1, id: randomUUID(), method, params }));
    });
  } };
}
test("knowing the shared password and somebody else's public key is insufficient; login proofs cannot replay", async () => {
  const f = await fixture(); const peers: Awaited<ReturnType<typeof rawPeer>>[] = [];
  try {
    const alice = new AgentKeys("alice"); const attacker = new AgentKeys("attacker");
    const { fingerprint, secret } = parsePassword(f.profile.password);
    const first = await rawPeer(f.profile.server); peers.push(first);
    const challenge1 = (await first.request("hello", { publicKey: alice.identity.publicKey, name: "alice" })).result.challenge;
    const forged = await first.request("authenticate", { secret, signature: attacker.sign(loginProof(challenge1, fingerprint, alice.identity)) });
    assert.equal(forged.error.code, "AUTH_FAILED");
    const second = await rawPeer(f.profile.server); peers.push(second);
    await second.request("hello", { publicKey: alice.identity.publicKey, name: "alice" });
    const replay = await second.request("authenticate", { secret, signature: alice.sign(loginProof(challenge1, fingerprint, alice.identity)) });
    assert.equal(replay.error.code, "AUTH_FAILED");
    const healthy = await f.client("alice"); assert.equal(healthy.state, "on", "failed attacks did not reserve the victim's name");
  } finally { peers.forEach((peer) => peer.socket.terminate()); await f.close(); }
});
test("in-memory server instances without a credentials file are isolated", async () => {
  const first = await fixture(); const oldPassword = first.server.password;
  const a = await first.client(); await a.createRoom("old"); await first.close();
  const next = await fixture();
  try { assert.notEqual(next.server.password, oldPassword); assert.deepEqual(await (await next.client()).listRooms(), []); }
  finally { await next.close(); }
});
test("server shutdown closes incomplete TLS handshakes as well as authenticated sockets", { timeout: 3000 }, async () => {
  const server = await RoomServer.start({ host: "127.0.0.1", port: 0 });
  const socket = connectTcp(server.port, "127.0.0.1"); socket.on("error", () => {});
  await new Promise<void>((resolve) => socket.once("connect", resolve));
  const closed = new Promise<void>((resolve) => socket.once("close", resolve));
  try { await server.close(); await closed; assert.equal(socket.destroyed, true); }
  finally { socket.destroy(); }
});
test("pushed verified messages reach delivery adapter without an agent fetch; preflight fails before connecting", async () => {
  const f = await fixture(); const deliveries: Delivery[] = [];
  const adapter: DeliveryAdapter = { prepare: async () => {}, deliver: async (message) => { deliveries.push(message); }, close: async () => {} };
  const session = new RoomSession(f.profile, adapter, "receiver");
  try {
    await session.enable(); const a = await f.client(); const room = await a.createRoom("harness"); await session.client.joinRoom(room.id);
    await a.send("Push into context"); await until(() => deliveries.length === 1); await session.drain();
    assert.equal(deliveries[0]!.verified, true); assert.equal(deliveries[0]!.sender.id, a.identity.id);
    const failing = new RoomSession({ ...f.profile, server: "127.0.0.1:1" }, { ...adapter, prepare: async () => { throw new Error("No live harness"); } });
    await assert.rejects(failing.enable(), /No live harness/);
  } finally { await session.disable(); await f.close(); }
});
test("MCP registry binds host-supplied caller only and keeps subagents off", async () => {
  assert.throws(() => callerKey("codex"), /threadId/);
  assert.equal(callerKey("codex", { threadId: "actual" }), "actual");
  const f = await fixture();
  const adapter: DeliveryAdapter = { prepare: async () => {}, deliver: async () => {}, close: async () => {} };
  const registry = new RoomRegistry(async (_key, profile, name) => new RoomSession(profile, adapter, name));
  try {
    await registry.activate("main", f.profile, "main");
    assert.deepEqual(registry.status("subagent"), { state: "off" }); assert.throws(() => registry.get("subagent"), /off/);
    await assert.rejects(registry.activate("main", f.profile), /already/);
    await registry.deactivate("main"); assert.deepEqual(registry.status("main"), { state: "off" });
  } finally { await registry.close(); await f.close(); }
});

test("server presence is scoped to the room, excludes self, cannot be client-forged and is not message history", async () => {
  const f = await fixture({ graceMs: 1000 });
  try {
    const a = await f.client("observer"); const b = await f.client("visitor", 20); const c = await f.client("elsewhere");
    const events: PresenceEvent[][] = [[], [], []];
    [a, b, c].forEach((client, index) => client.onPresence(event => events[index]!.push(event)));
    const room = await a.createRoom("presence"); await c.createRoom("isolated");
    await b.joinRoom(room.id); await until(() => events[0]!.length === 1);
    assert.equal(events[0]![0]!.kind, "joined"); assert.equal(events[0]![0]!.participant.id, b.identity.id);
    assert.equal(validPresence(events[0]![0]), true);
    assert.equal(validPresence({ ...events[0]![0], participant: { ...b.identity, id: a.identity.id } }), false);
    assert.equal(events[1]!.length, 0); assert.equal(events[2]!.length, 0);
    await b.joinRoom(room.id); assert.equal(events[0]!.length, 1, "idempotent join is quiet");
    await assert.rejects(b.request("presence", { ...events[0]![0], kind: "left", participant: a.identity }), /Unknown method/);
    b.dropConnection(); await until(() => events[0]!.length === 3 && b.state === "on");
    assert.deepEqual(events[0]!.map(event => event.kind), ["joined", "disconnected", "reconnected"]);
    assert.equal(b.room!.id, room.id);
    await b.leaveRoom(); await until(() => events[0]!.length === 4);
    assert.equal(events[0]![3]!.kind, "left"); assert.deepEqual(await a.history(), []);
    assert.equal(events[1]!.length, 0); assert.equal(events[2]!.length, 0);
    await b.joinRoom(room.id); await until(() => events[0]!.length === 5);
    await b.createRoom("moved"); await until(() => events[0]!.length === 6);
    assert.equal(events[0]![5]!.kind, "left");
  } finally { await f.close(); }
});

test("disconnect expiry does not emit a duplicate departure, and graceful logout emits left", async () => {
  const f = await fixture({ graceMs: 30 });
  try {
    const a = await f.client(); const b = await f.client(undefined, 100_000);
    const room = await a.createRoom("expiry"); await b.joinRoom(room.id);
    const events: PresenceEvent[] = []; a.onPresence(event => events.push(event));
    b.dropConnection(); await until(async () => (await a.members()).length === 1);
    assert.deepEqual(events.map(event => event.kind), ["disconnected"]);
    const c = await f.client(); await c.joinRoom(room.id); await c.close();
    await until(() => events.length === 3);
    assert.deepEqual(events.map(event => event.kind), ["disconnected", "joined", "left"]);
  } finally { await f.close(); }
});

test("server presence reaches harness delivery as an event, not verified participant speech", async () => {
  const f = await fixture(); const deliveries: Delivery[] = [];
  const adapter: DeliveryAdapter = { prepare: async () => {}, deliver: async message => { deliveries.push(message); }, close: async () => {} };
  const session = new RoomSession(f.profile, adapter);
  try {
    await session.enable(); const room = await session.client.createRoom("presence-harness");
    const peer = await f.client("peer"); await peer.joinRoom(room.id); await peer.close();
    await until(() => deliveries.length === 2); await session.drain();
    assert.deepEqual(deliveries.map(delivery => delivery.presence), ["joined", "left"]);
    assert.ok(deliveries.every(delivery => delivery.verified === undefined && delivery.text === ""));
  } finally { await session.disable(); await f.close(); }
});
