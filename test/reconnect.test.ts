import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomServer } from "../src/room-server.js";
import { RoomClient } from "../src/room-client.js";
import { RoomSession } from "../src/room-session.js";
import type { Delivery } from "../src/protocol.js";
import type { Room, SignedMessage } from "../src/room-protocol.js";

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check: () => boolean | Promise<boolean>) {
  const end = Date.now() + 5000;
  while (!(await check())) { if (Date.now() > end) throw new Error("Reconnect condition timed out."); await pause(10); }
}
async function fixture(graceMs = 25, reconnectMs = 180) {
  const server = await RoomServer.start({ host: "127.0.0.1", port: 0, graceMs });
  const profile = { server: `127.0.0.1:${server.port}`, password: server.password };
  const client = new RoomClient(profile, "returning-agent", { reconnectMs });
  const peer = new RoomClient(profile, "peer");
  await client.connect(); await peer.connect();
  return { server, profile, client, peer, async close() { await client.close(); await peer.close(); await server.close(); } };
}
test("expired membership rejoins the same room and identity, without polling, history replay or automatic sends", async () => {
  const f = await fixture();
  try {
    const room = await f.client.createRoom("long-disconnect"); await f.peer.joinRoom(room.id);
    const identity = f.client.identity.id; const arrived: SignedMessage[] = []; f.client.onMessage(message => arrived.push(message));
    const methods: string[] = []; const request = f.client.request.bind(f.client);
    f.client.request = async (method, params) => { methods.push(method); return request(method, params) as never; };
    f.client.dropConnection(); await until(async () => (await f.peer.members()).length === 1);
    await f.peer.send("While the agent was offline");
    await until(() => f.client.state === "on" && f.client.room?.id === room.id);
    assert.equal(f.client.identity.id, identity); assert.equal(arrived.length, 0);
    assert.equal(f.client.lastError, undefined);
    assert.ok(methods.includes("join")); assert.ok(!methods.includes("history") && !methods.includes("send"));
    await f.peer.send("Live after return"); await until(() => arrived.length === 1);
    assert.equal(arrived[0]!.text, "Live after return");
    assert.equal((await f.peer.history()).length, 2, "restoring a room sends no chat announcements");
  } finally { await f.close(); }
});
test("an empty deleted room is recreated by name; a failed manual join does not change the remembered room", async () => {
  const f = await fixture();
  try {
    const old = await f.client.createRoom("recreated"); await f.client.send("Old ephemeral history");
    await assert.rejects(f.client.joinRoom("does-not-exist"), /does not exist/);
    f.client.dropConnection(); await until(async () => (await f.peer.listRooms()).length === 0);
    await until(() => f.client.state === "on" && !!f.client.room && f.client.room.id !== old.id);
    assert.equal(f.client.room!.name, old.name); assert.deepEqual(await f.client.history(), []);
    assert.equal((await f.peer.listRooms()).length, 1);
    await f.peer.joinRoom(f.client.room!.id); await f.client.send("Explicit after recovery");
    assert.equal((await f.peer.history())[0]!.text, "Explicit after recovery");
  } finally { await f.close(); }
});
test("room restoration joins a replacement with the same name and handles concurrent recreation", async () => {
  for (const race of [false, true]) {
    const f = await fixture();
    try {
      const old = await f.client.createRoom("shared-room"); const request = f.client.request.bind(f.client);
      let replacement: Room | undefined;
      if (race) f.client.request = async (method, params) => {
        if (method === "create" && !replacement) replacement = await f.peer.createRoom(old.name);
        return request(method, params) as never;
      };
      f.client.dropConnection(); await until(async () => (await f.peer.listRooms()).length === 0);
      if (!race) replacement = await f.peer.createRoom(old.name);
      await until(() => f.client.state === "on" && !!replacement && f.client.room?.id === replacement.id);
      assert.notEqual(f.client.room!.id, old.id); assert.equal((await f.peer.members()).length, 2);
      assert.equal((await f.peer.listRooms()).length, 1); assert.equal(f.client.lastError, undefined);
    } finally { await f.close(); }
  }
});
test("a drop during automatic rejoin retries rather than becoming stuck or reporting a false connected state", async () => {
  const f = await fixture();
  try {
    const room = await f.client.createRoom("retry-restore"); await f.peer.joinRoom(room.id);
    const request = f.client.request.bind(f.client); let interrupted = false; let logins = 0;
    f.client.request = async (method, params) => {
      if (method === "hello") logins++;
      if (method === "join" && !interrupted) { interrupted = true; assert.equal(f.client.state, "reconnecting"); f.client.dropConnection(); }
      return request(method, params) as never;
    };
    f.client.dropConnection(); await until(() => interrupted && f.client.state === "on" && f.client.room?.id === room.id);
    assert.equal(logins, 2); assert.equal(f.client.lastError, undefined);
    await f.client.send("Still usable"); assert.equal((await f.peer.history()).length, 1);
  } finally { await f.close(); }
});
test("explicit leave is remembered even if its request failed before reaching the server", async () => {
  const f = await fixture(2000, 20);
  try {
    const room = await f.client.createRoom("do-not-rejoin"); await f.peer.joinRoom(room.id);
    const request = f.client.request.bind(f.client); let failed = false;
    f.client.request = async (method, params) => {
      if (method === "leave" && !failed) { failed = true; throw new Error("Simulated lost leave request"); }
      return request(method, params) as never;
    };
    await assert.rejects(f.client.leaveRoom(), /lost leave/);
    f.client.dropConnection(); await until(() => f.client.state === "reconnecting");
    await until(() => f.client.state === "on"); assert.equal(f.client.room, null);
    assert.equal((await f.peer.members()).length, 1);
    await f.client.joinRoom(room.id); f.client.dropConnection();
    await until(() => f.client.state === "reconnecting"); await until(() => f.client.state === "on");
    assert.equal((f.client.room as Room | null)?.id, room.id, "a new explicit join replaces the leave intent");
  } finally { await f.close(); }
});
test("the existing harness delivery session continues receiving push after automatic room restoration", async () => {
  const f = await fixture(); const deliveries: Delivery[] = []; let prepared = 0;
  const session = new RoomSession(f.profile, { prepare: async () => { prepared++; }, deliver: async delivery => { deliveries.push(delivery); }, close: async () => {} }, "harness-receiver");
  try {
    await session.enable(); const room = await f.peer.createRoom("same-harness"); await session.client.joinRoom(room.id);
    const identity = session.client.identity.id;
    session.client.dropConnection(); await until(async () => (await f.peer.members()).length === 1);
    await until(() => session.client.state === "on" && session.client.room?.id === room.id);
    await f.peer.send("Push after waking up"); await until(() => deliveries.some(delivery => delivery.text === "Push after waking up")); await session.drain();
    assert.equal(prepared, 1, "recovery must not replace or rebind the harness session");
    assert.equal(session.client.identity.id, identity); assert.equal((await f.peer.history()).length, 1);
  } finally { await session.disable(); await f.close(); }
});
test("disabling during restoration cancels stale completion and all future reconnect attempts", async () => {
  const f = await fixture(); let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let restoring = false; let hellos = 0;
  try {
    const room = await f.client.createRoom("cancel-restore"); await f.peer.joinRoom(room.id);
    const request = f.client.request.bind(f.client);
    f.client.request = async (method, params) => {
      if (method === "hello") hellos++;
      const result = await request(method, params);
      if (method === "join") { restoring = true; await gate; }
      return result as never;
    };
    f.client.dropConnection(); await until(() => restoring);
    await f.client.close(); release(); await pause(250);
    assert.equal(f.client.state, "off"); assert.equal(f.client.room, null); assert.equal(hellos, 1);
  } finally { release(); await f.close(); }
});
test("leave during in-flight restoration stays connected without rejoining the room", async () => {
  const f = await fixture(); let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }); let restoring = false;
  try {
    const room = await f.client.createRoom("cancel-room-only"); await f.peer.joinRoom(room.id);
    const request = f.client.request.bind(f.client);
    f.client.request = async (method, params) => {
      const result = await request(method, params);
      if (method === "join") { restoring = true; await gate; }
      return result as never;
    };
    f.client.dropConnection(); await until(() => restoring);
    await f.client.leaveRoom(); assert.equal(f.client.room, null); release();
    await until(() => f.client.state === "on"); assert.equal(f.client.room, null);
    assert.equal((await f.peer.members()).length, 1);
  } finally { release(); await f.close(); }
});
test("a stale open socket with no heartbeat is replaced automatically, as after a silent network/sleep interruption", async () => {
  const server = await RoomServer.start({ host: "127.0.0.1", port: 0, heartbeatMs: 100_000 });
  const client = new RoomClient({ server: `127.0.0.1:${server.port}`, password: server.password }, "watchdog",
    { heartbeatTimeoutMs: 500, reconnectMs: 10 });
  let hellos = 0; const request = client.request.bind(client);
  client.request = async (method, params) => { if (method === "hello") hellos++; return request(method, params) as never; };
  try {
    await client.connect(); const room = await client.createRoom("silent-socket"); const id = client.identity.id;
    await until(() => hellos >= 2 && client.state === "on");
    assert.equal(client.room?.id, room.id); assert.equal(client.identity.id, id);
  } finally { await client.close(); await server.close(); }
});
test("a conflicting name after expiry stops recovery without impersonating, renaming, or claiming another identity", async () => {
  const f = await fixture(); const holder = new RoomClient(f.profile, "returning-agent");
  try {
    await f.client.createRoom("name-conflict"); f.client.dropConnection();
    await until(async () => (await f.peer.listRooms()).length === 0); await holder.connect();
    await until(() => f.client.state === "disconnected");
    assert.match(f.client.lastError!, /already registered/); assert.notEqual(f.client.identity.id, holder.identity.id);
    assert.equal(f.client.room, null);
  } finally { await holder.close(); await f.close(); }
});
test("server downtime retries; persistent-credential restart recreates the room but certificate rotation fails closed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sideband-reconnect-"));
  const credentialsFile = join(directory, "server-credentials.json");
  let server = await RoomServer.start({ host: "127.0.0.1", port: 0, credentialsFile });
  const port = server.port;
  const client = new RoomClient({ server: `127.0.0.1:${port}`, password: server.password }, "survivor", { reconnectMs: 30 });
  try {
    await client.connect(); const room = await client.createRoom("after-restart"); const id = client.identity.id;
    await client.send("Not resent"); await server.close();
    await until(() => client.state === "reconnecting" && !!client.lastError);
    server = await RoomServer.start({ host: "127.0.0.1", port, credentialsFile });
    await until(() => client.state === "on" && !!client.room && client.room.id !== room.id);
    assert.equal(client.room!.name, room.name); assert.equal(client.identity.id, id);
    assert.equal(client.lastError, undefined); assert.deepEqual(await client.history(), []);
    await server.close(); server = await RoomServer.start({ host: "127.0.0.1", port, credentialsFile, rotatePassword: true });
    await until(() => client.state === "disconnected"); assert.match(client.lastError!, /certificate/);
  } finally {
    await client.close(); await server.close();
    assert.ok(directory.startsWith(join(tmpdir(), "sideband-reconnect-"))); await rm(directory, { recursive: true, force: true });
  }
});
