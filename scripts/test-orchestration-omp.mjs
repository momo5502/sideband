// Real OMP, real Git clone and real web-control protocol, with a loopback-only model fixture.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join, resolve, relative } from "node:path";
import { spawnSync, execFileSync } from "node:child_process";
import { createServer as httpServer } from "node:http";
import { createServer as httpsServer } from "node:https";
import { generate } from "selfsigned";
import WebSocket from "ws";
import { RoomServer } from "../dist/src/room-server.js";
import { RoomClient } from "../dist/src/room-client.js";
import { BrowserRoomClient } from "../dist/src/browser-protocol.js";
import { Worker } from "../dist/src/worker.js";

const directory = await mkdtemp(join(tmpdir(), "sideband-orchestration-omp-"));
const browserCertificate = await generate([{ name: "commonName", value: "sideband.example.com" }], { keyType: "ec", curve: "P-256", algorithm: "sha256" });
let httpsReady = false;
const server = await RoomServer.start({ host: "127.0.0.1", port: 0, statusPort: 0, browserHttps: { domain: "sideband.example.com", directory: join(directory, "https"), httpPort: 0, httpsPort: 0,
  issue: async () => ({ key: browserCertificate.private, cert: browserCertificate.cert }), log: line => { if (line.startsWith("HTTPS ready")) httpsReady = true; } } });
