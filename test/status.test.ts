import test from "node:test";
import assert from "node:assert/strict";
import { request } from "node:https";
import { request as httpRequest } from "node:http";
import { connect } from "node:net";
import { once } from "node:events";
import WebSocket from "ws";
import { RoomServer } from "../src/room-server.js";
import { RoomClient } from "../src/room-client.js";

function get(server: RoomServer, path = "/", method = "GET", tls = true) {
  return new Promise<{ status: number; headers: import("node:http").IncomingHttpHeaders; body: string }>((resolve, reject) => {
    // Isolated loopback fixture with an ephemeral self-signed certificate, not a real server.
    const req = (tls ? request : httpRequest)({ hostname: "127.0.0.1", port: tls ? server.port : server.statusPort, path, method, rejectUnauthorized: false, agent: false }, res => {
      let body = ""; res.setEncoding("utf8"); res.on("data", chunk => { body += chunk; });
      res.once("end", () => resolve({ status: res.statusCode!, headers: res.headers, body }));
    });
    req.setTimeout(4000, () => req.destroy(new Error("Status request timed out.")));
    req.once("error", reject); req.end();
  });
}
async function status(server: RoomServer) { const response = await get(server, "/status.json"); assert.equal(response.status, 200); return JSON.parse(response.body); }
async function until(check: () => Promise<boolean>) {
  const deadline = Date.now() + 4000;
  while (!(await check())) { if (Date.now() > deadline) throw new Error("Status counts did not update."); await new Promise(resolve => setTimeout(resolve, 10)); }
}

test("public status has only room/connected-participant aggregates, never names, messages or credentials", async () => {
  const server = await RoomServer.start({ host: "127.0.0.1", port: 0, statusPort: 0 });
  const profile = { server: `127.0.0.1:${server.port}`, password: server.password };
  const alice = new RoomClient(profile, "private-agent-name"); const bob = new RoomClient(profile, "private-human-name");
  let unauthenticated: WebSocket | undefined;
  try {
    assert.deepEqual(await status(server), { rooms: 0, connectedParticipants: 0 });
    unauthenticated = new WebSocket(`wss://${profile.server}/ws`, { rejectUnauthorized: false }); unauthenticated.on("error", () => {});
    await new Promise<void>(resolve => unauthenticated!.once("open", resolve));
    assert.deepEqual(await status(server), { rooms: 0, connectedParticipants: 0 });
    await alice.connect(); const room = await alice.joinRoom("private-room-<script>name</script>");
    await alice.send("private-message-contents"); await bob.connect();
    assert.deepEqual(await status(server), { rooms: 1, connectedParticipants: 2 }, "connected clients outside a room still count");
    const page = await get(server); const json = await get(server, "/status.json?password=do-not-reflect-this");
    assert.equal(page.status, 200); assert.match(page.headers["content-type"]!, /text\/html/);
    assert.match(page.body, /Sideband/); assert.match(page.body, /Rooms/); assert.match(page.body, /Connected participants/);
    assert.match(page.body, /http-equiv="refresh" content="10"/);
    const plainPage = await get(server, "/", "GET", false); const plainJson = await get(server, "/status.json", "GET", false);
    assert.equal(plainPage.status, 200); assert.equal(plainPage.body, page.body); assert.equal(plainJson.body, json.body);
    for (const secret of [server.password, "private-agent-name", "private-human-name", room.name, room.id, alice.identity.id, alice.identity.publicKey,
      "private-message-contents", "do-not-reflect-this"]) {
      assert.ok(!page.body.includes(secret) && !json.body.includes(secret));
    }
    for (const response of [page, json, plainPage, plainJson]) {
      assert.equal(response.headers["cache-control"], "no-store"); assert.equal(response.headers["x-content-type-options"], "nosniff");
      assert.match(String(response.headers["content-security-policy"]), /default-src 'none'/);
      assert.equal(response.headers["referrer-policy"], "no-referrer"); assert.equal(response.headers["set-cookie"], undefined);
    }
    assert.deepEqual(Object.keys(JSON.parse(json.body)).sort(), ["connectedParticipants", "rooms"]);
  } finally { unauthenticated?.terminate(); await alice.close(); await bob.close(); await server.close(); }
});

