import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import NodeWebSocket from "ws";
import { AgentStore, Registry, requireNodeVersion, type SavedAgent } from "../src/persistence.js";
import { AgentKeys } from "../src/room-protocol.js";
import { RoomClient } from "../src/room-client.js";
import { AgentRunner } from "../src/agent-runner.js";
import { Worker } from "../src/worker.js";
import { RoomServer } from "../src/room-server.js";
import { BrowserRoomClient } from "../src/browser-protocol.js";
import type { ControlSnapshot, OutputSnapshot } from "../src/orchestration-protocol.js";
import { testTimeout } from "./waits.js";

async function until(check: () => boolean | Promise<boolean>, ms = testTimeout(15000)) {
  const end = Date.now() + ms; while (!await check()) { if (Date.now() > end) throw new Error("Persistence fixture did not settle."); await new Promise(resolve => setTimeout(resolve, 25)); }
}
test("SQLite has isolated metadata scopes, transactional writes, private files and compatible forward schemas", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sideband-store-")), file = join(directory, "registry.sqlite");
  let first: Registry | undefined, second: Registry | undefined;
  try {
    for (const version of ["22.0.0", "22.12.9", "23.3.0", "invalid"]) assert.throws(() => requireNodeVersion(version), /Upgrade Node/);
    for (const version of ["22.13.0", "22.22.2", "23.4.0", "24.0.0"]) requireNodeVersion(version);
    first = await Registry.open(file, "one"); second = await Registry.open(file, "two");
    await first.change(() => first!.put("agent", "id", { session: "saved", value: 1 }));
    await second.change(() => second!.put("agent", "id", { session: "other" }));
    await assert.rejects(first.change(() => { first!.put("agent", "id", { value: 2 }); throw new Error("rollback"); }), /rollback/);
    assert.deepEqual(first.get("agent", "id"), { session: "saved", value: 1 }); assert.deepEqual(second.get("agent", "id"), { session: "other" });
    const { DatabaseSync } = await import("node:sqlite");
    const locked = new DatabaseSync(file); locked.exec("BEGIN IMMEDIATE"); let finished = false;
    const write = first.change(() => first!.put("agent", "another", { saved: true })).then(() => { finished = true; });
    await new Promise(resolve => setTimeout(resolve, 100)); assert.equal(finished, false); assert.deepEqual(second.get("agent", "id"), { session: "other" });
    locked.exec("ROLLBACK"); locked.close(); await write;
    if (process.platform !== "win32") assert.equal((await stat(file)).mode & 0o777, 0o600);
    await first.close(); first = undefined; await second.close(); second = undefined;
    let raw = new DatabaseSync(file); raw.exec("PRAGMA user_version=2"); raw.close();
    first = await Registry.open(file, "one"); assert.deepEqual(first.get("agent", "id"), { session: "saved", value: 1 }); await first.close(); first = undefined;
    raw = new DatabaseSync(file); assert.equal(raw.prepare("PRAGMA user_version").get()!.user_version, 2); raw.exec("UPDATE schema_compat SET min_reader=2"); raw.close();
    await assert.rejects(Registry.open(file, "one"), /requires a newer runtime/);
    raw = new DatabaseSync(file); assert.equal(raw.prepare("PRAGMA user_version").get()!.user_version, 2); raw.close();
  } finally { await first?.close(); await second?.close(); assert.ok(directory.startsWith(join(tmpdir(), "sideband-store-"))); await rm(directory, { recursive: true, force: true }); }
});

