import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import NodeWebSocket from "ws";
import { once } from "node:events";
import { parse } from "yaml";
import { RoomServer } from "../src/room-server.js";
import { RoomClient } from "../src/room-client.js";
import { BrowserRoomClient, browserVerify } from "../src/browser-protocol.js";
import { verifyMessage, MAX_TEXT_BYTES, type SignedMessage } from "../src/room-protocol.js";
import { Webhooks, webhookText, MAX_WEBHOOK_BYTES } from "../src/webhooks.js";

async function until(check: () => boolean) {
  const deadline = Date.now() + 4000;
  while (!check()) { if (Date.now() > deadline) throw new Error("Webhook push did not arrive."); await new Promise(resolve => setTimeout(resolve, 10)); }
}
function browser(server: RoomServer, key?: Uint8Array) {
  const origin = `http://127.0.0.1:${server.statusPort}`;
  return new BrowserRoomClient(origin.replace("http:", "ws:") + "/browser-ws", server.password, "human", key,
    url => new NodeWebSocket(url, { origin }) as unknown as WebSocket);
}
async function deliver(server: RoomServer, path: string, body: string | Buffer = '{"hello":"world"}', options: { tls?: boolean; method?: string; contentType?: string; chunked?: boolean } = {}) {
  return new Promise<{ code: number; body: string; headers: import("node:http").IncomingHttpHeaders }>((resolve, reject) => {
    const req = (options.tls ? httpsRequest : httpRequest)({ hostname: "127.0.0.1", port: options.tls ? server.port : server.statusPort, path,
      method: options.method ?? "POST", rejectUnauthorized: false, agent: false,
      headers: { "Content-Type": options.contentType ?? "application/json", ...(options.chunked ? {} : { "Content-Length": Buffer.byteLength(body) }) } }, res => {
      let response = ""; res.setEncoding("utf8"); res.on("data", chunk => response += chunk);
      res.once("end", () => resolve({ code: res.statusCode!, body: response, headers: res.headers })); res.once("error", reject);
    });
    req.once("error", reject); if (options.chunked) req.write(body); req.end(options.chunked ? undefined : body);
  });
}

test("webhook URLs are stateless, scoped to room/persona, and cannot expose or forge signing keys", () => {
  const hooks = new Webhooks(Buffer.alloc(32, 1));
  const path = hooks.create(" A room / with Unicode 日本語 ", "github").path;
  const url = new URL(path, "https://example.test");
  const target = hooks.authorize(url)!;
  assert.deepEqual(target, { room: "a room / with unicode 日本語", sender: "github" });
  assert.deepEqual(new Webhooks(Buffer.alloc(32, 1)).authorize(url), target);
  assert.equal(new Webhooks(Buffer.alloc(32, 2)).authorize(url), undefined);
  for (const key of ["room", "sender", "token"]) {
    const tampered = new URL(url); tampered.searchParams.set(key, tampered.searchParams.get(key)! + "x");
    assert.equal(hooks.authorize(tampered), undefined);
    const duplicate = new URL(url); duplicate.searchParams.append(key, url.searchParams.get(key)!);
    assert.equal(hooks.authorize(duplicate), undefined);
  }
  const extra = new URL(url); extra.searchParams.set("admin", "true"); assert.equal(hooks.authorize(extra), undefined);
  assert.throws(() => hooks.create("room", ""), /required/);
  assert.throws(() => hooks.create("room", "bad name"), /names use/);
  const message = hooks.message(target, "room-id", "payload");
  assert.equal(verifyMessage(message), true); assert.equal(browserVerify(message), true);
  assert.equal(verifyMessage({ ...message, sender: { ...message.sender, name: "forged" } }), false);
  assert.equal(verifyMessage({ ...message, roomId: "other" }), false);
  assert.equal(hooks.message(target, "room-id", "next").sender.id, message.sender.id);
  assert.notEqual(hooks.message({ ...target, sender: "other" }, "room-id", "next").sender.id, message.sender.id);
});

test("generic JSON becomes bounded, fenced YAML including arrays, multiline strings, hostile keys and delimiters", () => {
  const payload = JSON.parse('{"action":"opened","number":42,"body":"line one\\nline two","__proto__":{"polluted":true},"values":[true,null,"false"],"script":"<script>alert(1)</script>"}');
  const rendered = webhookText(payload);
  assert.match(rendered, /^```yaml\n/); assert.match(rendered, /action: opened/);
  assert.deepEqual(parse(rendered.slice(8, -4)), payload); assert.equal(({} as any).polluted, undefined);
  for (const value of [null, true, 123, "hello", [1, "two"], {}, { text: "```\n~~~\n```yaml\nmalicious" }]) {
    const rendered = webhookText(value), lines = rendered.split("\n"), fence = lines[0]!.slice(0, -4);
    assert.equal(lines.at(-1), fence); assert.deepEqual(parse(lines.slice(1, -1).join("\n")), value);
  }
  for (const text of ["🚀".repeat(10000), "`".repeat(5000) + "~".repeat(5000), "\n".repeat(20000)]) {
    const rendered = webhookText({ text }); assert.ok(Buffer.byteLength(rendered) <= MAX_TEXT_BYTES); assert.match(rendered, /truncated/); assert.ok(!rendered.includes("\uFFFD"));
  }
  let nested: unknown = {}; for (let i = 0; i < 40; i++) nested = { nested };
  assert.throws(() => webhookText(nested), /deeply/);
});

