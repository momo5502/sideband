import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { ServerWorker } from "../src/server-worker.js";
import { RoomServer } from "../src/room-server.js";
import { Worker } from "../src/worker.js";
import { BrowserRoomClient } from "../src/browser-protocol.js";
import NodeWebSocket from "ws";
import { testTimeout } from "./waits.js";

const entry = resolve("dist/src/cli.js"), pause = (ms: number) => new Promise(r => setTimeout(r, ms));
async function until(check: () => boolean | Promise<boolean>) { const end = Date.now() + testTimeout(15000); while (!await check()) { if (Date.now() > end) throw new Error("Local worker did not settle."); await pause(30); } }
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

test("combined CLI boots without login, exposes an updater-enabled local machine and shuts down both supervisors", { timeout: testTimeout(45000) }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "sideband-combined-"));
  const child = spawn(process.execPath, [entry, "server", "--worker", "--worker-name", "local-test", "--host", "127.0.0.1", "--port", "0", "--status-port", "0"],
    { windowsHide: true, env: { ...process.env, SIDEBAND_STATE_DIR: directory }, stdio: ["ignore", "pipe", "pipe", "ipc"] });
  let log = "", ended = false; child.stdout!.on("data", data => { log += data; }); child.stderr!.on("data", data => { log += data; });
  const exit = new Promise<void>(r => child.once("exit", () => { ended = true; r(); })); let web: BrowserRoomClient | undefined;
  try {
    await until(() => /Worker connected and registered/.test(log));
    const password = /Password: ([^\r\n]+)/.exec(log)![1]!, port = /Browser: http:\/\/<your-VPS-IP>:(\d+)/.exec(log)![1]!;
    const origin = `http://127.0.0.1:${port}`;
    web = new BrowserRoomClient(`ws://127.0.0.1:${port}/browser-ws`, password, "observer", undefined, url => new NodeWebSocket(url, { origin }) as unknown as WebSocket);
    await web.connect();
    const snapshot = await web.request<any>("control.list"); assert.equal(snapshot.machines.length, 1);
    assert.equal(snapshot.machines[0].name, "local-test"); assert.equal(snapshot.machines[0].updater, true); assert.equal(snapshot.machines[0].online, true);
    assert.equal(await stat(join(directory, "connections")).then(() => true, () => false), false, "bootstrap must not create a saved login");
    assert.equal(await stat(join(directory, "server-worker", "connections")).then(() => true, () => false), false);
    web.disconnect(); child.send({ type: "sideband.shutdown" }); await until(() => ended); await exit;
    assert.equal(child.exitCode, 0);
  } finally { web?.disconnect(); if (!ended) { child.send({ type: "sideband.shutdown" }); await until(() => ended); } await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
});

test("local worker uses pinned native TLS even while a domain certificate is pending, restarts independently and releases its root", { timeout: testTimeout(45000) }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "sideband-local-worker-"));
  const server = await RoomServer.start({ host: "127.0.0.1", port: 0, statusPort: 0, browserHttps: { domain: "sideband.example.com", directory: join(directory, "https"), httpPort: 0, httpsPort: 0, issue: async () => { throw new Error("synthetic pending certificate"); }, log: () => {} } });
  const root = join(directory, "agents"), profile = { server: `127.0.0.1:${server.port}`, password: server.password };
  const local = new ServerWorker(entry, join(directory, "worker-state"), { profile, directory: root }, () => {});
  const origin = `http://127.0.0.1:${server.statusPort}`;
  const web = new BrowserRoomClient(`ws://127.0.0.1:${server.statusPort}/browser-ws`, server.password, "observer", undefined, url => new NodeWebSocket(url, { origin }) as unknown as WebSocket);
  let competitor: Worker | undefined;
  try {
    await web.connect(); local.start(); const first = local.pid!; local.start(); assert.equal(local.pid, first, "starting twice must not duplicate the worker");
    await until(async () => (await web.request<any>("control.list")).machines.some((m: any) => m.online));
    competitor = new Worker({ profile, entry, root }); await assert.rejects(competitor.start(), /Another worker is already using/);
    // Kill only our child supervisor. Its worker exits on IPC disconnect.
    process.kill(first); await until(() => !!local.pid && local.pid !== first);
    await until(async () => (await web.request<any>("control.list")).machines.some((m: any) => m.online));
    const second = local.pid!; await local.close(); await until(() => !alive(second));
    competitor = new Worker({ profile, entry, root }); await competitor.start(); assert.equal(competitor.client.state, "on");
  } finally { await competitor?.close(); await local.close(); web.disconnect(); await server.close(); await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
});

test("worker shutdown during slow harness discovery cancels probes and does not connect afterwards", { timeout: testTimeout(30000) }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "sideband-worker-startup-")), fixture = join(directory, "slow.mjs"), marker = join(directory, "probe");
  await writeFile(fixture, `import{writeFileSync}from'node:fs';writeFileSync(process.argv[2],'started');setInterval(()=>{},1000);`);
  const server = await RoomServer.start({ host: "127.0.0.1", port: 0 }), executable = { command: process.execPath, args: [fixture, marker] };
  const worker = new Worker({ profile: { server: `127.0.0.1:${server.port}`, password: server.password }, entry, root: directory, omp: executable, codex: executable, claude: executable, pi: executable });
  const startup = worker.start();
  try {
    await until(async () => (await readFile(marker, "utf8").catch(() => "")) === "started");
    await worker.close(); await startup; assert.equal(worker.client.state, "off");
    const replacement = new Worker({ profile: { server: `127.0.0.1:${server.port}`, password: server.password }, entry, root: directory });
    try { await replacement.start(); assert.equal(replacement.client.state, "on"); } finally { await replacement.close(); }
  } finally { await worker.close(); await startup; await server.close(); await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
});
