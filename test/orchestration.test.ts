import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createServer } from "node:https";
import { generate } from "selfsigned";
import NodeWebSocket from "ws";
import { RoomServer } from "../src/room-server.js";
import { RoomClient } from "../src/room-client.js";
import { BrowserRoomClient } from "../src/browser-protocol.js";
import { launchSpec, OutputBuffer, type ControlSnapshot, type OutputSnapshot } from "../src/orchestration-protocol.js";
import { AgentRunner } from "../src/agent-runner.js";

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check: () => boolean | Promise<boolean>, ms = 15000) {
  const end = Date.now() + ms;
  while (!(await check())) { if (Date.now() > end) throw new Error("Orchestration condition timed out."); await pause(25); }
}
function browser(server: RoomServer) {
  const origin = `http://127.0.0.1:${server.statusPort}`;
  return new BrowserRoomClient(`ws://127.0.0.1:${server.statusPort}/browser-ws`, server.password, "controller", undefined,
    url => new NodeWebSocket(url, { origin }) as unknown as WebSocket);
}
test("launch validation permits remote URLs and treats names, refs, models and prompts as data", () => {
  for (const repository of [undefined, "", "   "]) assert.equal(launchSpec({ name: "worker", harness: "omp", ...(repository === undefined ? {} : { repository }) }).repository, undefined);
  assert.throws(() => launchSpec({ name: "worker", harness: "omp", ref: "main" }), /repository is required/);
  for (const repository of ["https://github.com/example/repo.git", "git@github.com:example/repo.git", "ssh://git@example.org/project.git"]) assert.equal(launchSpec({ name: "worker", harness: "omp", repository }).repository, repository);
  for (const repository of ["C:\\work", "/tmp/work", "file:///tmp/work", "ext::evil", "--upload-pack=evil", "https://user:password@example.org/repo", "https://user@example.org/repo", "https://example.org/repo\n--flag"]) {
    assert.throws(() => launchSpec({ name: "worker", harness: "omp", repository }));
  }
  assert.throws(() => launchSpec({ name: "", harness: "omp", repository: "https://example.org/repo" }));
  assert.throws(() => launchSpec({ name: "worker", harness: "omp", repository: "https://example.org/repo", ref: "--upload-pack=evil" }));
  assert.equal(launchSpec({ name: "worker", harness: "omp", repository: "https://example.org/repo", prompt: "Keep $(this) `literal`\nacross lines" }).prompt, "Keep $(this) `literal`\nacross lines");
});
test("output retention is bounded by event count and UTF-8 byte size, with monotonic cursors", () => {
  const buffer = new OutputBuffer(3, 1024);
  for (let index = 0; index < 8; index++) buffer.append("assistant", `message ${index}`);
  assert.deepEqual(buffer.snapshot().events.map(event => event.seq), [6, 7, 8]);
  assert.deepEqual(buffer.snapshot(7).events.map(event => event.seq), [8]);
  buffer.append("tool-output", "😀".repeat(10000));
  const snapshot = buffer.snapshot(); assert.equal(snapshot.next, 10); assert.equal(snapshot.events.at(-1)?.seq, 9);
  assert.ok(Buffer.byteLength(JSON.stringify(snapshot.events)) < 1024); assert.match(snapshot.events.at(-1)!.text, /truncated/);
});
test("control registration requires authentication; native room agents cannot launch or inspect machines", async () => {
  const server = await RoomServer.start({ host: "127.0.0.1", port: 0, statusPort: 0 });
  const client = new RoomClient({ server: `127.0.0.1:${server.port}`, password: server.password });
  const owner = new RoomClient({ server: `127.0.0.1:${server.port}`, password: server.password }, "owner");
  const impostor = new RoomClient({ server: `127.0.0.1:${server.port}`, password: server.password }, "impostor");
  const web = browser(server);
  try {
    await client.connect(); await web.connect();
    await assert.rejects(client.request("control.list"), /authenticated web panel/);
    await assert.rejects(web.request("control.worker", { machine: {} }), /native connection/);
    await assert.rejects(client.request("control.publish", { agent: {}, events: [] }), /Only an agent runner/);
    await assert.rejects(client.request("control.reply", { id: randomUUID(), result: {} }), /Unknown control command/);
    assert.deepEqual(await web.request("control.list"), { machines: [], agents: [], serverPort: server.port });
    await owner.connect(); await impostor.connect();
    const id = randomUUID(), machineId = randomUUID();
    const agent = { id, machineId, machineName: "fixture", name: "owner", harness: "omp", repository: "https://example.org/repo", state: "idle", room: "", createdAt: Date.now(), online: true };
    await assert.rejects(impostor.request("control.runner", { agent }), /authenticated room identity/);
    await owner.request("control.runner", { agent });
    await assert.rejects(impostor.request("control.runner", { agent: { ...agent, name: "impostor" } }), /another verified identity/);
    await client.request("control.worker", { machine: { id: machineId, name: "fixture", platform: "test", harnesses: ["omp"], online: true } });
    let commandId = "";
    client.onEvent((event, data) => { if (event === "control.command") commandId = data.id; });
    const launch = web.request("control.launch", { machineId, name: "new-agent", harness: "omp", repository: "https://example.org/repo" });
    await until(() => !!commandId);
    await assert.rejects(impostor.request("control.reply", { id: commandId, result: {} }), /Unknown control command/);
    await client.request("control.reply", { id: commandId, result: {} }); await launch;
  } finally { web.disconnect(); await client.close(); await owner.close(); await impostor.close(); await server.close(); }
});

