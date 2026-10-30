// Optional smoke check with a real OMP executable. All host state stays in an isolated directory.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, copyFile, writeFile, cp, rm } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join, resolve, relative } from "node:path";
import { createServer } from "node:http";

const { RoomServer } = await import("../dist/src/room-server.js");
const { RoomClient } = await import("../dist/src/room-client.js");
const { RoomProfiles } = await import("../dist/src/room-profiles.js");

const executable = process.env.OMP_BINARY ?? "omp";
const root = resolve(import.meta.dirname, "..");
const directory = await mkdtemp(join(tmpdir(), "sideband-omp-install-"));
const cwd = join(directory, "work");
const env = { ...process.env, PI_CONFIG_DIR: relative(homedir(), join(directory, "config")), PI_CODING_AGENT_DIR: join(directory, "agent"),
  XDG_DATA_HOME: join(directory, "data"), XDG_STATE_HOME: join(directory, "state"), XDG_CACHE_HOME: join(directory, "cache"),
  OMP_PROFILE: "", PI_PROFILE: "", SIDEBAND_STATE_DIR: join(directory, "sideband"), PI_NO_TITLE: "1",
  NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost",
  OPENAI_API_KEY: "sideband-offline-smoke-placeholder" };
let child, server, peer, model;
let timer;
try {
  await mkdir(cwd);
  server = await RoomServer.start({ host: "127.0.0.1", port: 0 });
  const profile = { server: `127.0.0.1:${server.port}`, password: server.password };
  await new RoomProfiles(env.SIDEBAND_STATE_DIR).save("test", profile);
  peer = new RoomClient(profile, "peer", { proxyEnv: {} }); await peer.connect(); await peer.joinRoom("omp-smoke");
  let joined = false, replied = false, sawPush = false, receivedReply = false, failure;
  const marker = "Native push reached the idle OMP agent";
  peer.onMessage(message => { if (message.text === "Native OMP reply") receivedReply = true; });
  // Deterministic loopback-only model: exercise real tool dispatch and idle wake without a paid API.
  model = createServer(async (req, res) => {
    try {
      assert.equal(req.url, "/v1/chat/completions");
      let body = ""; for await (const part of req) body += part;
      const request = JSON.parse(body);
      const tools = request.tools.map(tool => tool.function);
      assert.ok(tools.find(tool => tool.name === "sideband_join_room").parameters.required.includes("name"));
      const context = JSON.stringify(request.messages);
      assert.ok(!context.includes(server.password), "server credentials never enter model context");
      assert.ok(context.includes("username chosen by the user"), "shared policy reaches the model");
      let delta, finish;
      if (!joined) {
        joined = true; delta = { role: "assistant", tool_calls: [{ index: 0, id: "join-call", type: "function", function: { name: "sideband_join_room", arguments: JSON.stringify({ room: "omp-smoke", name: "worker" }) } }] }; finish = "tool_calls";
      } else if (context.includes(marker) && !replied) {
        sawPush = true; replied = true;
        assert.ok(context.includes('<sideband sender=\\"peer\\">'), "native compact envelope reaches the model");
        delta = { role: "assistant", tool_calls: [{ index: 0, id: "send-call", type: "function", function: { name: "sideband_send", arguments: JSON.stringify({ text: "Native OMP reply" }) } }] }; finish = "tool_calls";
      } else { delta = { role: "assistant", content: "Done." }; finish = "stop"; }
      res.writeHead(200, { "content-type": "text/event-stream" });
      const chunk = (change, reason) => `data: ${JSON.stringify({ id: "smoke", object: "chat.completion.chunk", created: 1, model: "smoke", choices: [{ index: 0, delta: change, finish_reason: reason }] })}\n\n`;
      res.end(chunk(delta, null) + chunk({}, finish) + "data: [DONE]\n\n");
    } catch (error) { failure = error; res.writeHead(500); res.end("Offline fixture failed."); }
  });
  await new Promise(resolve => model.listen(0, "127.0.0.1", resolve));
  const modelUrl = `http://127.0.0.1:${model.address().port}/v1`;
  const pkg = join(directory, "package"); await mkdir(pkg);
  await mkdir(join(pkg, "dist"));
  for (const bundle of ["sideband-omp.cjs", "sideband.cjs"]) await copyFile(join(root, "dist", bundle), join(pkg, "dist", bundle));
  for (const name of [".claude-plugin", ".codex-plugin", "skills"]) await cp(join(root, name), join(pkg, name), { recursive: true });
  await copyFile(join(root, "package.json"), join(pkg, "package.json"));
  // Default to a local snapshot; optionally pass a Git install spec to exercise the public installer.
  const linked = spawnSync(executable, ["plugin", process.argv[2] ? "install" : "link", process.argv[2] ?? pkg],
    { cwd, env, encoding: "utf8", windowsHide: true, timeout: 90000 });
  if (linked.error) throw linked.error;
  assert.equal(linked.status, 0, linked.stderr || linked.stdout);
  const probe = join(directory, "probe.mjs");
  await writeFile(probe, `import assert from "node:assert/strict";
export default function(api) {
  api.registerProvider("sideband-smoke", { baseUrl: ${JSON.stringify(modelUrl)}, apiKey: "offline-fixture", api: "openai-completions",
    models: [{ id: "smoke", name: "Offline smoke fixture", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 1024 }] });
  api.registerCommand("sideband-install-check", { description: "Isolated smoke check", async handler(_args, ctx) {
    const names = api.getAllTools().map(tool => tool.name).filter(name => name.startsWith("sideband_"));
    assert.equal(names.length, 10, "native tools discovered once");
    assert.ok(api.getActiveTools().includes("sideband_join_room"), "room tools are available without discovery");
    console.log(JSON.stringify({ type: "sideband_smoke", session: !!ctx.sessionManager.getSessionId(), tools: names.length }));
  }});
}`);
  child = spawn(executable, ["--mode", "rpc", "--model", "sideband-smoke/smoke", "--no-ui", "--no-session", "--no-skills", "--no-rules", "--no-title", "--no-lsp", "--no-tools", "-e", probe],
    { cwd, env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  let stderr = ""; child.stderr.setEncoding("utf8"); child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-4000); });
  await new Promise((resolve, reject) => {
    let buffer = "", checked = false, pushed = false;
    timer = setTimeout(() => reject(failure ?? new Error(`OMP smoke check timed out. ${stderr}`)), 30000);
    child.once("error", reject);
    child.once("exit", code => { if (!checked || code !== 0) reject(new Error(`OMP exited (${code}). ${stderr}`)); else resolve(); });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", chunk => {
      buffer += chunk;
      while (buffer.includes("\n")) {
        const end = buffer.indexOf("\n"), line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        let frame; try { frame = JSON.parse(line); } catch { continue; }
        try {
          if (frame.type === "ready") child.stdin.write(JSON.stringify({ id: "commands", type: "get_available_commands" }) + "\n");
          if (frame.id === "commands" && frame.type === "response") {
            assert.equal(frame.success, true, JSON.stringify(frame));
            const commands = frame.data.commands.filter(command => command.name === "sideband");
            assert.equal(commands.length, 1, "native /sideband command discovered once");
            child.stdin.write(JSON.stringify({ id: "check", type: "prompt", message: "/sideband-install-check" }) + "\n");
          }
          if (frame.type === "sideband_smoke") {
            assert.equal(frame.session, true); assert.equal(frame.tools, 10);
            child.stdin.write(JSON.stringify({ id: "join", type: "prompt", message: "Join omp-smoke with my chosen username worker." }) + "\n");
          }
          if (frame.type === "agent_end" && joined && !pushed) {
            pushed = true; peer.send(marker).catch(reject);
          } else if (frame.type === "agent_end" && pushed && sawPush) {
            if (failure) throw failure;
            assert.equal(receivedReply, true, "real native send tool reaches the peer");
            checked = true; child.stdin.end();
          }
          if (frame.id === "check" && frame.success === false) throw new Error(JSON.stringify(frame));
        } catch (error) { reject(error); }
      }
    });
  });
  console.log("Real OMP: isolated plugin discovery, native command/tools, model tool dispatch, signed room join, idle push wake, compact context and explicit reply passed (offline model fixture).");
} finally {
  clearTimeout(timer);
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill(); await new Promise(resolve => child.once("exit", resolve));
  }
  await peer?.close(); await server?.close();
  if (model) { model.closeAllConnections(); await new Promise(resolve => model.close(resolve)); }
  if (!directory.startsWith(join(tmpdir(), "sideband-omp-install-"))) throw new Error("Unsafe OMP test directory.");
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
