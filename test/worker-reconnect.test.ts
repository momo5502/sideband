import test from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { RoomServer } from "../src/room-server.js";
import { RoomProfiles } from "../src/room-profiles.js";
import { Worker } from "../src/worker.js";

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check: () => boolean, timeout = 15000) {
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

test("worker retries a prolonged outage, re-registers after server restart and reports rotated credentials", { timeout: 65000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "sideband-worker-reconnect-")), credentialsFile = join(directory, "identity.json");
  let server = await RoomServer.start({ host: "127.0.0.1", port: 0, credentialsFile });
  const port = server.port;
  await new RoomProfiles(directory).save("test", { server: `127.0.0.1:${port}`, password: server.password });
  const process = worker(directory);
  try {
    await until(() => process.log.includes("connected and registered"));
    await server.close();
    await until(() => process.log.includes("retrying in 10s"), 25000);
    assert.equal(process.child.exitCode, null, "the worker remains alive through multiple failed attempts");
    server = await RoomServer.start({ host: "127.0.0.1", port, credentialsFile });
    await until(() => process.log.split("connected and registered").length >= 3);
    await server.close();
    server = await RoomServer.start({ host: "127.0.0.1", port, credentialsFile, rotatePassword: true });
    await until(() => process.log.includes("Worker cannot reconnect"));
    assert.match(process.log, /certificate does not match/); assert.match(process.log, /sideband login again/);
    assert.equal(await process.exited, 1, "permanent failures exit nonzero instead of silently abandoning recovery");
  } finally { await stop(process.child); await server.close(); assert.ok(directory.startsWith(join(tmpdir(), "sideband-worker-reconnect-"))); await rm(directory, { recursive: true, force: true }); }
});
test("worker started during an outage waits for the server instead of exiting", { timeout: 15000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "sideband-worker-initial-")), credentialsFile = join(directory, "identity.json");
  let server = await RoomServer.start({ host: "127.0.0.1", port: 0, credentialsFile }); const port = server.port;
  await new RoomProfiles(directory).save("test", { server: `127.0.0.1:${port}`, password: server.password }); await server.close();
  const process = worker(directory);
  try {
    await until(() => process.log.includes("retrying")); assert.equal(process.child.exitCode, null);
    server = await RoomServer.start({ host: "127.0.0.1", port, credentialsFile }); await until(() => process.log.includes("connected and registered"));
  } finally { await stop(process.child); await server.close(); assert.ok(directory.startsWith(join(tmpdir(), "sideband-worker-initial-"))); await rm(directory, { recursive: true, force: true }); }
});
