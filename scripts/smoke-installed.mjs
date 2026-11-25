import { STARTUP_TIMEOUT_MS, REQUEST_TIMEOUT_MS } from "../dist/src/timeouts.js";
// Smoke-test an isolated npm installation, not the source tree. Never print its ephemeral password.
import { spawn } from "node:child_process";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { mkdir, mkdtemp, writeFile, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { request } from "node:https";
import { request as httpRequest } from "node:http";
import assert from "node:assert/strict";
import { generate } from "selfsigned";

const root = resolve(process.argv[2] ?? ".cache/install-check/node_modules/sideband");
const entry = process.argv[3] ? resolve(process.argv[3]) : join(root, "dist/src/cli.js");
for (const asset of ["sideband.cjs", "sideband-omp.cjs", "sideband-pi.cjs", "src/pi-model-probe.js", "src/server-worker.js", "src/plugin-install.js", "src/plugin-presence.js", "THIRD_PARTY_NOTICES.txt"]) await access(join(root, "dist", asset));
const { RoomClient } = await import(pathToFileURL(join(root, "dist/src/room-client.js")).href);
const { BrowserRoomClient } = await import(pathToFileURL(join(root, "dist/src/browser-protocol.js")).href);
const { default: NodeWebSocket } = await import("ws");
const state = await mkdtemp(join(tmpdir(), "sideband-smoke-server-"));
// Seed a local certificate so Git-install checks cover --domain without contacting a public CA.
const domain = "sideband.example.com", tls = await generate([{ name: "commonName", value: domain }], { keyType: "ec", curve: "P-256", algorithm: "sha256" });
const certificateDirectory = join(state, "https", "production", domain);
await mkdir(certificateDirectory, { recursive: true, mode: 0o700 });
await writeFile(join(certificateDirectory, "certificate.json"), JSON.stringify({ key: tls.private, cert: tls.cert }), { mode: 0o600 });
const child = spawn(process.execPath, [entry, "server", "--worker", "--host", "127.0.0.1", "--port", "0", "--status-port", "0", "--domain", domain, "--http-port", "0", "--https-port", "0"], {
  env: { ...process.env, SIDEBAND_STATE_DIR: state, PI_CODING_AGENT_DIR: join(state, "pi"), OMP_BINARY: "sideband-test-missing-harness", CODEX_BIN: "sideband-test-missing-harness", CLAUDE_BINARY: "sideband-test-missing-harness", PI_BINARY: "sideband-test-missing-harness" }, stdio: ["ignore", "pipe", "pipe", "ipc"], windowsHide: true });
let timer;
let workerConnected = false;
const clients = [];
try {
  const profile = await new Promise((resolve, reject) => {
    let stdout = ""; let stderr = "";
    timer = setTimeout(() => reject(new Error("Installed server did not start.")), STARTUP_TIMEOUT_MS);
    child.on("error", reject); child.on("exit", () => reject(new Error(`Installed server exited: ${stderr}`)));
    child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-1000); if (stderr.includes("Worker connected and registered")) workerConnected = true; });
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      const port = /listening on 127\.0\.0\.1:(\d+)/.exec(stdout);
      const password = /Password: (sb1\.[A-Za-z0-9_.-]+)/.exec(stdout);
      const status = /Existing ports \d+\/(\d+) remain available/.exec(stdout);
      if (port && password && status) { stdout = ""; resolve({ server: `127.0.0.1:${port[1]}`, password: password[1], statusPort: Number(status[1]) }); }
    });
  });
  clearTimeout(timer);
  const workerDeadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (!workerConnected) { if (Date.now() > workerDeadline) throw new Error("Installed embedded worker did not register."); await new Promise(r => setTimeout(r, 30)); }
  const alice = new RoomClient(profile, "installed-alice", { proxyEnv: {} }); const bob = new RoomClient(profile, "installed-bob", { proxyEnv: {} }); clients.push(alice, bob);
  await alice.connect(); await bob.connect(); const room = await alice.joinRoom("installed-smoke"); await bob.joinRoom(room.id);
  const arrived = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error("Installed client did not receive push.")), REQUEST_TIMEOUT_MS);
    bob.onMessage((message) => message.text === "Package push check" ? resolve(message) : reject(new Error("Wrong message.")));
  });
  await alice.send("Package push check"); await arrived; clearTimeout(timer);
  if ((await bob.history()).length !== 1) throw new Error("Installed package history mismatch.");
  // Ephemeral loopback fixture only: browser-style status requests do not use Sideband credentials.
  for (const tls of [true, false]) {
    const status = await new Promise((resolve, reject) => {
      const url = tls ? `https://${profile.server}/status.json` : `http://127.0.0.1:${profile.statusPort}/status.json`;
      const req = (tls ? request : httpRequest)(url, { agent: false, rejectUnauthorized: false }, res => {
        let body = ""; res.setEncoding("utf8"); res.on("data", chunk => { body += chunk; });
        res.once("end", () => resolve({ code: res.statusCode, body })); res.once("error", reject);
      });
      req.setTimeout(REQUEST_TIMEOUT_MS, () => req.destroy(new Error("Installed status request timed out.")));
      req.once("error", reject); req.end();
    });
    assert.equal(status.code, 200); assert.deepEqual(JSON.parse(status.body), { rooms: 1, connectedParticipants: 2 });
    for (const path of ["/chat", "/chat.js"]) {
      const page = await new Promise((resolve, reject) => {
        const url = tls ? `https://${profile.server}${path}` : `http://127.0.0.1:${profile.statusPort}${path}`;
        const req = (tls ? request : httpRequest)(url, { agent: false, rejectUnauthorized: false }, res => {
          let body = ""; res.setEncoding("utf8"); res.on("data", chunk => { body += chunk; });
          res.once("end", () => resolve({ code: res.statusCode, body })); res.once("error", reject);
        });
        req.setTimeout(REQUEST_TIMEOUT_MS, () => req.destroy(new Error("Installed browser page request timed out."))); req.once("error", reject); req.end();
      });
      assert.equal(page.code, 200); assert.ok(page.body.length > 1000); assert.ok(!page.body.includes(profile.password));
    }
  }
  const { path } = await alice.request("webhook", { room: "installed-smoke", sender: "installed-webhook" });
  let webhookReceived = false;
  bob.onMessage(message => { if (message.sender.name === "installed-webhook" && message.text.includes("event: issues.opened") && !message.text.includes("metadata-noise") && !message.text.includes("body-noise")) webhookReceived = true; });
  const webhookCode = await new Promise((resolve, reject) => {
    const req = httpRequest(`http://127.0.0.1:${profile.statusPort}${path}`, { method: "POST", agent: false, headers: { "Content-Type": "application/json", "X-GitHub-Event": "issues" } }, res => {
      res.resume(); res.once("end", () => resolve(res.statusCode)); res.once("error", reject);
    });
    req.setTimeout(REQUEST_TIMEOUT_MS, () => req.destroy(new Error("Installed webhook timed out."))); req.once("error", reject);
    req.end(JSON.stringify({ action: "opened", repository: { full_name: "owner/repo", owner: { avatar_url: "metadata-noise" } }, issue: { number: 1, title: "Bug", body: "body-noise" } }));
  });
  assert.equal(webhookCode, 204);
  const deadline = Date.now() + REQUEST_TIMEOUT_MS;
  while (!webhookReceived) { if (Date.now() > deadline) throw new Error("Installed webhook push did not arrive."); await new Promise(resolve => setTimeout(resolve, 10)); }
  assert.equal((await bob.history()).length, 2);
  const origin = `http://127.0.0.1:${profile.statusPort}`;
  const web = new BrowserRoomClient(origin.replace("http:", "ws:") + "/browser-ws", profile.password, "installed-web-user", undefined, url => new NodeWebSocket(url, { origin }));
  clients.push({ close: async () => web.disconnect() }); await web.connect();
  const machines = (await web.request("control.list")).machines;
  assert.equal(machines.length, 1); assert.equal(machines[0].online, true); assert.equal(machines[0].updater, true);
  const firstRoom = await web.subscribe("installed-smoke"), secondRoom = await web.subscribe("installed-second");
  assert.equal(web.joinedRooms.size, 2);
  let backgroundPush;
  web.onMessage = message => { if (message.text === "@installed-web-user background mention") backgroundPush = message; };
  await alice.send("@installed-web-user background mention");
  const pushedBy = Date.now() + REQUEST_TIMEOUT_MS;
  while (!backgroundPush) { if (Date.now() > pushedBy) throw new Error("Installed multi-room browser push timed out."); await new Promise(resolve => setTimeout(resolve, 10)); }
  assert.equal(backgroundPush.roomId, firstRoom.id);
  await web.send("Only in the second room"); assert.deepEqual((await web.history()).map(message => message.text), ["Only in the second room"]);
  // Collapsing to a legacy single-room join must retain a room owned solely by this browser.
  await web.join(secondRoom.id); assert.ok((await web.rooms()).some(room => room.id === secondRoom.id));
  await web.subscribe(firstRoom.id); await web.leave(); assert.deepEqual([...web.joinedRooms.keys()], [secondRoom.id]);
  web.disconnect();
  const loggedOutBy = Date.now() + REQUEST_TIMEOUT_MS;
  while ((await alice.listRooms()).some(room => room.id === secondRoom.id)) { if (Date.now() > loggedOutBy) throw new Error("Installed browser memberships did not clean up."); await new Promise(resolve => setTimeout(resolve, 10)); }
  assert.equal((await alice.members()).length, 2);
  console.log("Installed npm package: combined server/worker, pinned domain TLS, companion assets, signed push/history, status, webhooks and multi-room browser cleanup passed.");
} finally {
  clearTimeout(timer); await Promise.all(clients.map((client) => client.close())); if (child.connected) child.send({ type: "sideband.shutdown" }); else child.kill();
  await new Promise((resolve) => { if (child.exitCode !== null || child.signalCode !== null) resolve(); else child.once("exit", resolve); });
  if (!state.startsWith(join(tmpdir(), "sideband-smoke-server-"))) throw new Error("Unsafe test state path.");
  await rm(state, { recursive: true, force: true });
}
