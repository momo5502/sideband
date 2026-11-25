// Installed PI against a loopback model fixture and an isolated profile. No account or paid API calls.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ManagedTerminal } from "../dist/src/managed-terminal.js";
import { ModelDiscovery } from "../dist/src/model-discovery.js";
import { readPluginPresence } from "../dist/src/plugin-presence.js";
import { requestPlugin } from "../dist/src/plugin-control.js";
import spawn from "cross-spawn";
import { terminateTree } from "../dist/src/process-tree.js";
const directory = await mkdtemp(join(tmpdir(), "sideband-real-pi-"));
const errorText = "rg: regex parse error\nCommand exited with code 2";
const errorEnvelope = { content: [{ type: "text", text: errorText }], structuredContent: { output: errorText, truncated: false, exit_code: 2, wall_time_seconds: 0.1 }, isError: true };
let calls = 0, holds = 0, cancellations = 0, releaseReload;
const server = createServer(async (req, res) => {
  let raw = ""; for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw); calls++;
  res.writeHead(200, { "content-type": "text/event-stream" });
  const send = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  const id = `msg_${calls}`, last = body.messages?.at(-1);
  send("message_start", { message: { id, type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 5, output_tokens: 0 } } });
  if (JSON.stringify(last).includes("HOLD_STREAM")) { holds++; res.once("close", () => cancellations++); return; }
  const failurePrompt = JSON.stringify(body.messages).includes("FAIL_JSON_WRAPPER");
  const tool = body.tools?.find(t => t.name === (failurePrompt ? "fixture_error" : "sideband_room_send"));
  const result = last?.role === "user" && Array.isArray(last.content) && last.content.some(p => p.type === "tool_result");
  const block = tool && !result ? { type: "tool_use", id: `tool_${calls}`, name: tool.name, input: failurePrompt ? {} : { text: "PI fixture room send" } } : { type: "text", text: "PI_DONE" };
  const finish = () => {
  send("content_block_start", { index: 0, content_block: block.type === "tool_use" ? { ...block, input: {} } : { type: "text", text: "" } });
  send("content_block_delta", { index: 0, delta: block.type === "tool_use" ? { type: "input_json_delta", partial_json: JSON.stringify(block.input) } : { type: "text_delta", text: block.text } });
  send("content_block_stop", { index: 0 });
  send("message_delta", { delta: { stop_reason: block.type === "tool_use" ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } });
  send("message_stop", {}); res.end();
  };
  if (JSON.stringify(last).includes("HOLD_RELOAD")) { let released = false; releaseReload = () => { released = true; finish(); }; res.once("close", () => { if (!released) cancellations++; }); return; }
  finish();
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
  // A manually started, plugin-loaded session must appear before any room or model call.
  const registry = join(directory, "presence");
  const failingTool = join(directory, "failing-tool.mjs"), historyMarker = join(directory, "history-navigation.json"), reloadMarker = join(directory, "reload.json");
  await writeFile(failingTool, `import {Type} from "typebox"; import {writeFile} from "node:fs/promises";
export default function(api) {
  const generation=1;
  api.on("session_start",async(_event,ctx)=>{await writeFile(${JSON.stringify(reloadMarker)},JSON.stringify({generation,id:ctx.sessionManager.getSessionId(),file:ctx.sessionManager.getSessionFile()}));});
  api.registerTool({name:"fixture_error", label:"Fixture error", description:"Local failure fixture", parameters:Type.Object({}), execute(){throw new Error(${JSON.stringify(JSON.stringify(errorEnvelope))});}});
  api.registerCommand("fixture-history", {description:"Local history navigation fixture", async handler(_args,ctx) {
    try {
      await ctx.waitForIdle();
      const before=ctx.sessionManager.getSessionId(), file=ctx.sessionManager.getSessionFile();
      const target=ctx.sessionManager.getEntries().find(entry=>entry.type==="message"&&entry.message.role==="user");
      if(!target)throw new Error("No fixture history entry");
      await ctx.navigateTree(target.id,{summarize:false});
      await writeFile(${JSON.stringify(historyMarker)},JSON.stringify({sameSession:before===ctx.sessionManager.getSessionId()&&file===ctx.sessionManager.getSessionFile()}));
    }catch(error){await writeFile(${JSON.stringify(historyMarker)},JSON.stringify({error:String(error)}));}
  }});
}`);
  const manual = spawn(executable.command, ["--mode", "rpc", "--no-extensions", "--no-session", "--no-approve", "--model", "sideband_fixture/fixture", "-e", resolve("dist/sideband-pi.cjs"), "-e", failingTool], {
    cwd: directory, env: { ...process.env, SIDEBAND_STATE_DIR: join(directory, "sideband"), SIDEBAND_PRESENCE_DIR: registry }, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
  });
  let manualBusy = false, primed = false, stdout = "";
  manual.stdout.on("data", chunk => { stdout += chunk.toString(); while (stdout.includes("\n")) { const end = stdout.indexOf("\n"), line = stdout.slice(0,end); stdout = stdout.slice(end+1); try { const frame=JSON.parse(line); if(frame.type==="agent_start")manualBusy=true; if(frame.type==="agent_end")manualBusy=false; if(frame.id==="prime"&&frame.type==="response"&&frame.success)primed=true; } catch {} } }); manual.stderr.resume();
  const exited = new Promise(resolve => manual.once("exit", resolve));
  try {
    const end = Date.now() + 120000;
    let sessions; const endpoints = new Map();
    while (!(sessions = await readPluginPresence(registry, undefined, undefined, endpoints)).some(row => row.harness === "pi" && row.interactive)) {
      if (manual.exitCode !== null || Date.now() > end) throw new Error("Manual PI plugin did not publish presence.");
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(calls, 0, "passive discovery never sends a model prompt");
    const session = sessions.find(row => row.harness === "pi"), endpoint = endpoints.get(session.key);
    assert.deepEqual(await requestPlugin(endpoint, { key: session.key, action: "prompt", text: "External PI instruction" }), { accepted: true });
    let replied = false;
    while (!replied) {
      const output = await requestPlugin(endpoint, { key: session.key, action: "logs" });
      replied = output.events.some(event => event.kind === "assistant" && event.text.includes("PI_DONE"));
      if (!replied) { if (Date.now() > end) throw new Error("External PI reply did not reach the output bridge."); await new Promise(resolve => setTimeout(resolve, 100)); }
    }
    await requestPlugin(endpoint, { key: session.key, action: "prompt", text: "FAIL_JSON_WRAPPER" });
    let failed;
    while (!failed) {
      const output = await requestPlugin(endpoint, { key: session.key, action: "logs" });
      failed = output.events.find(event => event.kind === "error");
      if (!failed) { if (Date.now() > end) throw new Error("PI did not report its failed tool."); await new Promise(resolve => setTimeout(resolve, 100)); }
    }
    assert.equal(failed.text, errorText, "PI wraps a thrown serialized tool result in another text block; only the error text should reach the panel");
    manual.stdin.write(JSON.stringify({ id: "history", type: "prompt", message: "/fixture-history" }) + "\n");
    const historyDeadline = Date.now() + 120000; let history;
    while (!history) {
      history = await readFile(historyMarker, "utf8").then(text => JSON.parse(text)).catch(() => undefined);
      if (!history) { if (Date.now() > historyDeadline) throw new Error("PI did not navigate its fixture history."); await new Promise(resolve => setTimeout(resolve, 100)); }
    }
    assert.deepEqual(history, { sameSession: true }, "history navigation keeps PI's session ID and file");
    const afterTree = await requestPlugin(endpoint, { key: session.key, action: "logs" });
    assert.ok(afterTree.events.some(event => event.text === errorText), "history navigation keeps the external controller and output buffer");
    await until(() => !manualBusy);
    // A real user/RPC command grants PI's command-only reload context.
    manual.stdin.write(JSON.stringify({id:"prime",type:"prompt",message:"/sideband status"})+"\n"); await until(()=>primed);
    const beforeReload = JSON.parse(await readFile(reloadMarker,"utf8")); assert.equal(beforeReload.generation,1);
    await writeFile(failingTool,(await readFile(failingTool,"utf8")).replace("const generation=1;","const generation=2;"));
    const cancelBefore = cancellations;
    await requestPlugin(endpoint,{key:session.key,action:"prompt",text:"HOLD_RELOAD"}); await until(()=>!!releaseReload);
    assert.deepEqual(await requestPlugin(endpoint,{key:session.key,action:"reload"}),{queued:true});
    // PI executes extension commands immediately; waitForIdle must prevent an abort.
    await new Promise(resolve=>setTimeout(resolve,300));
    assert.equal(JSON.parse(await readFile(reloadMarker,"utf8")).generation,1);
    assert.equal(cancellations,cancelBefore,"queuing reload must not cancel a running model request");
    releaseReload(); let reloaded;
    const reloadDeadline=Date.now()+120000;
    while (!reloaded) { const marker=await readFile(reloadMarker,"utf8").then(JSON.parse).catch(()=>undefined); if(marker?.generation===2)reloaded=marker;
      else { if(Date.now()>reloadDeadline)throw new Error("Real PI did not import its updated extension after becoming idle"); await new Promise(resolve=>setTimeout(resolve,100)); } }
    assert.equal(reloaded.id,beforeReload.id); assert.equal(reloaded.file,beforeReload.file);
    let fresh;
    while(!fresh) { const next=new Map(); await readPluginPresence(registry,undefined,undefined,next); const candidate=next.get(session.key); if(candidate&&candidate.token!==endpoint.token)fresh=candidate;
      else { if(Date.now()>reloadDeadline)throw new Error("Reloaded PI did not publish a fresh control endpoint"); await new Promise(resolve=>setTimeout(resolve,100)); } }
    assert.ok((await requestPlugin(fresh,{key:session.key,action:"logs"})).events.some(event=>event.text===errorText),"real reload preserves the output ring");
    assert.deepEqual(await requestPlugin(fresh,{key:session.key,action:"reload"}),{queued:false},"fresh runtimes without a command context request a manual reload without sending a model prompt");
    // A queued reload must also complete if the active turn is interrupted.
    primed=false; manual.stdin.write(JSON.stringify({id:"prime",type:"prompt",message:"/sideband status"})+"\n"); await until(()=>primed);
    await writeFile(failingTool,(await readFile(failingTool,"utf8")).replace("const generation=2;","const generation=3;"));
    releaseReload=undefined; const cancelledBeforeAbort=cancellations;
    await requestPlugin(fresh,{key:session.key,action:"prompt",text:"HOLD_RELOAD_ABORT"}); await until(()=>!!releaseReload);
    assert.deepEqual(await requestPlugin(fresh,{key:session.key,action:"reload"}),{queued:true});
    manual.stdin.write(JSON.stringify({id:"abort-reload",type:"abort"})+"\n");
    let afterAbort, finalEndpoint; const abortDeadline=Date.now()+120000;
    while (!afterAbort||!finalEndpoint) { const marker=await readFile(reloadMarker,"utf8").then(JSON.parse).catch(()=>undefined); if(marker?.generation===3)afterAbort=marker;
      const next=new Map(); await readPluginPresence(registry,undefined,undefined,next); const candidate=next.get(session.key); if(candidate&&candidate.token!==fresh.token)finalEndpoint=candidate;
      if(!afterAbort||!finalEndpoint) { if(Date.now()>abortDeadline)throw new Error("PI reload did not complete after abort"); await new Promise(resolve=>setTimeout(resolve,100)); } }
    assert.equal(afterAbort.id,beforeReload.id); assert.ok(cancellations>cancelledBeforeAbort,"abort really cancelled the held network request");
    const position=(await requestPlugin(finalEndpoint,{key:session.key,action:"logs"})).next;
    await requestPlugin(finalEndpoint,{key:session.key,action:"prompt",text:"Instruction after real reload"});
    let finalReply=false; while(!finalReply) { const logs=await requestPlugin(finalEndpoint,{key:session.key,action:"logs",after:position-1}); finalReply=logs.events.some(event=>event.kind==="assistant"&&event.text.includes("PI_DONE"));
      if(!finalReply) { if(Date.now()>abortDeadline)throw new Error("Reloaded PI did not deliver its next reply"); await new Promise(resolve=>setTimeout(resolve,100)); } }
  } finally { terminateTree(manual, false); await exited; }
  assert.deepEqual(await readPluginPresence(registry), [], "a dead plugin is never listed as running");
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