test("counts track room switching, logout and disconnected clients during reconnect grace", async () => {
  const server = await RoomServer.start({ host: "127.0.0.1", port: 0, graceMs: 5000 });
  const profile = { server: `127.0.0.1:${server.port}`, password: server.password };
  const alice = new RoomClient(profile); const bob = new RoomClient(profile, undefined, { reconnectMs: 100_000 });
  try {
    await alice.connect(); const room = await alice.joinRoom("first"); await bob.connect(); await bob.joinRoom("second");
    assert.deepEqual(await status(server), { rooms: 2, connectedParticipants: 2 });
    await bob.joinRoom(room.id); assert.deepEqual(await status(server), { rooms: 1, connectedParticipants: 2 });
    bob.dropConnection(); await until(async () => (await status(server)).connectedParticipants === 1);
    assert.deepEqual(await status(server), { rooms: 1, connectedParticipants: 1 });
    await alice.close(); assert.deepEqual(await status(server), { rooms: 1, connectedParticipants: 0 }, "a room can survive briefly during reconnect grace");
  } finally { await alice.close(); await bob.close(); await server.close(); }
});

test("HEAD, method restrictions and unknown paths expose no additional information", async () => {
  const server = await RoomServer.start({ host: "127.0.0.1", port: 0, statusPort: 0 });
  try {
    for (const tls of [true, false]) {
      for (const path of ["/", "/status.json"]) {
        const normal = await get(server, path, "GET", tls); const head = await get(server, path, "HEAD", tls);
        assert.equal(head.status, 200); assert.equal(head.body, ""); assert.equal(Number(head.headers["content-length"]), Buffer.byteLength(normal.body));
        const post = await get(server, path, "POST", tls); assert.equal(post.status, 405); assert.equal(post.headers.allow, "GET, HEAD");
      }
      for (const path of ["/server-credentials.json", "/rooms", "/messages", "/%2e%2e/server-credentials.json", "/ws"]) {
        const response = await get(server, path, "GET", tls); assert.equal(response.status, 404); assert.equal(response.body, "Not found.\n");
      }
    }
    const browser = new WebSocket(`wss://127.0.0.1:${server.port}/ws`, { rejectUnauthorized: false, origin: `https://127.0.0.1:${server.port}` });
    try { await assert.rejects(new Promise<void>((resolve, reject) => { browser.once("open", resolve); browser.once("error", reject); }), /403/); }
    finally { browser.terminate(); }
  } finally { await server.close(); }
});

test("plain HTTP rejects agent WebSocket upgrades and shutdown closes unfinished status requests", { timeout: 5000 }, async () => {
  const server = await RoomServer.start({ host: "127.0.0.1", port: 0, statusPort: 0 });
  const plaintext = new WebSocket(`ws://127.0.0.1:${server.statusPort}/ws`);
  const idle = connect(server.statusPort!, "127.0.0.1"); idle.on("error", () => {});
  try {
    await assert.rejects(new Promise<void>((resolve, reject) => { plaintext.once("open", resolve); plaintext.once("error", reject); }), /403/);
    assert.deepEqual(await status(server), { rooms: 0, connectedParticipants: 0 });
    if (idle.connecting) await once(idle, "connect");
    idle.write("GET / HTTP/1.1\r\nHost: localhost\r\n");
    // A forced server shutdown may reset an unfinished request on Windows; close is the invariant.
    const closed = new Promise<void>(resolve => idle.once("close", () => resolve())); await server.close(); await closed;
    assert.equal(idle.destroyed, true);
  } finally { plaintext.terminate(); idle.destroy(); await server.close(); }
});
