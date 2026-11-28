import { testTimeout } from "./waits.js";
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { RoomServer } from "../src/room-server.js";
import { RoomProfiles } from "../src/room-profiles.js";
import { Worker } from "../src/worker.js";
import { generate } from "selfsigned";
import { RoomError } from "../src/room-protocol.js";
import { RuntimeUpdater } from "../src/updater.js";
import { randomUUID } from "node:crypto";
import { BrowserRoomClient } from "../src/browser-protocol.js";
import NodeWebSocket from "ws";
import { AgentStore, type SavedAgent } from "../src/persistence.js";
import { AgentKeys } from "../src/room-protocol.js";

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check: () => boolean, timeout = testTimeout(15000)) {
  const end = Date.now() + timeout;
  while (!check()) { if (Date.now() > end) throw new Error("Worker recovery timed out."); await pause(25); }
}
function worker(directory: string) {
  const child = spawn(process.execPath, [resolve("dist/src/cli.js"), "worker", "--omp", process.execPath], {
    windowsHide: true, env: { ...process.env, SIDEBAND_STATE_DIR: directory }, stdio: ["ignore", "pipe", "pipe"],
  });
  let log = ""; child.stdout!.on("data", chunk => { log += chunk; }); child.stderr!.on("data", chunk => { log += chunk; });
  const exited = new Promise<number | null>(resolve => child.once("exit", resolve));
  return { child, exited, get log() { return log; } };
}

test("new workers retain updater metadata while an older server accepts only OMP", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sideband-worker-harnesses-"));
  const server = await RoomServer.start({ host: "127.0.0.1", port: 0 }); const registrations: any[] = [];
  const updater = new RuntimeUpdater("worker", resolve("dist/src/cli.js"), directory, async () => {}); updater.build.commit = "a".repeat(40);
  const fixture = { command: process.execPath };
  const worker = new Worker({ profile: { server: `127.0.0.1:${server.port}`, password: server.password }, entry: resolve("dist/src/cli.js"), root: directory, omp: fixture, codex: fixture, claude: fixture, updater });
  const request = worker.client.request.bind(worker.client);
  worker.client.request = async (method, params) => {
    if (method === "control.worker") { registrations.push(params!.machine); if ((params!.machine as any).harnesses.some((name: string) => name !== "omp")) throw new RoomError("CONTROL", "Invalid harness list."); }
    return request(method, params) as never;
  };
  try {
    await worker.start(); assert.deepEqual(worker.machine.harnesses, ["omp", "codex", "claude"]);
    assert.deepEqual(registrations.at(-1).harnesses, ["omp"]); assert.equal(registrations.at(-1).build.commit, updater.build.commit); assert.equal(registrations.at(-1).updater, true);
  } finally { await worker.close(); await server.close(); assert.ok(directory.startsWith(join(tmpdir(), "sideband-worker-harnesses-"))); await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
});

