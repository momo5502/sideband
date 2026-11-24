import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rename, realpath, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import { browseFolders, existingFolder } from "../src/worker-folders.js";
import { launchSpec, type ControlSnapshot, type OutputSnapshot } from "../src/orchestration-protocol.js";
import { RoomServer } from "../src/room-server.js";
import { Worker } from "../src/worker.js";
import { BrowserRoomClient } from "../src/browser-protocol.js";
import { AgentStore } from "../src/persistence.js";
import { testTimeout } from "./waits.js";

async function until(check: () => boolean | Promise<boolean>) { const end = Date.now() + testTimeout(15000); while (!await check()) { if (Date.now() > end) throw new Error("Folder lifecycle did not settle"); await new Promise(r => setTimeout(r, 20)); } }
test("existing folders validate cross-machine input and browsing returns bounded directory-only pages", async () => {
  for (const folder of ["C:\\project", "\\\\server\\share\\project", "\\\\?\\C:\\project", "/home/user/project"]) assert.equal(launchSpec({ name: "a", harness: "omp", folder }).folder, folder);
  for (const folder of ["relative", "C:relative", "./project", "bad\0path"]) assert.throws(() => launchSpec({ name: "a", harness: "omp", folder }));
  assert.throws(() => launchSpec({ name: "a", harness: "omp", folder: "/project", repository: "https://example.com/repo.git" }), /either/);
  assert.throws(() => launchSpec({ name: "a", harness: "omp", folder: "/project", ref: "main" }), /repository is required/);
  const directory = await mkdtemp(join(tmpdir(), "sideband-folder-list-"));
  try {
    await Promise.all(Array.from({ length: 105 }, (_, i) => mkdir(join(directory, `folder-${String(i).padStart(3, "0")}`))));
    await writeFile(join(directory, "private-file.txt"), "contents never returned");
    const first = await browseFolders(directory), second = await browseFolders(directory, first.next);
    assert.equal(first.entries.length, 100); assert.equal(second.entries.length, 5); assert.equal(second.next, undefined);
    assert.equal(new Set([...first.entries, ...second.entries].map(entry => entry.path)).size, 105);
    assert.ok(!JSON.stringify(first).includes("private-file")); assert.equal(first.path, await realpath(directory));
    await assert.rejects(existingFolder(join(directory, "private-file.txt")), /not a folder/);
    await assert.rejects(existingFolder("relative"), /absolute/);
  } finally { assert.ok(directory.startsWith(join(tmpdir(), "sideband-folder-list-"))); await rm(directory, { recursive: true, force: true }); }
});

