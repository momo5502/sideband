import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, mkdir, writeFile, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { JSDOM } from "jsdom";
import WebSocket from "ws";
import { RoomServer } from "../src/room-server.js";
import { RoomProfiles } from "../src/room-profiles.js";
import { RoomClient } from "../src/room-client.js";
import { LocalRun } from "../src/local-run.js";
import { BrowserWorkspace } from "../src/browser-workspace.js";
import { BrowserRoomClient } from "../src/browser-protocol.js";
import { until } from "./browser-fixture.js";
import { testTimeout } from "./waits.js";

test("local login is loopback-only, same-origin, single-use and removed from browser history before exchange", { timeout: testTimeout(30000) }, async () => {
  await assert.rejects(RoomServer.start({ host: "0.0.0.0", port: 0, statusPort: 0, localMode: true }), /loopback/);
  const server = await RoomServer.start({ host: "127.0.0.1", port: 0, statusPort: 0, localMode: true });
  const origin = `http://127.0.0.1:${server.statusPort}`, url = server.createLocalLogin(), token = url.split("=")[1]!;
  const exchange = (value: string, source = origin) => fetch(`${origin}/local-login`, { method: "POST", headers: { Origin: source, "Content-Type": "application/json" }, body: JSON.stringify({ token: value }) });
  const dom = new JSDOM("<html></html>", { url }); let store: BrowserWorkspace | undefined;
  try {
    assert.equal((await exchange(token, "https://evil.invalid")).status, 403);
    assert.equal((await fetch(`${origin}/local-login`)).status, 403);
    let historyCleared = false;
    dom.window.fetch = (async (_url, options) => { historyCleared = dom.window.location.hash === ""; return fetch(`${origin}/local-login`, { ...options, headers: { ...options!.headers, Origin: origin } }); }) as typeof fetch;
    store = new BrowserWorkspace(dom.window as unknown as Window, (endpoint, password, name, key) => new BrowserRoomClient(endpoint, password, name, key, address => new WebSocket(address, { origin }) as unknown as globalThis.WebSocket));
    store.start(); await until(() => store!.snapshot().connection === "on"); assert.equal(historyCleared, true);
    assert.equal((await exchange(token)).status, 403, "the browser consumed its ticket exactly once");
    assert.equal(store.snapshot().control.localOnly, true);
    const ticket = server.createLocalLogin().split("=")[1]!;
    assert.equal((await exchange(ticket)).status, 200); assert.equal((await exchange(ticket)).status, 403);
    const expired = server.createLocalLogin().split("=")[1]!;
    (server as any).localLogins.set(expired, Date.now() - 1); assert.equal((await exchange(expired)).status, 403);
    const native = new RoomClient({ server: `127.0.0.1:${server.port}`, password: server.password });
    try {
      await native.connect(); const fresh = await native.request<{ url: string }>("local_browser_login");
      assert.equal((await exchange(fresh.url.split("=")[1]!)).status, 200, "repeat run can mint a fresh login through pinned, authenticated TLS");
    } finally { await native.close(); }
  } finally { store?.dispose(); dom.window.close(); await server.close(); }
  const ordinary = await RoomServer.start({ host: "127.0.0.1", port: 0, statusPort: 0 });
  try { assert.throws(() => ordinary.createLocalLogin(), /only in/); } finally { await ordinary.close(); }
});

test("adding a local profile preserves the previously implicit sole-server default", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sideband-local-default-")), profiles = new RoomProfiles(directory);
  const profile = { server: "127.0.0.1:1234", password: `sb1.${"a".repeat(43)}.${"b".repeat(43)}` };
  await profiles.save("remote", profile); const local = await LocalRun.claim(directory, true); assert.ok(local);
  try {
    await local.profile({ ...profile, password: `sb1.${"c".repeat(43)}.${"d".repeat(43)}` });
    assert.equal((await profiles.resolve()).name, "remote"); assert.equal((await profiles.resolve("local")).name, "local");
  } finally { await local.close(); await rm(directory, { recursive: true, force: true }); }
});