test("inventory waits, old-server rejections and database failures never disconnect an updated worker", { timeout: testTimeout(30000) }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "sideband-worker-inventory-"));
  const server = await RoomServer.start({ host: "127.0.0.1", port: 0, statusPort: 0 });
  const origin = `http://127.0.0.1:${server.statusPort}`;
  const web = new BrowserRoomClient(`ws://127.0.0.1:${server.statusPort}/browser-ws`, server.password, "observer", undefined, url => new NodeWebSocket(url, { origin }) as unknown as WebSocket);
  const updater = new RuntimeUpdater("worker", resolve("dist/src/cli.js"), directory, async () => {}), target = "a".repeat(40), attempt = randomUUID();
  updater.build.commit = target; Object.assign(updater.state, { phase: "done", target, attempt, message: "Updated" });
  const warnings: string[] = [], connections: string[] = [], fixture = { command: process.execPath };
  const worker = new Worker({ profile: { server: `127.0.0.1:${server.port}`, password: server.password }, entry: resolve("dist/src/cli.js"), root: directory,
    omp: fixture, codex: fixture, claude: fixture, updater, onError: error => warnings.push(error.message), onConnection: change => connections.push(change.state) });
  const request = worker.client.request.bind(worker.client);
  let inventoryCalls = 0, hold = true, rejectHeld: ((error: Error) => void) | undefined;
  let resolveHeld: ((value: unknown) => void) | undefined;
  let failure: Error | undefined = new RoomError("CONTROL", "Orchestration controls are available through the authenticated web panel.");
  worker.client.request = async (method, params) => {
    if (method === "control.inventory") {
      inventoryCalls++;
      if (hold) return await new Promise<unknown>((resolve, reject) => { rejectHeld = reject; resolveHeld = resolve; }) as never;
      if (failure) throw failure;
    }
    return request(method, params) as never;
  };
  const scheduler = worker as unknown as { scheduleInventory(): void; syncInventory(): Promise<void> };
  try {
    await worker.start(); assert.ok(rejectHeld, "inventory is pending while worker startup is already complete"); assert.equal(worker.client.state, "on");
    hold = false; rejectHeld!(failure!); rejectHeld = undefined; await until(() => warnings.length === 1);
    assert.equal(worker.client.state, "on"); await web.connect();
    const snapshot = await web.request<{ machines: { online: boolean; build: { commit: string }; update: { attempt: string; phase: string } }[] }>("control.list"), machine = snapshot.machines[0]!;
    assert.equal(machine.online, true); assert.equal(machine.build.commit, target); assert.equal(machine.update.phase, "done"); assert.equal(machine.update.attempt, attempt, "the rollout can accept the worker as updated without waiting on inventory");
    scheduler.scheduleInventory(); await until(() => inventoryCalls === 2); await pause(10); assert.equal(warnings.length, 1, "repeated legacy errors are reported once");
    failure = new Error("database is locked"); scheduler.scheduleInventory(); await until(() => warnings.length === 2); assert.equal(worker.client.state, "on");
    failure = undefined; await scheduler.syncInventory(); assert.equal(worker.client.state, "on");
    const id = randomUUID(), keys = new AgentKeys("saved");
    const saved: SavedAgent = { agent: { id, name: "saved", harness: "omp", machineId: worker.machine.id, machineName: "fixture", room: "", state: "idle", online: false, persistent: true, createdAt: Date.now() },
      privateKey: keys.exportPrivateKey(), workspaceReady: false, desired: "running", updatedAt: Date.now() };
    const store = await AgentStore.open(directory, { server: `127.0.0.1:${server.port}`, password: server.password });
    try {
      await store.registry.change(() => store.registry.put("agent", id, saved)); await request("control.inventory", { agents: [saved.agent] });
      hold = true; scheduler.scheduleInventory(); await until(() => !!rejectHeld);
      await web.request("control.action", { agentId: id, action: "stop" });
      assert.equal(store.get(id)!.desired, "stopped", "completed commands do not wait for a pending inventory request");
      const calls = inventoryCalls; hold = false; resolveHeld!({ archived: [id], errors: [] }); rejectHeld = undefined; resolveHeld = undefined;
      await until(() => inventoryCalls > calls);
      await until(() => !((worker as unknown as { inventory?: Promise<void> }).inventory));
      assert.equal(store.get(id)!.desired, "stopped", "a stale inventory response cannot undo the completed action");
    } finally { await store.close(); }
    assert.deepEqual(connections, ["connecting", "on"], "inventory failures never enter the reconnect loop");
    assert.match(warnings[0]!, /without disconnecting/);
  } finally {
    rejectHeld?.(new Error("Fixture closing")); web.disconnect(); await worker.close(); await server.close();
    assert.ok(directory.startsWith(join(tmpdir(), "sideband-worker-inventory-"))); await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
async function stop(child: ChildProcess) { if (child.exitCode === null && child.signalCode === null) { child.kill(); await new Promise<void>(resolve => child.once("exit", () => resolve())); } }

test("machine identity survives a server address/port migration", async () => {
  const server = await RoomServer.start({ host: "127.0.0.1", port: 0 });
  try {
    const base = { root: join(tmpdir(), "sideband-test-machine-identity"), entry: resolve("dist/src/cli.js") };
    const first = new Worker({ ...base, profile: { server: "example.com:8765", password: server.password } });
    const next = new Worker({ ...base, profile: { server: "example.com", password: server.password } });
    assert.equal(first.machine.id, next.machine.id);
    await first.close(); await next.close();
  } finally { await server.close(); }
});
test("an updated worker still registers with a server that rejects terminal capability fields", async () => {
  const server = await RoomServer.start({ host: "127.0.0.1", port: 0 }); const warnings: string[] = [], fields: boolean[] = [];
  const worker = new Worker({ profile: { server: `127.0.0.1:${server.port}`, password: server.password }, entry: resolve("dist/src/cli.js"), omp: { command: process.execPath }, onError: error => warnings.push(error.message) });
  const request = worker.client.request.bind(worker.client);
  worker.client.request = async (method, params) => {
    if (method === "control.worker") { const present = Object.hasOwn((params!.machine as object), "terminal"); fields.push(present); if (present) throw new RoomError("INVALID_ARGUMENT", "Unexpected field."); }
    return request(method, params) as never;
  };
  try { await worker.start(); assert.equal(worker.client.state, "on"); assert.deepEqual(fields, [true, false]); assert.match(warnings[0]!, /Update the server/); }
  finally { await worker.close(); await server.close(); }
});

test("worker on shared HTTPS retries a prolonged outage, re-registers after server restart and reports rotated credentials", { timeout: testTimeout(65000) }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "sideband-worker-reconnect-")), credentialsFile = join(directory, "identity.json");
  const certificate = await generate([{ name: "commonName", value: "sideband.example.com" }], { keyType: "ec", curve: "P-256", algorithm: "sha256" });
  const browserHttps = { domain: "sideband.example.com", directory: join(directory, "https"), httpPort: 0, httpsPort: 0, issue: async () => ({ key: certificate.private, cert: certificate.cert }) };
  let server = await RoomServer.start({ host: "127.0.0.1", port: 0, credentialsFile, browserHttps });
  const port = server.nativePort; browserHttps.httpsPort = port;
  await new RoomProfiles(directory).save("test", { server: `127.0.0.1:${port}`, password: server.password });
  const process = worker(directory);
  try {
    await until(() => process.log.includes("connected and registered"));
    await server.close();
    await until(() => process.log.includes("retrying in 10s"), 25000);
    assert.equal(process.child.exitCode, null, "the worker remains alive through multiple failed attempts");
    server = await RoomServer.start({ host: "127.0.0.1", port: 0, credentialsFile, browserHttps });
    assert.equal(server.nativePort, port, "the shared HTTPS listener keeps the saved client port across restarts");
    await until(() => process.log.split("connected and registered").length >= 3);
    await server.close();
    server = await RoomServer.start({ host: "127.0.0.1", port: 0, credentialsFile, browserHttps, rotatePassword: true });
    assert.equal(server.nativePort, port);
    await until(() => process.log.includes("Worker cannot reconnect"));
    assert.match(process.log, /certificate does not match/); assert.match(process.log, /sideband login again/);
    assert.equal(await process.exited, 1, "permanent failures exit nonzero instead of silently abandoning recovery");
  } finally { await stop(process.child); await server.close(); assert.ok(directory.startsWith(join(tmpdir(), "sideband-worker-reconnect-"))); await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
});
test("worker started during an outage waits for the server instead of exiting", { timeout: testTimeout(15000) }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "sideband-worker-initial-")), credentialsFile = join(directory, "identity.json");
  let server = await RoomServer.start({ host: "127.0.0.1", port: 0, credentialsFile }); const port = server.port;
  await new RoomProfiles(directory).save("test", { server: `127.0.0.1:${port}`, password: server.password }); await server.close();
  const process = worker(directory);
  try {
    await until(() => process.log.includes("retrying")); assert.equal(process.child.exitCode, null);
    server = await RoomServer.start({ host: "127.0.0.1", port, credentialsFile }); await until(() => process.log.includes("connected and registered"));
  } finally { await stop(process.child); await server.close(); assert.ok(directory.startsWith(join(tmpdir(), "sideband-worker-initial-"))); await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
});