test("agents use external folders in place, share explicitly, recover sessions and preserve files on archive/failure", { timeout: testTimeout(60000) }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "sideband-existing-folder-")), root = join(directory, "agents"), folder = join(directory, "project & literal"), other = join(directory, "other"), fixture = join(directory, "omp.mjs");
  await mkdir(folder); await mkdir(other); await writeFile(join(folder, "keep.txt"), "original"); const mode = (await stat(folder)).mode;
  await writeFile(fixture, `import{createInterface}from'node:readline';import{mkdir,appendFile,readFile}from'node:fs/promises';import{join}from'node:path';
if(process.argv.includes('--version')){console.log('fixture');process.exit(0);}if(process.argv.includes('--no-session')){process.stderr.write('SIDEBAND_MODELS {"models":[]}\\n');process.exit(0);}
const args=process.argv,sessions=args[args.indexOf('--session-dir')+1],file=join(sessions,'history');await mkdir(sessions,{recursive:true});
const out=v=>console.log(JSON.stringify(v));if(args.includes('--resume'))out({type:'notice',message:'RESTORED '+await readFile(file,'utf8')});out({type:'ready'});
let q=Promise.resolve();createInterface({input:process.stdin}).on('line',line=>{q=q.then(async()=>{const v=JSON.parse(line);out({type:'response',id:v.id,success:true,data:v.type==='get_state'?{sessionFile:file,isStreaming:false}:{}});if(v.type==='prompt'){await appendFile(file,v.message+'\\n');out({type:'message_update',assistantMessageEvent:{type:'text_delta',delta:process.cwd()+' '+v.message}});out({type:'agent_end',isTerminal:true});}});}).on('close',()=>{q.finally(()=>process.exit(0));});`);
  const server = await RoomServer.start({ host: "127.0.0.1", port: 0, statusPort: 0 }), profile = { server: `127.0.0.1:${server.port}`, password: server.password }, origin = `http://127.0.0.1:${server.statusPort}`;
  const web = new BrowserRoomClient(`ws://127.0.0.1:${server.statusPort}/browser-ws`, server.password, "human", undefined, url => new WebSocket(url, { origin }) as unknown as globalThis.WebSocket);
  let worker: Worker | undefined, store: AgentStore | undefined; const ids: string[] = [];
  const start = async () => { worker = new Worker({ profile, root, entry: resolve("dist/src/cli.js"), omp: { command: process.execPath, args: [fixture] }, codex: { command: "sideband-not-installed" }, claude: { command: "sideband-not-installed" } }); await worker.start(); };
  const list = () => web.request<ControlSnapshot>("control.list"), action = (id: string, action: string) => web.request("control.action", { agentId: id, action });
  try {
    await web.connect(); await start(); await until(async () => (await list()).machines[0]?.folders === true); const machineId = worker!.machine.id;
    const browsing = await web.request<{ entries: { name: string }[] }>("control.folders", { machineId, path: directory }); assert.ok(browsing.entries.some(entry => entry.name === "project & literal"));
    const canonical = await realpath(folder);
    for (const name of ["first", "second"]) {
      const { id } = await web.request<{ id: string }>("control.launch", { machineId, name, harness: "omp", folder, prompt: "FIRST" }); ids.push(id);
      await until(async () => (await list()).agents.some(agent => agent.id === id && agent.state === "idle" && agent.canResume));
      await until(async () => (await web.request<OutputSnapshot>("control.watch", { agentId: id })).events.some(event => event.text.includes(`${canonical} FIRST`)));
      const output = await web.request<OutputSnapshot>("control.watch", { agentId: id }); assert.ok(!output.events.some(event => event.kind === "git"));
      assert.equal((await list()).agents.find(agent => agent.id === id)!.folder, await realpath(folder));
    }
    assert.deepEqual(await readdir(folder), ["keep.txt"]); assert.equal((await stat(folder)).mode, mode);
    store = await AgentStore.open(root, profile);
    for (const id of ids) await action(id, "archive"); await until(async () => !(await Promise.all(ids.map(id => store!.live(id)))).some(Boolean));
    await worker!.close(); await start();
    await action(ids[0]!, "resume"); await until(async () => (await list()).agents.find(agent => agent.id === ids[0])?.state === "idle");
    await until(async () => (await web.request<OutputSnapshot>("control.watch", { agentId: ids[0] })).events.some(event => event.text.includes("RESTORED FIRST")));
    await action(ids[0]!, "archive"); await until(async () => !await store!.live(ids[0]!));
    const moved = `${folder}-retained`; await rename(folder, moved); await symlink(other, folder, process.platform === "win32" ? "junction" : "dir");
    await (worker as unknown as { syncInventory(): Promise<void> }).syncInventory();
    const missing = (await list()).agents.find(agent => agent.id === ids[0])!; assert.equal(missing.canResume, false); assert.match(missing.error!, /different location/);
    await assert.rejects(action(ids[0]!, "resume"), /different location/);
    assert.equal(await readFile(join(moved, "keep.txt"), "utf8"), "original"); assert.deepEqual(await readdir(other), []);
    await assert.rejects(web.request("control.launch", { machineId, name: "bad", harness: "omp", folder: join(moved, "keep.txt") }), /not a folder/);
  } finally {
    for (const id of ids) await action(id, "archive").catch(() => {});
    if (store) { await until(async () => !(await Promise.all(ids.map(id => store!.live(id)))).some(Boolean)).catch(() => {}); await store.close(); }
    await worker?.close(); web.disconnect(); await server.close(); assert.ok(directory.startsWith(join(tmpdir(), "sideband-existing-folder-"))); await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});
