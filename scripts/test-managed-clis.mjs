import { STARTUP_TIMEOUT_MS, REQUEST_TIMEOUT_MS } from "../dist/src/timeouts.js";
// Real installed CLIs against loopback-only model fixtures. No account credentials or paid model calls.
// SIDEBAND_TEST_NATIVE=1 also opens real native windows; requires an interactive desktop (or tmux).
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import assert from "node:assert/strict";
import { ManagedCodex } from "../dist/src/managed-codex.js";
import { ManagedClaude } from "../dist/src/managed-claude.js";
import { ManagedClaudeNative } from "../dist/src/managed-claude-native.js";
import { trustClaudeWorkspaces } from "../dist/src/claude-trust.js";
process.chdir(fileURLToPath(new URL("..", import.meta.url)));
const directory = await mkdtemp(join(tmpdir(), "sideband-real-clis-"));
let sequence = 0, requests = 0, holds = 0, cancellations = 0;
const server = createServer(async (req, res) => {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  if (!req.url.includes("messages") && !req.url.includes("responses")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
    return;
  }
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    res.writeHead(400);
    res.end();
    return;
  }
  requests++;
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  const send = (type, data) => res.write("event: " + type + "\ndata: " + JSON.stringify({ type, ...data }) + "\n\n");
  const id = String(++sequence);
  const latest = (body.messages ?? body.input ?? []).at(-1);
  if (JSON.stringify(latest).includes("SIDEBAND_HOLD_STREAM")) {
    holds++;
    res.once("close", () => cancellations++);
    if (req.url.includes("messages")) send("message_start", { message: { id: "msg_" + id, type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 5, output_tokens: 0 } } });
    else send("response.created", { response: { id: "resp_" + id, object: "response", created_at: Math.floor(Date.now() / 1e3), model: body.model, status: "in_progress", output: [] } });
    return;
  }
  if (req.url.includes("messages")) {
    const last = body.messages.at(-1), tool = body.tools?.find((t) => t.name.includes("sideband_room_send")), hasResult = last?.role === "user" && Array.isArray(last.content) && last.content.some((p) => p.type === "tool_result");
    const block = tool && !hasResult ? { type: "tool_use", id: "toolu_" + id, name: tool.name, input: { text: "fixture room send" } } : { type: "text", text: "DONE" };
    send("message_start", { message: { id: "msg_" + id, type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 5, output_tokens: 0 } } });
    send("content_block_start", { index: 0, content_block: block.type === "tool_use" ? { ...block, input: {} } : { type: "text", text: "" } });
    send("content_block_delta", { index: 0, delta: block.type === "tool_use" ? { type: "input_json_delta", partial_json: JSON.stringify(block.input) } : { type: "text_delta", text: block.text } });
    send("content_block_stop", { index: 0 });
    send("message_delta", { delta: { stop_reason: block.type === "tool_use" ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } });
    send("message_stop", {});
  } else {
    const candidates = (body.tools ?? []).flatMap((t) => t.type === "namespace" ? (t.tools ?? []).map((inner) => ({ ...inner, namespace: t.name })) : [t]);
    const tool = candidates.find((t) => t.name?.includes("sideband_room_send")), last = body.input?.at(-1), hasResult = last?.type === "function_call_output";
    const item = tool && !hasResult ? { type: "function_call", id: "fc_" + id, call_id: "call_" + id, name: tool.name, ...tool.namespace ? { namespace: tool.namespace } : {}, arguments: JSON.stringify({ text: "fixture room send" }) } : { type: "message", id: "msg_" + id, role: "assistant", status: "completed", content: [{ type: "output_text", text: "DONE", annotations: [] }] };
    const response = { id: "resp_" + id, object: "response", created_at: Math.floor(Date.now() / 1e3), model: body.model, status: "in_progress", output: [] };
    send("response.created", { response });
    send("response.output_item.added", { output_index: 0, item: item.type === "function_call" ? { ...item, arguments: "" } : { ...item, status: "in_progress", content: [] } });
    if (item.type === "function_call") {
      send("response.function_call_arguments.delta", { output_index: 0, item_id: item.id, delta: item.arguments });
      send("response.function_call_arguments.done", { output_index: 0, item_id: item.id, arguments: item.arguments });
    } else {
      send("response.content_part.added", { output_index: 0, item_id: item.id, content_index: 0, part: { type: "output_text", text: "", annotations: [] } });
      send("response.output_text.delta", { output_index: 0, item_id: item.id, content_index: 0, delta: "DONE" });
      send("response.output_text.done", { output_index: 0, item_id: item.id, content_index: 0, text: "DONE" });
      send("response.content_part.done", { output_index: 0, item_id: item.id, content_index: 0, part: item.content[0] });
    }
    send("response.output_item.done", { output_index: 0, item });
    send("response.completed", { response: { ...response, status: "completed", output: [item], usage: { input_tokens: 5, output_tokens: 5, total_tokens: 10 } } });
  }
  res.end();
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = "http://127.0.0.1:" + server.address().port;
Object.assign(process.env, { CODEX_HOME: join(directory, "codex-home"), CLAUDE_CONFIG_DIR: join(directory, "claude-home"), ANTHROPIC_BASE_URL: base, ANTHROPIC_API_KEY: "sideband-local-fixture", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_TELEMETRY: "1", ENABLE_TOOL_SEARCH: "false", SIDEBAND_STATE_DIR: join(directory, "state") });
for (const key of ["ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_CUSTOM_OAUTH_URL", "ANTHROPIC_CUSTOM_HEADERS", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY"]) delete process.env[key];
await mkdir(process.env.CODEX_HOME, { recursive: true });
await mkdir(process.env.CLAUDE_CONFIG_DIR, { recursive: true });
await writeFile(join(process.env.CODEX_HOME, "config.toml"), 'model="sideband-smoke"\nmodel_provider="sideband_test"\n[model_providers.sideband_test]\nname="Sideband smoke"\nbase_url="' + base + '/v1"\nwire_api="responses"\nrequires_openai_auth=false\nsupports_websockets=false\n');
try {
  for (const [name, Type] of [...process.env.SIDEBAND_ONLY_NATIVE ? [] : [["codex", ManagedCodex], ["claude", ManagedClaude]], ...process.env.SIDEBAND_TEST_NATIVE ? [...process.env.SIDEBAND_ONLY_NATIVE ? [] : [["claude-native", ManagedClaudeNative]], ["codex-native", ManagedCodex]] : []]) {
    if (process.env.SIDEBAND_SMOKE_HARNESS && name !== process.env.SIDEBAND_SMOKE_HARNESS) continue;
    const cwd = join(directory, name);
    await mkdir(cwd);
    if (name === "claude-native") {
      await writeFile(join(process.env.CLAUDE_CONFIG_DIR, "settings.json"), JSON.stringify({ skipDangerousModePermissionPrompt: true }));
      await writeFile(join(process.env.CLAUDE_CONFIG_DIR, ".claude.json"), JSON.stringify({ hasCompletedOnboarding: true, theme: "dark", numStartups: 5, projects: {}, customApiKeyResponses: { approved: ["sideband-local-fixture", "sideband-local-fixture".slice(-20)], rejected: [] } }));
      await trustClaudeWorkspaces(directory, join(process.env.CLAUDE_CONFIG_DIR, ".claude.json"));
      assert.equal(JSON.parse(await readFile(join(process.env.CLAUDE_CONFIG_DIR, ".claude.json"), "utf8")).projects[cwd], undefined, "native startup must inherit trust from the workspace root");
    }
    const events = [], calls = [];
    let state = "starting", failure;
    const host = { event: (kind, text) => events.push({ kind, text }), state: (s) => {
      state = s;
    }, exit: (e) => {
      failure = e;
    }, tool: async (name2, args) => {
      calls.push({ name: name2, args });
      return { sent: true };
    } };
    let driver;
    try {
      driver = new Type({ command: name.endsWith("-native") ? name.split("-")[0] : name }, cwd, join(cwd, "sessions"), host, resolve("dist/src/cli.js"), ...name === "codex-native" ? [true] : []);
      await Promise.race([driver.start({ model: name.startsWith("claude") ? "sonnet" : "sideband-smoke" }), new Promise((_, reject) => {
        const timer = setTimeout(() => reject(Error("native startup still needs local confirmation")), STARTUP_TIMEOUT_MS);
        timer.unref();
      })]);
      if (name === "codex-native") {
        await new Promise((r) => setTimeout(r, 1500));
        if (failure) throw failure;
        const loaded = await driver.process.request("thread/loaded/list");
        assert.deepEqual(loaded.data, [driver.sessionFile]);
      }
      await driver.prompt("Announce readiness using sideband_room_send, then say DONE.");
      const end = Date.now() + REQUEST_TIMEOUT_MS;
      while (!(calls.length && state === "idle" && events.some((e) => e.kind === "assistant" && e.text.includes("DONE")))) {
        if (failure) throw failure;
        if (Date.now() > end) throw Error("model fixture timed out");
        await new Promise((r) => setTimeout(r, 50));
      }
      assert.equal(calls[0].name, "sideband_room_send");
      {
        const held = holds, cancelled = cancellations;
        await driver.prompt("SIDEBAND_HOLD_STREAM");
        const holdEnd = Date.now() + REQUEST_TIMEOUT_MS;
        while (holds === held) {
          if (failure) throw failure;
          if (Date.now() > holdEnd) throw Error("hold request never reached the local model");
          await new Promise((r) => setTimeout(r, 25));
        }
        await driver.interrupt();
        const interruptEnd = Date.now() + REQUEST_TIMEOUT_MS;
        while (state !== "idle" || cancellations === cancelled) {
          if (failure) throw failure;
          if (Date.now() > interruptEnd) throw Error("interrupt did not return to idle");
          await new Promise((r) => setTimeout(r, 25));
        }
        console.log(name + ": actual interrupt passed.");
      }
      const id = driver.sessionFile;
      await driver.stop();
      driver = new Type({ command: name.endsWith("-native") ? name.split("-")[0] : name }, cwd, join(cwd, "sessions"), host, resolve("dist/src/cli.js"), ...name === "codex-native" ? [true] : []);
      await driver.start({ resume: id, model: name.startsWith("claude") ? "sonnet" : "sideband-smoke" });
      assert.equal(driver.sessionFile, id);
      const count = calls.length;
      await driver.prompt("Announce readiness using sideband_room_send again, then say DONE.");
      const resumedEnd = Date.now() + REQUEST_TIMEOUT_MS;
      while (!(calls.length > count && state === "idle")) {
        if (failure) throw failure;
        if (Date.now() > resumedEnd) throw Error("resumed model fixture timed out");
        await new Promise((r) => setTimeout(r, 50));
      }
      console.log(name + ": actual CLI, local fake model, MCP room send, streamed text, idle and saved-session resume passed.");
    } catch (error) {
      console.log(name + ": " + error.message);
      console.log({ state, holds, cancellations });
      console.log(events.slice(-10));
      if (name === "claude-native" && driver.transcript?.path) console.log((await readFile(driver.transcript.path, "utf8")).trim().split("\n").slice(-4).map(line => { const record = JSON.parse(line); return { type: record.type, subtype: record.subtype, content: record.message?.content, stop: record.message?.stop_reason }; }));
      process.exitCode = 1;
    } finally {
      await driver?.stop();
    }
  }
} finally {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  if (!directory.startsWith(join(tmpdir(), "sideband-real-clis-"))) throw Error("Unsafe cleanup");
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
