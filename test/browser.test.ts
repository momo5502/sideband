import test from "node:test";
import assert from "node:assert/strict";
import NodeWebSocket from "ws";
import { request } from "node:https";
import { request as httpRequest } from "node:http";
import { RoomServer } from "../src/room-server.js";
import { RoomClient } from "../src/room-client.js";
import { AgentKeys, identityFor, verifyMessage, type SignedMessage } from "../src/room-protocol.js";
import { BrowserRoomClient, browserIdentity, browserVerify } from "../src/browser-protocol.js";

const waitFor = <T>(listen: (resolve: (value: T) => void) => void) => new Promise<T>((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("Browser push did not arrive.")), 4000);
  listen(value => { clearTimeout(timer); resolve(value); });
});
function browser(server: RoomServer, tls: boolean, password = server.password, name = "web-human", key?: Uint8Array) {
  const host = `127.0.0.1:${tls ? server.port : server.statusPort}`;
  return new BrowserRoomClient(`${tls ? "wss" : "ws"}://${host}/browser-ws`, password, name, key,
    url => new NodeWebSocket(url, { rejectUnauthorized: false, origin: `${tls ? "https" : "http"}://${host}` }) as unknown as WebSocket);
}
async function fetch(server: RoomServer, path: string, tls: boolean) {
  return new Promise<{ code: number; body: string; headers: import("node:http").IncomingHttpHeaders }>((resolve, reject) => {
    const req = (tls ? request : httpRequest)({ hostname: "127.0.0.1", port: tls ? server.port : server.statusPort,
      path, rejectUnauthorized: false, agent: false }, res => {
      let body = ""; res.setEncoding("utf8"); res.on("data", chunk => { body += chunk; });
      res.once("end", () => resolve({ code: res.statusCode!, body, headers: res.headers })); res.once("error", reject);
    });
    req.once("error", reject); req.end();
  });
}
test("browser-generated keys and signatures interoperate with native Node identities", () => {
  const identity = browserIdentity(crypto.getRandomValues(new Uint8Array(32)), "human");
  assert.deepEqual(identityFor(identity.publicKey, identity.name), identity);
  const keys = new AgentKeys("node");
  const unsigned = { id: "1", roomId: "2", sender: keys.identity, text: "<script>alert('plain text')</script>" };
  const signature = keys.sign(JSON.stringify(["sideband.message", 1, "1", "2", keys.identity.id, "node", unsigned.text]));
  const message = { ...unsigned, signature, createdAt: Date.now() };
  assert.equal(browserVerify(message), true); assert.equal(browserVerify({ ...message, text: "tampered" }), false);
  assert.equal(browserVerify({ ...message, sender: { ...message.sender, id: identity.id } }), false);
});
for (const tls of [false, true]) test(`browser chat over ${tls ? "HTTPS" : "HTTP"}: signed push, history, room isolation and session identity`, async () => {
  const server = await RoomServer.start({ host: "127.0.0.1", port: 0, statusPort: 0, graceMs: 3000 });
  const agent = new RoomClient({ server: `127.0.0.1:${server.port}`, password: server.password }, "native-agent");
  const key = crypto.getRandomValues(new Uint8Array(32));
  const web = browser(server, tls, undefined, undefined, key), other = browser(server, tls, undefined, "other-human");
  let resumed: BrowserRoomClient | undefined;
  try {
    await agent.connect(); const room = await agent.createRoom("browser-room"); await agent.send("Earlier message");
    await web.connect(); assert.equal((await web.rooms()).length, 1); await web.join(room.id);
    assert.equal((await web.history())[0]?.text, "Earlier message");
    const toAgent = waitFor<SignedMessage>(resolve => agent.onMessage(resolve));
    const own = await web.send("Hello from the browser"); const received = await toAgent;
    assert.equal(received.text, own.text); assert.equal(verifyMessage(received), true); assert.deepEqual(received.sender, web.identity);
    let echoes = 0; web.onMessage = () => echoes++;
    await web.send("No self echo"); await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(echoes, 0);
    const toBrowser = waitFor<SignedMessage>(resolve => { web.onMessage = resolve; });
    await agent.send("Hello from the native agent"); assert.equal((await toBrowser).text, "Hello from the native agent");
    await other.connect(); await other.join("separate-room", true); let leaked = 0; other.onMessage = () => leaked++;
    await web.send("Private to this room"); await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(leaked, 0);
    await assert.rejects(web.request("send", { id: "forged", text: "cannot forge", signature: own.signature }), /signature/i);
    resumed = browser(server, tls, undefined, undefined, key); await resumed.connect();
    assert.deepEqual(resumed.identity, web.identity); assert.equal(resumed.room?.id, room.id);
    await resumed.leave(); await resumed.join("new-room", true); assert.equal(resumed.room?.name, "new-room");
  } finally { web.disconnect(); other.disconnect(); resumed?.disconnect(); await agent.close(); await server.close(); }
});
test("browser login rejects wrong passwords, certificate identity and duplicate names", async () => {
  const server = await RoomServer.start({ host: "127.0.0.1", port: 0, statusPort: 0 });
  const good = browser(server, false); const duplicate = browser(server, false);
  const [, pin] = server.password.split(".");
  const wrongSecret = browser(server, false, `sb1.${pin}.${"x".repeat(43)}`, "wrong-secret");
  const wrongPin = browser(server, false, `sb1.${"x".repeat(43)}.${server.password.split(".")[2]}`, "wrong-pin");
  try {
    await good.connect(); await assert.rejects(duplicate.connect(), /already registered/);
    await assert.rejects(wrongSecret.connect(), /Password or identity proof/); await assert.rejects(wrongPin.connect(), /different server certificate/);
    assert.throws(() => browser(server, false, server.password, "invalid name"), /Names use/);
  } finally { for (const client of [good, duplicate, wrongSecret, wrongPin]) client.disconnect(); await server.close(); }
});
test("browser endpoint requires exact same-origin on HTTP and HTTPS; native endpoint stays TLS-only", async () => {
  const server = await RoomServer.start({ host: "127.0.0.1", port: 0, statusPort: 0 });
  try {
    for (const tls of [false, true]) {
      const host = `127.0.0.1:${tls ? server.port : server.statusPort}`;
      for (const origin of [undefined, "null", "https://evil.example", `${tls ? "http" : "https"}://${host}`]) {
        const socket = new NodeWebSocket(`${tls ? "wss" : "ws"}://${host}/browser-ws`, { rejectUnauthorized: false, origin });
        try { await assert.rejects(new Promise((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); }), /403/); }
        finally { socket.terminate(); }
      }
      for (const path of ["/chat", "/chat.js"]) {
        const response = await fetch(server, path, tls); assert.equal(response.code, 200);
        assert.equal(response.headers["cache-control"], "no-store"); assert.equal(response.headers["set-cookie"], undefined);
        assert.ok(!response.body.includes(server.password)); assert.ok(!response.body.includes(server.password.split(".")[2]!));
        assert.match(String(response.headers["content-security-policy"]), /script-src 'self'/);
        assert.ok(String(response.headers["content-security-policy"]).includes(`${tls ? "wss" : "ws"}://${host}`));
        if (path === "/chat") { assert.match(response.body, /type="password"/); assert.ok(!response.body.includes("<script>")); }
        else { assert.ok(response.body.length > 1000, "browser bundle is embedded, not an empty placeholder"); assert.match(response.body, /Copyright \(c\).*Paul Miller/); }
      }
    }
  } finally { await server.close(); }
});