test("forgetting an offline legacy runner uses its existing stop/dispose commands when it reconnects", async () => {
  const server = await RoomServer.start({ host: "127.0.0.1", port: 0, statusPort: 0 });
  const profile = { server: `127.0.0.1:${server.port}`, password: server.password }, legacy = new RoomClient(profile, "legacy", { reconnectMs: 250 });
  const web = browser(server), id = randomUUID(), commands: string[] = [];
  const agent = { id, machineId: randomUUID(), machineName: "machine", name: "legacy", harness: "omp", repository: "https://example.org/repo", room: "", state: "idle", createdAt: Date.now(), online: true };
  legacy.onConnected(async () => { await legacy.request("control.runner", { agent }); });
  legacy.onEvent((event, command) => {
    if (event !== "control.command") return;
    commands.push(command.method);
    void legacy.request("control.reply", { id: command.id, result: {} }).then(() => { if (command.method === "dispose") setTimeout(() => { void legacy.close(); }, 20); }).catch(() => {});
  });
  try {
    await legacy.connect(); await web.connect(); legacy.dropConnection();
    await until(async () => !(await web.request<ControlSnapshot>("control.list")).agents[0]?.online);
    await web.request("control.action", { agentId: id, action: "dispose" });
    await until(() => legacy.state === "off"); assert.deepEqual(commands, ["stop", "dispose"]);
    assert.equal((await web.request<ControlSnapshot>("control.list")).agents.length, 0);
  } finally { await legacy.close(); web.disconnect(); await server.close(); }
});

// A deterministic harness fixture, not a model API call. Exercises the actual process/RPC boundary.
const fixtureOmp = `import { createInterface } from "node:readline";
import { mkdir, appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";
if (process.argv.includes("--version")) { console.log("fixture-omp 1.0"); process.exit(0); }
const args = process.argv, sessionDir = args[args.indexOf("--session-dir") + 1];
await mkdir(sessionDir, {recursive:true}); const sessionFile = join(sessionDir,"session.jsonl");
const out = value => console.log(JSON.stringify(value));
const resume = args.includes("--resume");
if (resume) out({type:"notice",message:"Resumed saved history: " + await readFile(sessionFile,"utf8")});
out({type:"ready"});
createInterface({input:process.stdin}).on("line", async line => {
  const frame = JSON.parse(line);
  if (frame.type === "host_tool_result") { out({type:"agent_end",isTerminal:true}); return; }
  if (frame.type === "get_state") { out({type:"response",id:frame.id,success:true,data:{sessionFile,isStreaming:false}}); return; }
  out({type:"response",id:frame.id,success:true,data:{}});
  if (frame.type === "prompt") {
    await appendFile(sessionFile,frame.message+"\\n");
    out({type:"agent_start"});
    out({type:"message_update",assistantMessageEvent:{type:"text_delta",delta:"PID="+process.pid+"\\n"+frame.message}});
    if (frame.message === "announce" || frame.message.includes("reply please")) {
      out({type:"host_tool_call",id:"host-"+frame.id,toolName:"sideband_room_send",arguments:{text:frame.message === "announce" ? "fixture announcement" : "fixture reply"}});
    } else out({type:"agent_end",isTerminal:true});
  }
}).on("close",()=>process.exit(0));`;

