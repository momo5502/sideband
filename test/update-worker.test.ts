import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import WebSocket from "ws";
import { RoomServer } from "../src/room-server.js";
import { RoomProfiles } from "../src/room-profiles.js";
import { BrowserRoomClient } from "../src/browser-protocol.js";
import { RuntimeUpdater } from "../src/updater.js";
import type { ControlSnapshot } from "../src/orchestration-protocol.js";

test("real worker supervisor installs an isolated candidate, refreshes fake harnesses, restarts and re-registers before server update", { timeout: 45000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "sideband-update-worker-")), target = "f".repeat(40), entry = resolve("dist/src/cli.js"), bin = join(directory, "bin");
  await mkdir(bin);
  // Only these isolated commands can run. No real npm or harness configuration is changed.
  const commands = join(bin, "commands.mjs");
  await writeFile(commands, `import {mkdir,writeFile,copyFile} from 'node:fs/promises';import {join} from 'node:path';
const [command,...args]=process.argv.slice(2);
if(command==='npm') {
 const prefix=args[args.indexOf('--prefix')+1],root=join(prefix,'node_modules','sideband');
 if(!args.includes('--ignore-scripts')||!args.includes('git+https://github.com/momo5502/sideband.git#${target}'))throw Error('unexpected install');
 await mkdir(join(root,'dist','src'),{recursive:true});await writeFile(join(root,'package.json'),JSON.stringify({name:'sideband',version:'99.0.0'}));
 await copyFile(${JSON.stringify(resolve("dist/sideband.cjs"))},join(root,'dist','src','cli.js'));
} else { if(command==='codex'&&args.shift()!=='--no-daemon')throw Error('Codex must not use the shared daemon');if(args.join(' ')!=='plugin list --json')throw Error('unexpected harness mutation');console.log(command==='omp'?'{"npm":[]}':command==='codex'?'{"installed":[]}':'[]'); }
`);
  for (const command of ["npm", "omp", "claude", "codex"]) {
    await writeFile(join(bin, command + (process.platform === "win32" ? ".cmd" : "")), process.platform === "win32" ? `@"${process.execPath}" "${commands}" ${command} %*\r\n` : `#!/bin/sh\nexec "${process.execPath}" "${commands}" ${command} "$@"\n`, { mode: 0o700 });
  }
  let serverStarted = false;
  const updater = new RuntimeUpdater("server", entry, join(directory, "server"), async () => {});
  updater.latest = async () => ({ version: "99.0.0", commit: target }); updater.start = () => { serverStarted = true; };
  const server = await RoomServer.start({ host: "127.0.0.1", port: 0, statusPort: 0, updater });
  const state = join(directory, "state"); await new RoomProfiles(state).save("selected", { server: `127.0.0.1:${server.port}`, password: server.password });
  const origin = `http://127.0.0.1:${server.statusPort}`;
  const web = new BrowserRoomClient(`ws://127.0.0.1:${server.statusPort}/browser-ws`, server.password, "update-controller", undefined, url => new WebSocket(url, { origin }) as unknown as globalThis.WebSocket);
  const pathKey = Object.keys(process.env).find(key => key.toLowerCase() === "path") ?? "PATH";
  const child = spawn(process.execPath, [entry, "worker", "--name", "fixture-worker", "--omp", process.execPath], {
    env: { ...process.env, [pathKey]: `${bin}${process.platform === "win32" ? ";" : ":"}${process.env[pathKey]}`, SIDEBAND_STATE_DIR: state }, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  });
  let log = ""; child.stdout.on("data", data => { log += data; }); child.stderr.on("data", data => { log += data; });
  const exited = new Promise(resolve => child.once("exit", resolve));
  const wait = async (check: () => Promise<boolean>) => { const end = Date.now() + 30000; while (!await check()) { if (Date.now() > end) throw new Error(`Worker update did not settle: ${log}`); await new Promise(resolve => setTimeout(resolve, 30)); } };
  try {
    await web.connect();
    await wait(async () => (await web.request<ControlSnapshot>("control.list")).machines.some(machine => machine.online));
    const original = (await web.request<ControlSnapshot>("control.list")).machines[0]!;
    await assert.rejects(web.request("control.updates.start", { command: "arbitrary" }), /Unexpected field/);
    await web.request("control.updates.check"); await web.request("control.updates.start");
    await wait(async () => serverStarted);
    const machine = (await web.request<ControlSnapshot>("control.list")).machines[0]!;
    assert.equal(machine.id, original.id); assert.equal(machine.build?.commit, target); assert.equal(machine.build.version, "99.0.0");
    assert.equal(machine.update?.phase, "done"); assert.equal(machine.update.plugins.length, 3); assert.ok(machine.update.plugins.every(plugin => plugin.state === "skipped"));
    assert.equal(child.exitCode, null); assert.ok(log.split("connected and registered").length >= 3, log);
    assert.match(log, /Sideband worker v[\d.]+ \(bootstrap\) starting/);
    assert.match(log, /Sideband worker v99\.0\.0 \(ffffffff\) starting/);
  } finally {
    child.kill(); await exited;
    await wait(async () => !(await web.request<ControlSnapshot>("control.list")).machines.some(machine => machine.online));
    web.disconnect(); await server.close();
    assert.ok(directory.startsWith(join(tmpdir(), "sideband-update-worker-"))); await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