test("saved identities survive credential rotation; leases reject duplicates and detect PID reuse without stealing a stalled live controller", async () => {
  const root = await mkdtemp(join(tmpdir(), "sideband-leases-"));
  const profile = { server: "example.invalid", password: "unused" };
  const first = await AgentStore.open(root, profile), second = await AgentStore.open(root, { ...profile, password: "rotated" });
  const id = randomUUID(), keys = new AgentKeys("test");
  const record: SavedAgent = { agent: { id, machineId: randomUUID(), machineName: "machine", name: "test", harness: "omp", room: "", state: "stopped", online: false, persistent: true, createdAt: Date.now() }, privateKey: keys.exportPrivateKey(), session: "handle", workspaceReady: true, desired: "stopped", updatedAt: Date.now() };
  try {
    await first.claim(record, "one", false); assert.equal(second.get(id)!.session, "handle");
    assert.equal(new AgentKeys("test", second.get(id)!.privateKey).identity.id, keys.identity.id);
    await assert.rejects(second.claim(record, "two", true), /running controller/);
    await first.registry.change(() => { const lease = first.registry.get<any>("lease", id); first.registry.put("lease", id, { ...lease, at: 0 }); });
    assert.equal(await second.live(id), true, "stale heartbeat alone must not steal a live controller");
    await first.registry.change(() => { const lease = first.registry.get<any>("lease", id); first.registry.put("lease", id, { ...lease, started: "a previous process using this PID", at: 0 }); });
    assert.equal(await second.live(id), false);
    await second.claim(record, "two", true); await assert.rejects(first.checkpoint(record, "one"), /no longer owns/); await assert.rejects(first.heartbeat(id, "one"), /no longer owns/);
    await second.desired(id, "archived"); assert.equal(await second.checkpoint({ ...record, desired: "running" }, "two", "running"), "archived");
    await second.release(id, "two");
  } finally { await first.close(); await second.close(); assert.ok(root.startsWith(join(tmpdir(), "sideband-leases-"))); await rm(root, { recursive: true, force: true }); }
});

const omp = `import {createInterface} from 'node:readline';import{mkdir,readFile,appendFile}from'node:fs/promises';import{join}from'node:path';
if(process.argv.includes('--version')){console.log('fixture 1');process.exit(0)}
const args=process.argv,dir=args[args.indexOf('--session-dir')+1];await mkdir(dir,{recursive:true});const file=join(dir,'history.jsonl');
const out=x=>console.log(JSON.stringify(x));if(args.includes('--resume')){if(args[args.indexOf('--resume')+1]!==file)throw Error('wrong saved handle');out({type:'notice',message:'RESTORED '+await readFile(file,'utf8')})}out({type:'ready'});
let q=Promise.resolve();createInterface({input:process.stdin}).on('line',line=>{q=q.then(async()=>{const f=JSON.parse(line);out({type:'response',id:f.id,success:true,data:f.type==='get_state'?{sessionFile:file,isStreaming:false}:{}});if(f.type==='prompt'){await appendFile(file,f.message+'\\n');out({type:'message_update',assistantMessageEvent:{type:'text_delta',delta:f.message}});out({type:'agent_end',isTerminal:true})}})}).on('close',()=>process.exit(0));`;
function browser(server: RoomServer) { const origin = `http://127.0.0.1:${server.statusPort}`; return new BrowserRoomClient(`ws://127.0.0.1:${server.statusPort}/browser-ws`, server.password, "controller", undefined, url => new NodeWebSocket(url, { origin }) as unknown as WebSocket); }