test("an agent without a repository gets an empty workspace, joins a room and resumes with its files and history", { timeout: 20000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "sideband-empty-workspace-"));
  const server = await RoomServer.start({ host: "127.0.0.1", port: 0, statusPort: 0 });
  const profile = { server: `127.0.0.1:${server.port}`, password: server.password }, web = browser(server), peer = new RoomClient(profile, "peer");
  const fixture = join(directory, "omp.mjs"); await writeFile(fixture, fixtureOmp);
  const runner = new AgentRunner({ profile, id: randomUUID(), machineId: randomUUID(), machineName: "empty-test", root: directory,
    spec: { name: "no-repository", harness: "omp", room: "empty-room", prompt: "announce" }, omp: { command: process.execPath, args: [fixture] } });
  const received: string[] = []; peer.onMessage(message => received.push(message.text));
  try {
    await web.connect(); await peer.connect(); await peer.joinRoom("empty-room"); await runner.start();
    await until(() => received.includes("fixture announcement") && runner.agent.state === "idle");
    const workspace = join(directory, runner.agent.id, "workspace");
    assert.equal(runner.agent.repository, undefined); assert.equal(runner.agent.canResume, true);
    assert.equal((await stat(workspace)).isDirectory(), true); await assert.rejects(stat(join(workspace, ".git")), { code: "ENOENT" });
    assert.ok(!runner.output.snapshot().events.some(event => event.kind === "git"));
    await writeFile(join(workspace, "notes.txt"), "keep this workspace");
    const action = (action: string, params = {}) => web.request("control.action", { agentId: runner.agent.id, action, ...params });
    await action("stop"); await action("resume"); await action("prompt", { text: "continued after resume" });
    await until(() => runner.output.snapshot().events.some(event => event.text.includes("continued after resume")));
    assert.equal(await readFile(join(workspace, "notes.txt"), "utf8"), "keep this workspace");
    assert.ok(runner.output.snapshot().events.some(event => event.text.includes("Resumed saved history: announce")));
  } finally { await runner.close(); web.disconnect(); await peer.close(); await server.close(); assert.ok(directory.startsWith(join(tmpdir(), "sideband-empty-workspace-"))); await rm(directory, { recursive: true, force: true }); }
});