for (const tls of [false, true]) test(`webhook POST over ${tls ? "HTTPS" : "HTTP"} reaches native and browser clients as signed YAML, only in its room`, async () => {
  const server = await RoomServer.start({ host: "127.0.0.1", port: 0, statusPort: 0 });
  const web = browser(server), agent = new RoomClient({ server: `127.0.0.1:${server.port}`, password: server.password }, "agent");
  const other = new RoomClient({ server: `127.0.0.1:${server.port}`, password: server.password }, "other");
  try {
    await web.connect(); await web.join("Build Room"); await agent.connect(); await agent.joinRoom("build room"); await other.connect(); await other.joinRoom("unrelated");
    const events: SignedMessage[] = [], browserEvents: SignedMessage[] = [], otherEvents: SignedMessage[] = [];
    agent.onMessage(message => events.push(message)); web.onMessage = message => browserEvents.push(message); other.onMessage(message => otherEvents.push(message));
    const { path } = await web.request<{ path: string }>("webhook", { room: "Build Room", sender: "github" });
    const unauthenticated = new NodeWebSocket(`ws://127.0.0.1:${server.statusPort}/browser-ws`, { origin: `http://127.0.0.1:${server.statusPort}` });
    await once(unauthenticated, "open"); const denied = once(unauthenticated, "message");
    unauthenticated.send(JSON.stringify({ v: 1, id: "unauthenticated", method: "webhook", params: { room: "build room", sender: "github" } }));
    assert.equal(JSON.parse(String((await denied)[0])).error.code, "AUTH_REQUIRED"); unauthenticated.terminate();
    assert.equal((await agent.history()).length, 0, "minting never posts or changes membership");
    const payload = { sender: "cannot-override", room: "unrelated", action: "opened", number: 7 };
    const response = await deliver(server, path, JSON.stringify(payload), { tls }); assert.equal(response.code, 204); assert.equal(response.body, "");
    await until(() => events.length === 1 && browserEvents.length === 1);
    assert.equal(events[0]!.sender.name, "github"); assert.equal(verifyMessage(events[0]), true); assert.equal(browserVerify(browserEvents[0]!), true);
    assert.match(events[0]!.text, /action: opened/); assert.equal(otherEvents.length, 0);
    assert.deepEqual(await agent.history(), events); assert.deepEqual(await web.history(), events);
    assert.ok(!JSON.stringify(events).includes(new URL(path, "http://test").searchParams.get("token")!));
    await assert.rejects(web.request("webhook", { room: "build room", sender: "agent" }), /distinct/);
    for (const change of ["room", "sender", "token"]) {
      const url = new URL(path, "http://test"); url.searchParams.set(change, "forged"); assert.equal((await deliver(server, url.pathname + url.search)).code, 403);
    }
    assert.equal((await deliver(server, path, "", { method: "GET" })).code, 405);
    assert.equal((await deliver(server, path, "{}", { contentType: "application/x-www-form-urlencoded" })).code, 415);
    assert.equal((await deliver(server, path, "not JSON")).code, 400);
    assert.equal((await deliver(server, path, Buffer.from([0xff]))).code, 400);
    assert.equal((await deliver(server, path, "x".repeat(MAX_WEBHOOK_BYTES + 1))).code, 413);
    assert.equal((await deliver(server, path, "x".repeat(MAX_WEBHOOK_BYTES + 1), { chunked: true })).code, 413);
    assert.equal((await agent.history()).length, 1, "invalid requests never post");
    for (let i = 0; i < 52; i++) assert.equal((await deliver(server, path, JSON.stringify({ sequence: i }))).code, 204);
    const retained = await agent.history(); assert.equal(retained.length, 50); assert.match(retained[0]!.text, /sequence: 2/);
  } finally { web.disconnect(); await agent.close(); await other.close(); await server.close(); }
});

test("webhooks accept and discard absent/empty rooms, survive restart, retain no tokens and expire on password rotation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sideband-webhook-")), credentialsFile = join(directory, "server.json");
  let server = await RoomServer.start({ host: "127.0.0.1", port: 0, statusPort: 0, credentialsFile });
  const key = crypto.getRandomValues(new Uint8Array(32)); let web = browser(server, key);
  try {
    await web.connect(); const { path } = await web.request<{ path: string }>("webhook", { room: "future", sender: "ci" });
    const before = await readFile(credentialsFile, "utf8");
    assert.equal((await deliver(server, path)).code, 204); assert.deepEqual(await web.rooms(), []);
    await web.join("future"); assert.deepEqual(await web.history(), []);
    await web.leave(); assert.equal((await deliver(server, path)).code, 204); assert.deepEqual(await web.rooms(), []);
    web.disconnect(); await server.close();
    server = await RoomServer.start({ host: "127.0.0.1", port: 0, statusPort: 0, credentialsFile }); web = browser(server, key);
    await web.connect(); await web.join("future"); assert.equal((await deliver(server, path)).code, 204);
    assert.equal((await web.history())[0]!.sender.name, "ci");
    assert.equal(await readFile(credentialsFile, "utf8"), before); assert.deepEqual(await readdir(directory), ["server.json"]);
    // During the reconnect grace period there can still be a room, but no live participants.
    (web as unknown as { socket: NodeWebSocket }).socket.terminate();
    await until(() => (server as any).publicStatus().connectedParticipants === 0);
    assert.equal((await deliver(server, path)).code, 204);
    web = browser(server, key); await web.connect(); assert.equal((await web.history()).length, 1, "empty-room delivery was discarded during reconnect grace"); web.disconnect();
    await server.close(); server = await RoomServer.start({ host: "127.0.0.1", port: 0, statusPort: 0, credentialsFile, rotatePassword: true });
    assert.equal((await deliver(server, path)).code, 403);
  } finally { web.disconnect(); await server.close(); await rm(directory, { recursive: true, force: true }); }
});