test("the README command reference covers every option in CLI help", async () => {
  const child = spawn(process.execPath, [resolve("dist/src/cli.js"), "--help"], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let help = ""; child.stdout!.on("data", data => help += data); child.stderr!.resume();
  assert.equal(await new Promise<number | null>(r => child.once("exit", r)), 0);
  const readme = await readFile("README.md", "utf8");
  for (const option of new Set(help.match(/--[a-z][a-z-]+/g))) assert.ok(readme.includes(option), `README is missing ${option}`);
  for (const command of ["run", "server", "worker", "install", "chat", "login", "configure", "mcp"]) assert.ok(readme.includes(`sideband ${command}`), `README is missing ${command}`);
});

test("local profiles preserve an existing default, persist their own default and plugin setup retries failures", { timeout: testTimeout(30000) }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "sideband-local-setup-")), server = await RoomServer.start({ host: "127.0.0.1", port: 0 });
  const profile = { server: `127.0.0.1:${server.port}`, password: server.password }, local = await LocalRun.claim(directory, true);
  assert.ok(local);
  try {
    const profiles = new RoomProfiles(directory);
    assert.equal(await local.profile(profile), "local"); assert.equal((await profiles.resolve()).name, "local");
    await profiles.save("another", { ...profile, server: "127.0.0.1:1234" }); await profiles.setDefault("another");
    assert.equal(await local.profile({ ...profile, server: "127.0.0.1:1235" }), "another", "matching credentials identify the same server");
    const other = { ...profile, password: `sb1.${"a".repeat(43)}.${"b".repeat(43)}` };
    await profiles.save("default", other); assert.equal((await profiles.resolve()).name, "default", "an explicit login saved as default selects that server");
    await local.profile(profile); assert.deepEqual((await profiles.resolve()).profile, { ...other, server: `wss://127.0.0.1:${server.port}/ws` });
    assert.equal(await LocalRun.claim(directory, true), undefined);
    await local.offerPlugins({ interactive: false }); await assert.rejects(readFile(join(directory, "local-setup.json")), "non-interactive startup must leave setup pending");
    let attempts = 0, choices = 0;
    const options = { interactive: true, detect: async () => [{ harness: "pi" as const, version: "fixture" }], choose: async () => { choices++; return "1"; }, install: async () => ({ harness: "pi" as const, state: ++attempts === 1 ? "failed" as const : "installed" as const, message: "fixture" }) };
    await local.offerPlugins(options); await assert.rejects(readFile(join(directory, "local-setup.json")));
    await local.offerPlugins(options); await local.offerPlugins(options); assert.equal(attempts, 2); assert.equal(choices, 2);
    await rm(join(directory, "local-setup.json"));
    await local.offerPlugins({ ...options, choose: async () => "" }); await local.offerPlugins(options);
    assert.equal(attempts, 2, "an explicit skip is remembered without installing anything");
  } finally { await local.close(); await server.close(); await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
});

test("an exited local process does not leave a stale instance that prevents restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sideband-local-crash-"));
  const child = spawn(process.execPath, ["-e", "process.exit(0)"], { windowsHide: true, stdio: "ignore" });
  const pid = child.pid!; await new Promise<void>(r => child.once("exit", () => r()));
  const file = join(directory, "local-run.json"), lock = `${file}.lock`;
  await writeFile(file, JSON.stringify({ pid })); await mkdir(lock); const old = new Date(Date.now() - 20000); await utimes(lock, old, old);
  let local: LocalRun | undefined;
  try { local = await LocalRun.claim(directory, true); assert.ok(local); }
  finally { await local?.close(); await rm(directory, { recursive: true, force: true }); }
});

test("stopping during first-run installation cancels its child and leaves setup retryable", { timeout: testTimeout(30000) }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "sideband-local-cancel-")), marker = join(directory, "installer-pid");
  const local = await LocalRun.claim(directory, true); assert.ok(local);
  const task = local.offerPlugins({ interactive: true, detect: async () => [{ harness: "pi", version: "fixture" }], choose: async () => "all",
    install: async (harness, run) => { await run!(process.execPath, ["-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)},String(process.pid));setInterval(()=>{},1000);`]); return { harness, state: "installed", message: "fixture" }; } }).then(() => undefined, error => error);
  try {
    await until(async () => !!await readFile(marker, "utf8").catch(() => ""));
    const pid = Number(await readFile(marker, "utf8")); await local.close(); assert.match(String(await task), /cancel|abort/i);
    await until(() => { try { process.kill(pid, 0); return false; } catch { return true; } });
    await assert.rejects(readFile(join(directory, "local-setup.json")));
  } finally { await local.close(); await task; await rm(directory, { recursive: true, force: true }); }
});

test("run stays foreground, publishes a local worker without logging passwords, and repeat invocations do not duplicate it", { timeout: testTimeout(45000) }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "sideband-run-cli-")), entry = resolve("dist/src/cli.js");
  const args = [entry, "run", "--no-browser", "--port", "0", "--status-port", "0"], env = { ...process.env, SIDEBAND_STATE_DIR: directory };
  const child = spawn(process.execPath, args, { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"] });
  let log = "", ended = false; child.stdout!.on("data", data => log += data); child.stderr!.on("data", data => log += data);
  const exit = new Promise<void>(r => child.once("exit", () => { ended = true; r(); }));
  try {
    await until(() => /Worker connected and registered/.test(log), "local CLI did not start"); assert.equal(ended, false);
    assert.match(log, /http:\/\/127\.0\.0\.1:\d+\/chat/); assert.doesNotMatch(log, /sb1\.|local-login=/);
    const saved = await new RoomProfiles(directory).resolve(); assert.equal(saved.name, "local");
    const second = spawn(process.execPath, args, { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }); let secondLog = "";
    second.stdout!.on("data", data => secondLog += data); second.stderr!.on("data", data => secondLog += data);
    const code = await new Promise<number | null>(r => second.once("exit", r)); assert.equal(code, 0); assert.match(secondLog, /already running/);
    child.send({ type: "sideband.shutdown" }); await until(() => ended); await exit; assert.equal(child.exitCode, 0); assert.match(log, /Stopped server and worker/);
    const invalid = spawn(process.execPath, [entry, "run", "--host", "0.0.0.0"], { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }); let error = ""; invalid.stderr!.on("data", data => error += data);
    assert.equal(await new Promise<number | null>(r => invalid.once("exit", r)), 1); assert.match(error, /localhost-only/);
  } finally { if (!ended) { if (child.connected) child.send({ type: "sideband.shutdown" }); else child.kill(); await until(() => ended); } await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
});
