// Installed PI against a loopback model fixture and an isolated profile. No account or paid API calls.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ManagedTerminal } from "../dist/src/managed-terminal.js";
import { ModelDiscovery } from "../dist/src/model-discovery.js";
const directory = await mkdtemp(join(tmpdir(), "sideband-real-pi-"));
let calls = 0, holds = 0, cancellations = 0;
const server = createServer(async (req, res) => {
  let raw = ""; for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw); calls++;
  res.writeHead(200, { "content-type": "text/event-stream" });
  const send = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  const id = `msg_${calls}`, last = body.messages?.at(-1);
  send("message_start", { message: { id, type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 5, output_tokens: 0 } } });
  if (JSON.stringify(last).includes("HOLD_STREAM")) { holds++; res.once("close", () => cancellations++); return; }
  const tool = body.tools?.find(t => t.name === "sideband_room_send");
  const result = last?.role === "user" && Array.isArray(last.content) && last.content.some(p => p.type === "tool_result");
  const block = tool && !result ? { type: "tool_use", id: `tool_${calls}`, name: tool.name, input: { text: "PI fixture room send" } } : { type: "text", text: "PI_DONE" };
  send("content_block_start", { index: 0, content_block: block.type === "tool_use" ? { ...block, input: {} } : { type: "text", text: "" } });
  send("content_block_delta", { index: 0, delta: block.type === "tool_use" ? { type: "input_json_delta", partial_json: JSON.stringify(block.input) } : { type: "text_delta", text: block.text } });
  send("content_block_stop", { index: 0 });
  send("message_delta", { delta: { stop_reason: block.type === "tool_use" ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } });
  send("message_stop", {}); res.end();
});
await new Promise(r => server.listen(0, "127.0.0.1", r));
const previous = { PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR, PI_OFFLINE: process.env.PI_OFFLINE };
process.env.PI_CODING_AGENT_DIR = join(directory, "profile"); process.env.PI_OFFLINE = "1";
await mkdir(process.env.PI_CODING_AGENT_DIR);
await writeFile(join(process.env.PI_CODING_AGENT_DIR, "models.json"), JSON.stringify({ providers: { sideband_fixture: {
  baseUrl: `http://127.0.0.1:${server.address().port}`, api: "anthropic-messages", apiKey: "synthetic-local-key",
  models: [{ id: "fixture", name: "Local fixture", reasoning: false, input: ["text"], contextWindow: 200000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
} } }));
await writeFile(join(process.env.PI_CODING_AGENT_DIR, "settings.json"), JSON.stringify({ packages: [] }));
const executable = { command: process.env.SIDEBAND_PI_TEST_CLI ?? "pi" }, entry = resolve("dist/src/cli.js");
const tools = [], events = []; let state = "starting", failure;
const host = { event: (kind, text) => events.push({ kind, text }), state: value => { state = value; }, exit: error => { failure = error ?? new Error("PI exited unexpectedly"); }, tool: async (name, args) => { tools.push({ name, args }); return { sent: true }; } };
const make = () => new ManagedTerminal(executable, directory, join(directory, "sessions"), host, entry, undefined, undefined, { harness: "pi", headless: !process.env.SIDEBAND_TEST_NATIVE });
const discovery = new ModelDiscovery(() => executable, directory, entry); let driver = make();
async function until(check) { const end = Date.now() + 120000; while (!check()) { if (failure) throw failure; if (Date.now() > end) throw new Error("PI smoke timed out"); await new Promise(r => setTimeout(r, 30)); } }
try {
  const catalog = await discovery.refresh("pi"); assert.ok(catalog.models.some(m => m.id === "sideband_fixture/fixture"), catalog.error);
  await driver.start({ model: "sideband_fixture/fixture" });
  await driver.prompt("Reply and send a room message"); await until(() => state === "idle" && events.some(e => e.text.includes("PI_DONE")));
  assert.ok(tools.some(t => t.name === "sideband_room_send"));
  const count = calls; await driver.deliver("A room message"); await until(() => calls > count && state === "idle");
  const held = driver.prompt("HOLD_STREAM"); held.catch(() => {}); await until(() => holds > 0); await driver.interrupt(); await until(() => cancellations > 0 && state === "idle"); await held;
  const session = driver.sessionFile; assert.ok(session); await driver.stop(); driver = make();
  await driver.start({ model: "sideband_fixture/fixture", resume: session }); assert.equal(driver.sessionFile, session);
  await driver.prompt("Resume and reply"); await until(() => state === "idle" && calls > count + 1);
  console.log(`Real PI passed: model discovery, room tool, text, room delivery, interrupt, exact resume (${calls} fixture requests; ${cancellations} cancellation).`);
} finally {
  await driver.stop(); await discovery.close(); server.closeAllConnections(); await new Promise(r => server.close(r));
  for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  assert.ok(directory.startsWith(join(tmpdir(), "sideband-real-pi-"))); await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
}
