import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { connect } from "node:net";
import type { Duplex } from "node:stream";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generate } from "selfsigned";
import { WebSocketServer } from "ws";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { NotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { roomProxyUrl } from "../src/room-proxy.js";
import { RoomClient } from "../src/room-client.js";
import { RoomServer } from "../src/room-server.js";
import { RoomProfiles } from "../src/room-profiles.js";
import { loginAndSave } from "../src/terminal-login.js";
import { CodexRpc } from "../src/rpc.js";

async function until(check: () => boolean): Promise<void> {
  const end = Date.now() + 4000;
  while (!check()) { if (Date.now() > end) throw new Error("Proxy condition timed out."); await new Promise(resolve => setTimeout(resolve, 10)); }
}

const proxyNames = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy"];
async function withEnv<T>(env: NodeJS.ProcessEnv, action: () => Promise<T>): Promise<T> {
  const saved = Object.fromEntries(proxyNames.map(name => [name, process.env[name]]));
  for (const name of proxyNames) delete process.env[name];
  Object.assign(process.env, env);
  try { return await action(); }
  finally { for (const name of proxyNames) { if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name]; } }
}

/** A real CONNECT proxy. It deliberately resolves the destination on the proxy side. */
async function proxy(upstreamPort: number, options: { authorization?: string; status?: number; stall?: boolean; secure?: boolean } = {}) {
  const tls = options.secure ? await generate([{ name: "commonName", value: "127.0.0.1" }], {
    keyType: "ec", curve: "P-256", algorithm: "sha256", extensions: [{ name: "subjectAltName", altNames: [{ type: 7, ip: "127.0.0.1" }] }],
  }) : undefined;
  const server = tls ? createHttpsServer({ key: tls.private, cert: tls.cert }) : http.createServer();
  const sockets = new Set<Duplex>(); const requests: { target: string; authorization?: string }[] = [];
  const track = (socket: Duplex) => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); socket.on("error", () => {}); };
  server.on("connection", track);
  server.on("connect", (req, client, head) => {
    requests.push({ target: req.url ?? "", authorization: req.headers["proxy-authorization"] });
    client.once("end", () => client.destroy());
    if (options.stall) { client.resume(); return; }
    const status = options.authorization && req.headers["proxy-authorization"] !== options.authorization ? 407 : options.status;
    if (status) { client.end(`HTTP/1.1 ${status} Proxy refused\r\nContent-Length: 0\r\n\r\n`); return; }
    const upstream = connect({ host: "127.0.0.1", port: upstreamPort }); track(upstream);
    client.once("close", () => upstream.destroy()); upstream.once("close", () => client.destroy());
    upstream.once("error", () => client.destroy());
    upstream.once("connect", () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      client.pipe(upstream); upstream.pipe(client);
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  return { url: `${tls ? "https" : "http"}://127.0.0.1:${address.port}`, certificate: tls?.cert, requests, sockets,
    async close() { for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}

test("proxy selection honors lowercase, precedence, HTTP fallback and NO_PROXY hosts/ports/IPv6", () => {
  const url = "wss://room.example.com:8765/ws";
  assert.equal(roomProxyUrl(url, {}), undefined);
  assert.equal(roomProxyUrl(url, { HTTPS_PROXY: "http://secure:3128", HTTP_PROXY: "http://fallback:8080" })?.hostname, "secure");
  assert.equal(roomProxyUrl(url, { HTTPS_PROXY: "http://upper:3128", https_proxy: "http://lower:3128" })?.hostname, "lower");
  assert.equal(roomProxyUrl(url, { http_proxy: "fallback:8080" })?.href, "http://fallback:8080/");
  assert.equal(roomProxyUrl(url, { ALL_PROXY: "https://all:443" })?.protocol, "https:");
  for (const noProxy of ["*", "room.example.com", ".example.com", "*.example.com", "elsewhere, room.example.com:8765", "ROOM.EXAMPLE.COM"]) {
    assert.equal(roomProxyUrl(url, { HTTPS_PROXY: "http://proxy", NO_PROXY: noProxy }), undefined);
  }
  assert.equal(roomProxyUrl(url, { HTTPS_PROXY: "http://proxy", NO_PROXY: "room.example.com:443" })?.hostname, "proxy");
  assert.equal(roomProxyUrl("wss://badexample.com/ws", { HTTPS_PROXY: "http://proxy", NO_PROXY: ".example.com" })?.hostname, "proxy");
  assert.equal(roomProxyUrl("wss://room.example.com/ws", { HTTPS_PROXY: "http://proxy", NO_PROXY: "room.example.com:443" }), undefined);
  assert.equal(roomProxyUrl("wss://[::1]:8765/ws", { HTTPS_PROXY: "http://proxy", NO_PROXY: "[::1]:8765" }), undefined);
  assert.equal(roomProxyUrl("wss://[::1]/ws", { HTTPS_PROXY: "http://proxy", no_proxy: "::1", NO_PROXY: "different" }), undefined);
  for (const value of ["socks5://user:private@proxy:1080", "http://user:private@", "http://user:private@proxy/path", "http://user:%XX@proxy"]) {
    assert.throws(() => roomProxyUrl(url, { HTTPS_PROXY: value }), error => error instanceof Error && /proxy configuration/.test(error.message) && !error.message.includes("private"));
  }
});

test("signed TLS chat and reconnect use authenticated CONNECT, including proxy-side destination DNS", async () => {
  const server = await RoomServer.start({ host: "127.0.0.1", port: 0, graceMs: 2000 });
  const tunnel = await proxy(server.port, { authorization: `Basic ${Buffer.from("user:pass word").toString("base64")}` });
  const profile = { server: "not-resolvable.invalid:8765", password: server.password };
  const authenticated = tunnel.url.replace("://", "://user:pass%20word@");
  const alice = new RoomClient(profile, "alice", { proxyEnv: { HTTPS_PROXY: authenticated }, reconnectMs: 20 });
  const bob = new RoomClient({ ...profile, server: `127.0.0.1:${server.port}` }, "bob", { proxyEnv: {} });
  try {
    await alice.connect(); await bob.connect(); const room = await alice.joinRoom("proxy-chat"); await bob.joinRoom(room.id);
    const messages: string[] = []; bob.onMessage(message => messages.push(message.text));
    await alice.send("signed through proxy"); await until(() => messages.length === 1);
    alice.dropConnection(); await until(() => tunnel.requests.length === 2 && alice.state === "on");
    assert.equal(alice.room?.id, room.id); await alice.send("after reconnect"); await until(() => messages.length === 2);
    assert.ok(tunnel.requests.every(request => request.target === "not-resolvable.invalid:8765" && request.authorization === `Basic ${Buffer.from("user:pass word").toString("base64")}`));
    assert.ok(!JSON.stringify(tunnel.requests).includes(server.password));
  } finally { await alice.close(); await bob.close(); await tunnel.close(); await server.close(); }
});

test("NO_PROXY bypasses a rejecting proxy; proxy failures never silently connect directly or leak credentials", async () => {
  const server = await RoomServer.start({ host: "127.0.0.1", port: 0 }); const tunnel = await proxy(server.port, { status: 403 });
  const profile = { server: `127.0.0.1:${server.port}`, password: server.password };
  const direct = new RoomClient(profile, undefined, { proxyEnv: { HTTP_PROXY: tunnel.url, NO_PROXY: "127.0.0.1" } });
  const blocked = new RoomClient(profile, undefined, { proxyEnv: { HTTPS_PROXY: tunnel.url.replace("://", "://user:private@") } });
  try {
    await direct.connect(); assert.equal(tunnel.requests.length, 0); await direct.close();
    await assert.rejects(blocked.connect(), error => error instanceof Error && /CONNECT \(403\)/.test(error.message) && !error.message.includes("private"));
    assert.equal(blocked.state, "off"); assert.equal(tunnel.requests.length, 1);
  } finally { await direct.close(); await blocked.close(); await tunnel.close(); await server.close(); }
});

test("proxy authentication failure is actionable and never contains the configured proxy password", async () => {
  const server = await RoomServer.start({ host: "127.0.0.1", port: 0 }); const tunnel = await proxy(server.port, { authorization: "not-matching" });
  const client = new RoomClient({ server: `127.0.0.1:${server.port}`, password: server.password }, undefined,
    { proxyEnv: { HTTPS_PROXY: tunnel.url.replace("://", "://user:private@") } });
  try { await assert.rejects(client.connect(), error => error instanceof Error && /authentication failed \(407\)/.test(error.message) && !error.message.includes("private")); }
  finally { await client.close(); await tunnel.close(); await server.close(); }
});

test("tunneling cannot bypass the pinned server certificate or send credentials to an impersonator", async () => {
  const real = await RoomServer.start({ host: "127.0.0.1", port: 0 });
  const tls = await generate([{ name: "commonName", value: "imposter" }], { keyType: "ec", curve: "P-256", algorithm: "sha256" });
  const fake = createHttpsServer({ key: tls.private, cert: tls.cert }); const ws = new WebSocketServer({ server: fake }); let frames = 0;
  ws.on("connection", socket => socket.on("message", () => { frames++; }));
  await new Promise<void>(resolve => fake.listen(0, "127.0.0.1", resolve));
  const address = fake.address(); assert.ok(address && typeof address !== "string");
  const tunnel = await proxy(address.port);
  const client = new RoomClient({ server: `127.0.0.1:${real.port}`, password: real.password }, undefined, { proxyEnv: { HTTPS_PROXY: tunnel.url } });
  try { await assert.rejects(client.connect(), /certificate/); assert.equal(frames, 0); }
  finally {
    await client.close(); await tunnel.close(); for (const socket of ws.clients) socket.terminate();
    await new Promise<void>(resolve => ws.close(() => resolve())); await new Promise<void>(resolve => fake.close(() => resolve())); await real.close();
  }
});

test("cancelling an unfinished CONNECT destroys the pending proxy socket", async () => {
  const server = await RoomServer.start({ host: "127.0.0.1", port: 0 }); const tunnel = await proxy(server.port, { stall: true });
  const client = new RoomClient({ server: `127.0.0.1:${server.port}`, password: server.password }, undefined, { proxyEnv: { HTTPS_PROXY: tunnel.url } });
  try {
    const connecting = assert.rejects(client.connect());
    await until(() => tunnel.requests.length === 1); await client.close(); await connecting;
    await until(() => tunnel.sockets.size === 0);
  } finally { await client.close(); await tunnel.close(); await server.close(); }
});

test("terminal login uses inherited proxy environment without saving proxy credentials", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sideband-proxy-login-"));
  const server = await RoomServer.start({ host: "127.0.0.1", port: 0 }); const tunnel = await proxy(server.port);
  try {
    const profiles = new RoomProfiles(directory);
    await withEnv({ HTTPS_PROXY: tunnel.url }, () => loginAndSave("work", { server: `127.0.0.1:${server.port}`, password: server.password }, profiles));
    assert.equal(tunnel.requests.length, 1); assert.deepEqual(Object.keys(await profiles.load("work")).sort(), ["password", "server"]);
  } finally { await tunnel.close(); await server.close(); await rm(directory, { recursive: true, force: true }); }
});

test("local Codex RPC stays direct even if the global HTTP agent is configured to proxy", async () => {
  const ws = new WebSocketServer({ port: 0, host: "127.0.0.1" }); await new Promise<void>(resolve => ws.once("listening", resolve));
  const address = ws.address(); assert.ok(address && typeof address !== "string");
  const tunnel = await proxy(address.port, { status: 403 }); const original = http.globalAgent;
  ws.on("connection", socket => socket.on("message", data => {
    const message = JSON.parse(data.toString()); if (message.id) socket.send(JSON.stringify({ id: message.id, result: {} }));
  }));
  const { roomProxyAgent } = await import("../src/room-proxy.js"); const global = roomProxyAgent(new URL(tunnel.url), new AbortController().signal);
  let rpc: CodexRpc | undefined;
  try { http.globalAgent = global; rpc = await CodexRpc.connect({ url: `ws://127.0.0.1:${address.port}` }); assert.equal(tunnel.requests.length, 0); }
  finally { http.globalAgent = original; await rpc?.close(); global.destroy(); for (const socket of ws.clients) socket.terminate(); await new Promise<void>(resolve => ws.close(() => resolve())); await tunnel.close(); }
});

test("bundled MCP supports a trusted HTTPS proxy while untrusted proxy TLS is rejected", { timeout: 15_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "sideband-proxy-mcp-"));
  const server = await RoomServer.start({ host: "127.0.0.1", port: 0 }); const tunnel = await proxy(server.port, { secure: true });
  const profile = { server: `127.0.0.1:${server.port}`, password: server.password };
  const untrusted = new RoomClient(profile, undefined, { proxyEnv: { HTTPS_PROXY: tunnel.url } });
  const sender = new RoomClient(profile, "sender", { proxyEnv: {} });
  const mcp = new Client({ name: "proxy-test", version: "1" });
  try {
    await assert.rejects(untrusted.connect(), /configured HTTP proxy/);
    const ca = join(directory, "proxy-ca.pem"); await writeFile(ca, tunnel.certificate!);
    await sender.connect(); const room = await sender.joinRoom("https-proxy");
    await mcp.connect(new StdioClientTransport({ command: process.execPath, args: [join(process.cwd(), "dist/sideband.cjs"), "mcp", "--harness", "claude"],
      env: { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
        SIDEBAND_STATE_DIR: directory, SIDEBAND_CLAUDE_SERVER: profile.server, SIDEBAND_CLAUDE_PASSWORD: profile.password,
        HTTPS_PROXY: tunnel.url, NODE_EXTRA_CA_CERTS: ca }, stderr: "pipe" }));
    const call = (name: string, args: Record<string, unknown>) => mcp.callTool({ name, arguments: args });
    assert.equal((await call("sideband_join_room", { room: room.id, name: "receiver" })).isError, undefined);
    let notification: unknown;
    mcp.setNotificationHandler(NotificationSchema.extend({ method: z.literal("notifications/claude/channel") }), value => { notification = value.params; });
    await sender.send("through secure proxy"); await until(() => notification !== undefined);
    assert.deepEqual(notification, { content: '<sideband sender="sender">\nthrough secure proxy\n</sideband>' });
    assert.equal(tunnel.requests.length, 1, "untrusted proxy TLS was rejected before CONNECT");
  } finally { await mcp.close(); await untrusted.close(); await sender.close(); await tunnel.close(); await server.close(); await rm(directory, { recursive: true, force: true }); }
});
