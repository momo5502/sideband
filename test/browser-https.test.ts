import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { get as httpsGet } from "node:https";
import { get as httpGet, createServer } from "node:http";
import { X509Certificate } from "node:crypto";
import { generate } from "selfsigned";
import NodeWebSocket from "ws";
import { BrowserHttps, browserDomain, listenerError, type BrowserCertificate } from "../src/browser-https.js";
import { createServerIdentity } from "../src/server-identity.js";
import { RoomServer } from "../src/room-server.js";
import { RoomClient } from "../src/room-client.js";
import { BrowserRoomClient } from "../src/browser-protocol.js";

const domain = "sideband.example.com";
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check: () => boolean) { const end = Date.now() + 6000; while (!check()) { if (Date.now() > end) throw new Error("HTTPS condition timed out."); await pause(10); } }
async function certificate(): Promise<BrowserCertificate> {
  const pair = await generate([{ name: "commonName", value: domain }], { keyType: "ec", curve: "P-256", algorithm: "sha256" });
  return { key: pair.private, cert: pair.cert };
}
async function request(port: number, path: string, secure = true, servername = domain, host = "127.0.0.1") {
  return new Promise<{ code: number; body: string; headers: import("node:http").IncomingHttpHeaders; certificate?: string }>((resolve, reject) => {
    const options = { host, port, path, agent: false as const, ...(secure ? { rejectUnauthorized: false, servername } : {}) };
    const req = (secure ? httpsGet : httpGet)(options, res => {
      let body = ""; const raw = secure ? (res.socket as import("node:tls").TLSSocket).getPeerCertificate().raw : undefined;
      res.setEncoding("utf8"); res.on("data", chunk => { body += chunk; });
      res.on("end", () => resolve({ code: res.statusCode!, body, headers: res.headers, certificate: raw && new X509Certificate(raw).fingerprint256 }));
    }); req.on("error", reject);
  });
}
test("domain validation and privileged/occupied port failures are actionable", () => {
  assert.equal(browserDomain("Sideband.Example.COM"), domain);
  for (const name of ["localhost", "127.0.0.1", "https://example.com", "example.com:443", "example.com/path", "../example.com", "*.example.com", "-bad.example.com"]) assert.throws(() => browserDomain(name));
  assert.match(listenerError({ code: "EACCES" }, 80).message, /permission denied.*--http-port/);
  assert.match(listenerError({ code: "EADDRINUSE" }, 443).message, /443.*already in use/);
});
test("ACME challenge routes, private cached state, renewal hot-swap and stable native certificate", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sideband-https-"));
  const identity = await createServerIdentity(), native = { key: identity.privateKey, cert: identity.certificate };
  const certificates = [await certificate(), await certificate()];
  let calls = 0, time = Date.now(), fail = false, accountKey = "";
  const logs: string[] = [];
  let server: BrowserHttps;
  const options = { domain, directory, httpPort: 0, httpsPort: 0, now: () => time, log: (line: string) => logs.push(line),
    issue: async (request: import("../src/browser-https.js").CertificateRequest) => {
      calls++; if (fail) throw new Error("DNS test failure");
      if (accountKey) assert.equal(request.accountKey, accountKey); else accountKey = request.accountKey;
      request.challenges.set("test_token", "challenge.test-authorization");
      const response = await requestHttp(); assert.equal(response.code, 200); assert.equal(response.body, "challenge.test-authorization");
      assert.equal((await requestWrong()).code, 404);
      return certificates[Math.min(calls - 1, 1)]!;
    } };
  const requestHttp = () => request(server.httpPort, "/.well-known/acme-challenge/test_token", false);
  const requestWrong = () => request(server.httpPort, "/.well-known/acme-challenge/wrong", false);
  server = new BrowserHttps(options, native, (_req, res) => res.end("browser"));
  try {
    await server.listen("127.0.0.1"); await server.renew();
    assert.equal(calls, 1); assert.equal((await requestHttp()).code, 404, "challenge state is removed after issuance");
    const first = await request(server.port, "/chat"); assert.equal(first.body, "browser"); assert.equal(first.headers["strict-transport-security"], "max-age=31536000");
    assert.equal(first.certificate, new X509Certificate(certificates[0]!.cert).fingerprint256);
    assert.equal((await request(server.port, "/chat", true, "sideband.native")).certificate, new X509Certificate(native.cert).fingerprint256);
    const redirect = await request(server.httpPort, "/anything?secret=discarded", false);
    assert.equal(redirect.code, 308); assert.equal(redirect.headers.location, `${server.url}/anything?secret=discarded`);
    assert.equal((await request(server.httpPort, "/", false)).headers.location, `${server.url}/chat`);
    await server.renew(); assert.equal(calls, 1, "healthy certificates are reused");
    const stored = join(directory, "production", domain, "certificate.json");
    assert.equal(JSON.parse(await readFile(stored, "utf8")).cert, certificates[0]!.cert);
    if (process.platform !== "win32") for (const file of [stored, join(directory, "production", domain, "account.json")]) assert.equal((await stat(file)).mode & 0o777, 0o600);
    const leaf = new X509Certificate(certificates[0]!.cert);
    time = Date.parse(leaf.validTo) - 20 * 86400_000;
    await server.renew(); assert.equal(calls, 2);
    assert.notEqual((await request(server.port, "/chat")).certificate, first.certificate);
    assert.equal((await request(server.port, "/chat", true, "sideband.native")).certificate, new X509Certificate(native.cert).fingerprint256);
    assert.equal((await request(server.port, "/chat", true, "")).certificate, new X509Certificate(native.cert).fingerprint256, "no-SNI clients retain the stable native certificate after renewal");
    fail = true; await server.renew();
    assert.equal(calls, 3); assert.ok(logs.some(line => /DNS test failure.*Retrying/.test(line)));
    assert.equal((await request(server.port, "/chat")).certificate, new X509Certificate(certificates[1]!.cert).fingerprint256, "failed renewal keeps the previous certificate");
    await server.close();
    time = Date.now(); server = new BrowserHttps(options, native, (_req, res) => res.end("cached"));
    await server.listen("127.0.0.1"); await server.renew(); assert.equal(calls, 3, "restart does not contact the CA for a healthy cached certificate");
    assert.equal((await request(server.port, "/chat")).body, "cached");
  } finally { await server.close(); assert.ok(directory.startsWith(join(tmpdir(), "sideband-https-"))); await rm(directory, { recursive: true, force: true }); }
});
test("browser and native clients share trusted HTTPS with unchanged passwords and same-origin checks", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sideband-domain-")), pair = await certificate();
  const logs: string[] = [];
  const options = { host: "127.0.0.1", port: 0, statusPort: 0, credentialsFile: join(directory, "server.json"),
    browserHttps: { domain, directory: join(directory, "https"), httpPort: 0, httpsPort: 0, issue: async () => pair, log: (line: string) => logs.push(line) } };
  let server = await RoomServer.start(options);
  const native = new RoomClient({ server: `127.0.0.1:${server.nativePort}`, password: server.password }, "native");
  const origin = `${server.browserUrl}`;
  const web = new BrowserRoomClient(`wss://127.0.0.1:${server.nativePort}/browser-ws`, server.password, "human", undefined,
    url => new NodeWebSocket(url, { origin: `https://127.0.0.1:${server.nativePort}`, rejectUnauthorized: false, ...{ servername: domain } }) as unknown as WebSocket);
  try {
    // Native connections work even before certificate issuance completes.
    await native.connect(); await until(() => logs.some(line => line.startsWith("HTTPS ready")));
    await web.connect(); const room = await native.joinRoom("shared"); await web.join(room.id);
    assert.equal((await native.members()).length, 2);
    const snapshot = await web.request<{ serverPort: number }>("control.list"); assert.equal(snapshot.serverPort, server.nativePort);
    const html = await request(server.nativePort, "/chat"); assert.equal(html.code, 200); assert.match(String(html.headers["content-security-policy"]), /wss:/);
    assert.equal((await request(server.port, "/chat", true, "sideband.native")).headers["strict-transport-security"], undefined);
    const rejection = await new Promise<number>((resolve, reject) => {
      const socket = new NodeWebSocket(`wss://127.0.0.1:${server.nativePort}/browser-ws`, { origin: "https://evil.example", rejectUnauthorized: false, ...{ servername: domain } });
      socket.on("unexpected-response", (_req, res) => { res.resume(); socket.terminate(); resolve(res.statusCode!); }); socket.on("error", () => {}); socket.on("open", () => { socket.terminate(); reject(new Error("Cross-origin websocket was accepted")); });
    }); assert.equal(rejection, 403);
    const password = server.password; await native.close(); await web.disconnect(); await server.close();
    server = await RoomServer.start(options); assert.equal(server.password, password); assert.notEqual(origin, undefined);
  } finally { await native.close(); await web.disconnect(); await server.close(); assert.ok(directory.startsWith(join(tmpdir(), "sideband-domain-"))); await rm(directory, { recursive: true, force: true }); }
});
test("failed domain listener binding never rotates native credentials or starts ACME", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sideband-domain-bind-"));
  const credentialsFile = join(directory, "server.json"); const initial = await RoomServer.start({ host: "127.0.0.1", port: 0, credentialsFile }); await initial.close();
  const before = await readFile(credentialsFile, "utf8"), blocker = createServer();
  await new Promise<void>(resolve => blocker.listen(0, "127.0.0.1", resolve)); const address = blocker.address() as import("node:net").AddressInfo;
  let calls = 0;
  try {
    await assert.rejects(RoomServer.start({ host: "127.0.0.1", port: 0, credentialsFile, rotatePassword: true,
      browserHttps: { domain, directory, httpPort: address.port, httpsPort: 0, issue: async () => { calls++; return certificate(); } } }), /already in use/);
    assert.equal(await readFile(credentialsFile, "utf8"), before); assert.equal(calls, 0);
  } finally { await new Promise<void>(resolve => blocker.close(() => resolve())); assert.ok(directory.startsWith(join(tmpdir(), "sideband-domain-bind-"))); await rm(directory, { recursive: true, force: true }); }
});
test("corrupt browser cache is recoverable and shutdown cancels pending issuance without installing it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sideband-certificate-recovery-")), identity = await createServerIdentity();
  const native = { key: identity.privateKey, cert: identity.certificate }, pair = await certificate();
  const path = join(directory, "production", domain, "certificate.json"); await mkdir(join(directory, "production", domain), { recursive: true }); await writeFile(path, "broken cache");
  const logs: string[] = []; let complete!: (pair: BrowserCertificate) => void, started = false;
  const server = new BrowserHttps({ domain, directory, httpPort: 0, httpsPort: 0, log: line => logs.push(line),
    issue: () => { started = true; return new Promise(resolve => { complete = resolve; }); } }, native, (_req, res) => res.end("native"));
  try {
    await server.listen("127.0.0.1"); assert.ok(logs.some(line => line.startsWith("Cannot use cached browser certificate")));
    const pending = server.renew(); await until(() => started);
    assert.equal((await request(server.port, "/chat", true, "sideband.native")).code, 200, "native service remains usable without a browser certificate");
    await server.close(); complete(pair); await pending;
    assert.equal(await readFile(path, "utf8"), "broken cache", "late issuance cannot install a certificate after shutdown");
    assert.equal(logs.some(line => line.startsWith("HTTPS ready")), false);
  } finally { await server.close(); assert.ok(directory.startsWith(join(tmpdir(), "sideband-certificate-recovery-"))); await rm(directory, { recursive: true, force: true }); }
});
async function ipv6Available(): Promise<boolean> {
  const probe = createServer();
  try { await new Promise<void>((resolve, reject) => { probe.once("error", reject); probe.listen(0, "::1", resolve); }); return true; }
  catch (error) { if (["EAFNOSUPPORT", "EADDRNOTAVAIL", "EPROTONOSUPPORT"].includes((error as NodeJS.ErrnoException).code ?? "")) return false; throw error; }
  finally { await new Promise<void>(resolve => probe.close(() => resolve())); }
}
test("default browser/ACME listeners support IPv4 and IPv6 and retain unresolved challenges across retries", async t => {
  const directory = await mkdtemp(join(tmpdir(), "sideband-dual-stack-")), identity = await createServerIdentity(), pair = await certificate();
  let fail = true;
  const server = new BrowserHttps({ domain, directory, httpPort: 0, httpsPort: 0, issue: async request => {
    if (fail) { request.challenges.set("still_pending", "late-ca-response"); throw new Error("CA temporarily unavailable"); }
    return pair;
  } }, { key: identity.privateKey, cert: identity.certificate }, (_req, res) => res.end("dual stack"));
  try {
    await server.listen(); await server.renew();
    assert.equal((await request(server.httpPort, "/.well-known/acme-challenge/still_pending", false)).body, "late-ca-response");
    t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
    t.mock.timers.tick(59 * 60_000); await server.renew();
    t.mock.timers.tick(2 * 60_000);
    assert.equal((await request(server.httpPort, "/.well-known/acme-challenge/still_pending", false)).body, "late-ca-response", "a reused pending token gets a fresh retention window");
    t.mock.timers.reset();
    fail = false; await server.renew();
    assert.equal((await request(server.httpPort, "/.well-known/acme-challenge/still_pending", false)).body, "late-ca-response", "another issuance must not clear an unresolved older challenge");
    assert.equal((await request(server.port, "/chat")).body, "dual stack");
    if (await ipv6Available()) {
      assert.equal((await request(server.httpPort, "/.well-known/acme-challenge/still_pending", false, domain, "::1")).body, "late-ca-response");
      assert.equal((await request(server.port, "/chat", true, domain, "::1")).body, "dual stack");
    } else t.diagnostic("IPv6 is unavailable on this host; the default IPv4 fallback was verified.");
  } finally { await server.close(); assert.ok(directory.startsWith(join(tmpdir(), "sideband-dual-stack-"))); await rm(directory, { recursive: true, force: true }); }
});
test("default room and status listeners support native clients on both address families", async t => {
  const server = await RoomServer.start({ port: 0, statusPort: 0 });
  const clients = [new RoomClient({ server: `127.0.0.1:${server.port}`, password: server.password }, "v4")];
  try {
    await clients[0]!.connect(); const room = await clients[0]!.joinRoom("dual-stack");
    assert.equal((await request(server.statusPort!, "/status.json", false)).code, 200);
    if (await ipv6Available()) {
      const v6 = new RoomClient({ server: `[::1]:${server.port}`, password: server.password }, "v6"); clients.push(v6);
      await v6.connect(); await v6.joinRoom(room.id); assert.equal((await v6.members()).length, 2);
      assert.equal((await request(server.statusPort!, "/status.json", false, domain, "::1")).code, 200);
    } else t.diagnostic("IPv6 is unavailable on this host; the default IPv4 fallback was verified.");
  } finally { await Promise.all(clients.map(client => client.close())); await server.close(); }
});