test("server and worker restarts retain resumable agents, identity, files and archive state without copying harness history", { timeout: testTimeout(60000) }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "sideband-resume-")), root = join(directory, "workspaces"), databaseFile = join(directory, "server.sqlite"), credentialsFile = join(directory, "server.json"), fixture = join(directory, "omp.mjs");
  await writeFile(fixture, omp);
  const options = { host: "127.0.0.1", port: 0, statusPort: 0, databaseFile, credentialsFile };
  let server = await RoomServer.start(options), web = browser(server);
  let worker: Worker | undefined, runner: AgentRunner | undefined, store: AgentStore | undefined;
  const id = randomUUID();
  const startWorker = async () => { const executable = { command: process.execPath, args: [fixture] }; worker = new Worker({ profile: { server: `127.0.0.1:${server.port}`, password: server.password }, root, entry: resolve("dist/src/cli.js"), omp: executable, codex: executable, claude: executable }); await worker.start(); };
  const list = () => web.request<ControlSnapshot>("control.list");
  const action = (action: string, params = {}) => web.request("control.action", { agentId: id, action, ...params });
  const logs = () => web.request<OutputSnapshot>("control.watch", { agentId: id });
  try {
    await web.connect(); await startWorker();
    const machineId = worker!.machine.id, profile = { server: `127.0.0.1:${server.port}`, password: server.password };
    store = await AgentStore.open(root, profile);
    runner = new AgentRunner({ profile, id, root, machineId, machineName: "fixture", spec: { name: "saved", harness: "omp", room: "project", prompt: "FIRST" }, omp: { command: process.execPath, args: [fixture] } });
    await runner.start(); await until(() => runner!.agent.state === "idle" && runner!.output.snapshot().events.some(event => event.text === "FIRST"));
    const identity = runner.client.identity.id, workspace = join(root, id, "workspace"); await writeFile(join(workspace, "keep.txt"), "preserved");
    await action("stop"); await runner.close(); runner = undefined; await worker!.close(); worker = undefined;
    web.disconnect(); await server.close(); server = await RoomServer.start(options); web = browser(server); await web.connect();
    const offline = (await list()).agents.find(agent => agent.id === id)!;
    assert.equal(offline.online, false); assert.equal(offline.state, "stopped"); assert.equal(offline.canResume, true);
    assert.equal((await list()).machines[0]!.online, false);
    const impostor = new RoomClient({ server: `127.0.0.1:${server.port}`, password: server.password }, "saved");
    try { await impostor.connect(); await assert.rejects(impostor.request("control.runner", { agent: offline }), /another verified identity/); } finally { await impostor.close(); }
    await startWorker(); assert.equal(worker!.machine.id, machineId);
    await action("resume"); await until(async () => (await list()).agents.some(agent => agent.id === id && agent.online && agent.state === "idle"));
    assert.equal((await list()).agents.find(agent => agent.id === id)!.identityId, identity);
    assert.ok((await logs()).events.some(event => event.text.includes("RESTORED FIRST")));
    await action("prompt", { text: "SECOND" }); await until(async () => (await logs()).events.some(event => event.kind === "assistant" && event.text.includes("SECOND")));
    assert.equal(await readFile(join(workspace, "keep.txt"), "utf8"), "preserved");
    const history = await readFile(join(root, id, "sessions", "history.jsonl"), "utf8"); assert.equal(history.split("FIRST").length - 1, 1); assert.match(history, /earlier turn may have been interrupted/);
    assert.ok(store.get(id)!.session); assert.equal(JSON.stringify(store.get(id)).includes("FIRST"), false, "Sideband stores no copied conversation or launch prompt");
    await action("archive"); await until(async () => !await store!.live(id));
    await worker!.close(); worker = undefined; web.disconnect(); await server.close(); server = await RoomServer.start(options); web = browser(server); await web.connect();
    assert.equal((await list()).agents.find(agent => agent.id === id)!.archived, true);
    await store.desired(id, "running"); // stale pre-archive worker row must not resurrect the server's archived agent.
    await startWorker(); await until(() => store!.get(id)!.desired === "archived"); assert.equal((await list()).agents.find(agent => agent.id === id)!.archived, true);
    const staleArchived = { ...(await list()).agents.find(agent => agent.id === id)! };
    await action("resume"); await until(async () => (await list()).agents.some(agent => agent.id === id && agent.online && !agent.archived && agent.state === "idle"));
    await worker!.client.request("control.inventory", { agents: [staleArchived] });
    assert.equal((await list()).agents.find(agent => agent.id === id)!.archived, false, "a stale worker snapshot cannot archive a live resumed runner");
    assert.equal((await list()).agents.find(agent => agent.id === id)!.identityId, identity);
    await action("archive"); await until(async () => !await store!.live(id));
    await worker!.close(); worker = undefined; web.disconnect(); await server.close(); server = await RoomServer.start({ ...options, rotatePassword: true }); web = browser(server); await web.connect();
    await startWorker(); assert.equal(worker!.machine.id, machineId); assert.equal((await list()).agents.find(agent => agent.id === id)!.archived, true, "credential rotation preserves the fleet index");
    await action("resume"); await until(async () => (await list()).agents.some(agent => agent.id === id && agent.online && agent.state === "idle"));
    assert.equal((await list()).agents.find(agent => agent.id === id)!.identityId, identity);
    await action("archive"); await until(async () => !await store!.live(id));
    assert.ok(workspace.startsWith(directory)); await rename(workspace, `${workspace}-retained`);
    await (worker as unknown as { syncInventory(): Promise<void> }).syncInventory();
    const missing = (await list()).agents.find(agent => agent.id === id)!; assert.equal(missing.canResume, false); assert.match(missing.error!, /workspace is missing/);
    await assert.rejects(action("resume"), /workspace is missing/); assert.equal(await readFile(join(`${workspace}-retained`, "keep.txt"), "utf8"), "preserved");
  } finally {
    await runner?.close(); await action("archive").catch(() => {}); await worker?.close();
    if (store) { await until(async () => !await store!.live(id)).catch(() => {}); await store.close(); }
    web.disconnect(); await server.close();
    assert.ok(directory.startsWith(join(tmpdir(), "sideband-resume-"))); await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});