const profile = { server: `127.0.0.1:${server.nativePort}`, password: server.password };
const peer = new RoomClient(profile, "peer");
const origin = `https://127.0.0.1:${server.nativePort}`;
const web = new BrowserRoomClient(`${origin.replace("https:", "wss:")}/browser-ws`, server.password, "human", undefined, url => new WebSocket(url, { origin, servername: "sideband.example.com", rejectUnauthorized: false }));
let worker, model, repository, agentId, failure, announced = false, replied = false;
const received = [];
async function until(check) {
  const deadline = Date.now() + 45000;
  while (!(await check())) { if (failure) throw failure; if (Date.now() > deadline) throw new Error("Real OMP orchestration timed out."); await new Promise(resolve => setTimeout(resolve, 50)); }
}
const action = (action, params = {}) => web.request("control.action", { agentId, action, ...params });
try {
  const root = resolve(import.meta.dirname, "..");
  Object.assign(process.env, {
    PI_CONFIG_DIR: relative(homedir(), join(directory, "config")), PI_CODING_AGENT_DIR: join(directory, "agent"),
    XDG_DATA_HOME: join(directory, "data"), XDG_STATE_HOME: join(directory, "state"), XDG_CACHE_HOME: join(directory, "cache"),
    OMP_PROFILE: "", PI_PROFILE: "", SIDEBAND_STATE_DIR: join(directory, "sideband"), PI_NO_TITLE: "1",
    NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost", OPENAI_API_KEY: "sideband-offline-fixture",
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(directory, "no-global-config"),
  });
  model = httpServer(async (req, res) => {
    try {
      let raw = ""; for await (const chunk of req) raw += chunk;
      const request = JSON.parse(raw), context = JSON.stringify(request.messages);
      assert.ok(request.tools.some(tool => tool.function.name === "sideband_room_send"), "managed host tool reaches the real model interface");
      if (process.env.SIDEBAND_SMOKE_LEGACY) assert.ok(!request.tools.some(tool => tool.function.name === "sideband_send"), "legacy room tools are hidden in managed mode");
      let delta, finish;
      if (!announced) {
        announced = true; finish = "tool_calls";
        delta = { role: "assistant", tool_calls: [{ index: 0, id: "announce", type: "function", function: { name: "sideband_room_send", arguments: JSON.stringify({ text: "Real OMP announcement" }) } }] };
      } else if (context.includes("wake-real-omp") && !replied) {
        replied = true; finish = "tool_calls";
        assert.ok(context.includes('<sideband sender=\\"peer\\">'), "compact room push reaches the model without polling");
        delta = { role: "assistant", tool_calls: [{ index: 0, id: "reply", type: "function", function: { name: "sideband_room_send", arguments: JSON.stringify({ text: "Real OMP reply" }) } }] };
      } else { delta = { role: "assistant", content: "Idle and ready." }; finish = "stop"; }
      const chunk = (change, reason) => `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "smoke", choices: [{ index: 0, delta: change, finish_reason: reason }] })}\n\n`;
      res.writeHead(200, { "Content-Type": "text/event-stream" }); res.end(chunk(delta, null) + chunk({}, finish) + "data: [DONE]\n\n");
    } catch (error) { failure = error; res.writeHead(500); res.end("Offline fixture failed."); }
  });
  await new Promise(resolve => model.listen(0, "127.0.0.1", resolve));
  const provider = join(directory, "provider.mjs");
  await writeFile(provider, `export default function(api) { api.registerProvider("sideband-smoke", {
    baseUrl: ${JSON.stringify(`http://127.0.0.1:${model.address().port}/v1`)}, apiKey: "offline", api: "openai-completions",
    models: [{id:"smoke",name:"Offline fixture",reasoning:false,input:["text"],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:32000,maxTokens:1024}]
  }); }`);
  const source = join(directory, "source"), bare = join(directory, "repository.git"); await mkdir(source);
  const git = (args, cwd = directory) => { const result = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true }); assert.equal(result.status, 0, result.stderr); };
  git(["init", source]); await writeFile(join(source, "fixture.txt"), "orchestration fixture\n"); git(["add", "."], source);
  git(["-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "fixture"], source);
  git(["clone", "--bare", source, bare]); git(["update-server-info"], bare);
  const tls = await generate([{ name: "commonName", value: "localhost" }], { keyType: "ec", curve: "P-256", extensions: [{ name: "subjectAltName", altNames: [{ type: 7, ip: "127.0.0.1" }] }] });
  const ca = join(directory, "ca.pem"); await writeFile(ca, tls.cert); process.env.GIT_SSL_CAINFO = ca;
  repository = httpsServer({ key: tls.private, cert: tls.cert }, (req, res) => {
    const path = decodeURIComponent(new URL(req.url, "https://fixture.invalid").pathname);
    if (!path.startsWith("/repo.git/") || path.includes("..")) { res.writeHead(404); res.end(); return; }
    void readFile(join(bare, path.slice("/repo.git/".length))).then(data => res.end(data)).catch(() => { res.writeHead(404); res.end(); });
  });
  await new Promise(resolve => repository.listen(0, "127.0.0.1", resolve));
  await peer.connect(); await peer.joinRoom("omp-orchestration"); peer.onMessage(message => received.push(message.text));
  await until(() => httpsReady); await web.connect();
  const extra = [];
  if (process.env.SIDEBAND_SMOKE_LEGACY) { const legacy = join(directory, "old-sideband.cjs"); await writeFile(legacy, execFileSync("git", ["show", `${process.env.SIDEBAND_SMOKE_LEGACY_REF ?? "c9b9c7d"}:dist/sideband-omp.cjs`], { cwd: root, windowsHide: true })); extra.push("-e", legacy); }
  worker = new Worker({ profile, entry: process.env.SIDEBAND_SMOKE_ENTRY ? resolve(process.env.SIDEBAND_SMOKE_ENTRY) : join(root, "dist/src/cli.js"), name: "real-omp-test", root: join(directory, "workspaces"),
    omp: { command: process.env.OMP_BINARY ?? "omp", args: [...extra, "-e", provider, "--no-lsp", "--no-skills", "--no-rules", "--no-tools"] } });
  await worker.start();
  agentId = (await web.request("control.launch", { machineId: worker.machine.id, name: "managed-omp", harness: "omp", ...(process.env.SIDEBAND_SMOKE_EMPTY ? {} : { repository: `https://127.0.0.1:${repository.address().port}/repo.git` }), ...(process.env.SIDEBAND_SMOKE_TERMINAL ? { terminal: true } : {}), model: "sideband-smoke/smoke", room: "omp-orchestration", prompt: "Announce that you are ready." })).id;
  const state = () => web.request("control.list");
  await until(async () => {
    const agent = (await state()).agents.find(agent => agent.id === agentId);
    if (agent?.state === "failed") throw new Error(agent.error + "\n" + JSON.stringify(await web.request("control.watch", { agentId })));
    return agent?.state === "idle" && received.includes("Real OMP announcement");
  });
  await worker.close(); // Independent runner must still receive room messages and wake the idle harness.
  await peer.send("wake-real-omp"); await until(() => received.includes("Real OMP reply"));
  await until(async () => (await web.request("control.watch", { agentId })).events.some(event => event.kind === "assistant" && event.text.includes("Idle and ready.")));
  const output = await web.request("control.watch", { agentId });
  assert.ok(output.events.some(event => event.kind === "assistant" && event.text.includes("Idle and ready.")), "real streamed output is available in the panel");
  await action("stop"); await action("resume"); await action("prompt", { text: "Still here?" });
  await until(async () => (await state()).agents.find(agent => agent.id === agentId)?.state === "idle");
  await action("stop"); await action("dispose"); agentId = undefined;
  console.log(`Real OMP: ${process.env.SIDEBAND_SMOKE_EMPTY ? "empty workspace" : "remote Git clone"}, browser launch, managed send tool, idle room push/reply, worker independence, output and manual resume passed.`);
} finally {
  if (agentId) { await action("stop").catch(() => {}); await action("dispose").catch(() => {}); }
  await worker?.close(); web.disconnect(); await peer.close(); await server.close();
  for (const listener of [model, repository]) if (listener) await new Promise(resolve => listener.close(resolve));
  await new Promise(resolve => setTimeout(resolve, 300));
  if (!relative(tmpdir(), directory).startsWith("sideband-orchestration-omp-")) throw new Error("Unsafe fixture cleanup path.");
  await rm(directory, { recursive: true, force: true });
}