test("detached OMP runner: remote clone, pushed rooms, output, worker death/restart, controller restart and manual resume", { timeout: 90000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "sideband-orchestration-"));
  const credentialsFile = join(directory, "server.json"), root = join(directory, "workspaces");
  let server = await RoomServer.start({ host: "127.0.0.1", port: 0, statusPort: 0, credentialsFile });
  const tlsPort = server.port, httpPort = server.statusPort;
  let web = browser(server), worker: ChildProcess | undefined;
  const peer = new RoomClient({ server: `127.0.0.1:${server.port}`, password: server.password }, "peer");
  let agentId = "", received: string[] = [], events: string[] = [];
  const source = join(directory, "source"), bare = join(directory, "repository.git");
  await mkdir(source);
  const git = (args: string[], cwd = directory) => { const result = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true }); assert.equal(result.status, 0, result.stderr); };
  git(["init", source]); await writeFile(join(source, "hello.txt"), "isolated repository fixture\n");
  git(["add", "."], source); git(["-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "fixture"], source);
  git(["clone", "--bare", source, bare]); git(["update-server-info"], bare);
  const tls = await generate([{ name: "commonName", value: "localhost" }], { keyType: "ec", curve: "P-256", extensions: [{ name: "subjectAltName", altNames: [{ type: 7, ip: "127.0.0.1" }] }] });
  const caFile = join(directory, "git-ca.pem"); await writeFile(caFile, tls.cert);
  const repository = createServer({ key: tls.private, cert: tls.cert }, (req, res) => {
    const path = decodeURIComponent(new URL(req.url!, "https://fixture.invalid").pathname);
    if (!path.startsWith("/repository.git/") || path.includes("..")) { res.writeHead(404); res.end(); return; }
    void readFile(join(bare, path.slice("/repository.git/".length))).then(data => { res.writeHead(200, { "Content-Type": "application/octet-stream" }); res.end(data); }).catch(() => { res.writeHead(404); res.end(); });
  });
  await new Promise<void>(resolve => repository.listen(0, "127.0.0.1", resolve));
  const address = repository.address(); assert.ok(address && typeof address !== "string");
  const repoUrl = `https://127.0.0.1:${address.port}/repository.git`;
  const fixture = join(directory, "omp.mjs"); await writeFile(fixture, fixtureOmp);
  const workerFile = join(directory, "worker.mjs");
  await writeFile(workerFile, `import {Worker} from ${JSON.stringify(new URL("../src/worker.js", import.meta.url).href)};
let data="";for await(const c of process.stdin)data+=c;
const worker=new Worker(JSON.parse(data));await worker.start();console.log("ready");`);
  const startWorker = async () => {
    worker = spawn(process.execPath, [workerFile], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true, env: { ...process.env, GIT_SSL_CAINFO: caFile, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(directory, "no-global-config") } });
    const child = worker; let stderr = ""; child.stderr!.on("data", chunk => { stderr += chunk; });
    const ready = new Promise<void>((resolve, reject) => { child.stdout!.once("data", () => resolve()); child.once("error", reject); child.once("exit", () => reject(new Error(`Worker exited: ${stderr}`))); });
    child.stdin!.end(JSON.stringify({ profile: { server: `127.0.0.1:${tlsPort}`, password: server.password }, entry: resolve("dist/src/cli.js"), root, name: "test-machine", omp: { command: process.execPath, args: [fixture] } }));
    await ready;
  };
  const list = () => web.request<ControlSnapshot>("control.list");
  const action = (action: string, params = {}) => web.request("control.action", { agentId, action, ...params });
  const logs = () => web.request<OutputSnapshot>("control.watch", { agentId });
  try {
    await web.connect(); await peer.connect(); await peer.joinRoom("managed-room"); peer.onMessage(message => received.push(message.text));
    web.onControl = (type, data) => { if (type === "control.output") events.push(...data.events.map((event: any) => event.text)); };
    await startWorker();
    const machine = (await list()).machines[0]!; assert.equal(machine.online, true);
    agentId = (await web.request<{ id: string }>("control.launch", { machineId: machine.id, name: "managed", harness: "omp", repository: repoUrl, room: "managed-room", prompt: "announce" })).id;
    await until(async () => (await list()).agents.some(agent => agent.id === agentId && agent.state === "idle"));
    await until(() => received.includes("fixture announcement"));
    assert.equal(await readFile(join(root, agentId, "repo", "hello.txt"), "utf8"), "isolated repository fixture\n");
    const initial = await logs(); assert.ok(initial.events.some(event => event.text.includes("PID=")));
    const initialPid = initial.events.find(event => event.text.includes("PID="))!.text.match(/PID=(\d+)/)![1];
    assert.equal((await list()).agents[0]?.prompt, undefined, "launch prompt is not retransmitted in agent status snapshots");
    await peer.send("reply please"); await until(() => received.includes("fixture reply"));
    assert.deepEqual(received.filter(text => !text.startsWith("fixture")), [], "transcript and tool output never leak into room chat");
    await until(() => events.some(text => text.includes("reply please")));
    worker!.kill(); await until(async () => !(await list()).machines[0]?.online);
    await action("prompt", { text: "worker is gone" });
    await until(async () => (await logs()).events.some(event => event.text.includes(`PID=${initialPid}\nworker is gone`)));
    await startWorker(); await until(async () => (await list()).machines[0]?.online === true);
    assert.equal((await list()).machines[0]?.id, machine.id); assert.equal((await list()).agents.length, 1);
    web.disconnect(); await server.close();
    server = await RoomServer.start({ host: "127.0.0.1", port: tlsPort, statusPort: httpPort, credentialsFile });
    web = browser(server); await web.connect();
    await until(async () => { const state = await list(); return state.machines[0]?.online === true && state.agents[0]?.online === true; }).catch(async error => {
      throw new Error(`${error.message}: ${JSON.stringify(await list())}; peer=${peer.state}/${peer.lastError}`);
    });
    await action("prompt", { text: "controller returned" });
    await until(async () => (await logs()).events.some(event => event.text.includes(`PID=${initialPid}\ncontroller returned`)));
    await action("stop"); await until(async () => (await list()).agents[0]?.state === "stopped");
    await assert.rejects(action("prompt", { text: "must fail while stopped" }), /Resume/);
    await action("resume");
    assert.ok((await logs()).events.some(event => event.text.includes("Resumed saved history:") && event.text.includes("announce")), "manual resume uses native persisted harness history");
    await action("prompt", { text: "after resume" });
    await until(async () => (await logs()).events.some(event => event.text.includes("after resume") && event.kind === "assistant"));
    const retained = join(root, agentId, "repo", "hello.txt");
    const finalOutput = await logs(), processId = Number(finalOutput.events.filter(event => event.kind === "assistant" && /PID=\d+/.test(event.text)).at(-1)!.text.match(/PID=(\d+)/)![1]);
    const identityId = (await list()).agents[0]!.identityId;
    const internals = server as unknown as { members: Map<string, { socket?: NodeWebSocket }> };
    internals.members.get(identityId!)!.socket!.terminate();
    await until(async () => (await list()).agents[0]?.online === false);
    const forgotten = await action("dispose") as { offline: boolean }; assert.equal(forgotten.offline, true); agentId = "";
    await until(async () => !(await list()).agents.length);
    await until(() => { try { process.kill(processId, 0); return false; } catch { return true; } });
    assert.equal((await list()).agents.length, 0, "forgotten runner shuts its harness down instead of re-registering");
    assert.ok((await stat(retained)).isFile(), "removing a runner does not delete its checkout");
  } finally {
    if (agentId) { await action("stop").catch(() => {}); await action("dispose").catch(() => {}); }
    worker?.kill(); web.disconnect(); await peer.close(); await server.close();
    await new Promise<void>(resolve => repository.close(() => resolve()));
    await pause(300);
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + (process.platform === "win32" ? "\\" : "/")));
    await rm(directory, { recursive: true, force: true });
  }
});
