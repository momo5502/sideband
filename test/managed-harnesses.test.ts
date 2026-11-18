import { testTimeout } from "./waits.js";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, appendFile, readFile, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { connect } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ManagedCodex } from "../src/managed-codex.js";
import { ManagedClaude } from "../src/managed-claude.js";
import { ManagedClaudeNative } from "../src/managed-claude-native.js";
import { ManagedRoomTools } from "../src/managed-room-tools.js";
import { ClaudeTranscript, hasClaudeSession } from "../src/claude-transcript.js";
import type { OmpHost } from "../src/managed-omp.js";
import { readLocal, writeLocal } from "../src/local-wire.js";

const entry = resolve("dist/src/cli.js"), pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check: () => boolean, timeout = testTimeout(8000)) { const end = Date.now() + timeout; while (!check()) { if (Date.now() > end) throw new Error("Harness fixture did not settle."); await pause(10); } }
async function temporary() { const directory = await mkdtemp(join(tmpdir(), "sideband-harness-")); return { directory, async close() { assert.ok(directory.startsWith(join(tmpdir(), "sideband-harness-"))); await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } }; }

// The fixture exercises the real subprocess boundary and response/event ordering, without a model.
const fixture = `import {createInterface} from 'node:readline';import{appendFile,writeFile,readFile}from'node:fs/promises';import{join}from'node:path';
const harness=process.argv[2],args=process.argv.slice(3),id='11111111-1111-4111-8111-111111111111';let active=false,turn=0;
const send=x=>console.log(JSON.stringify(x));const notify=(method,params={})=>send({method,params:{threadId:id,...params}});
if(args.includes('--version')){console.log('fixture '+harness);process.exit(0);}
async function handle(line){
const x=JSON.parse(line);await appendFile(join(process.cwd(),'requests.jsonl'),line+'\\n');
if(harness==='codex'){
 const reply=result=>send({id:x.id,result});
 if(x.method==='initialize'){reply({});return;}
 if(['thread/archive','thread/unarchive'].includes(x.method)){reply({});return;}
 if(['thread/start','thread/resume'].includes(x.method)){
  if(x.params.approvalPolicy!=='never'||x.params.sandbox!=='danger-full-access')throw Error('wrong unattended policy');
  if(!x.params.config.mcp_servers.sideband_managed.required)throw Error('room MCP must be required');
  if(x.method==='thread/resume')await readFile(join(process.cwd(),'saved-session'));
  await writeFile(join(process.cwd(),'saved-session'),id);reply({thread:{id}});return;
 }
 if(x.method==='thread/read'){reply({thread:{id,turns:active?[{id:'turn-'+turn,status:'inProgress'}]:[]}});return;}
 if(x.method==='turn/interrupt'){active=false;notify('turn/completed',{turn:{id:'turn-'+turn,status:'interrupted'}});reply({});return;}
 if(['turn/start','turn/steer'].includes(x.method)){
  if(x.method==='turn/steer'&&!active){send({id:x.id,error:{code:-32600,message:'no active turn'}});return;}
  active=true;turn++;const text=x.params.input[0].text;notify('turn/started',{turn:{id:'turn-'+turn,status:'inProgress'}});
  if(text==='HOLD'){reply({turn:{id:'turn-'+turn,status:'inProgress'}});return;}
  notify('item/agentMessage/delta',{itemId:'message-'+turn,delta:'reply:'+text});
  notify('item/completed',{item:{type:'agentMessage',id:'message-'+turn,text:'reply:'+text}});
  active=false;notify('turn/completed',{turn:{id:'turn-'+turn,status:'completed'}});reply({turn:{id:'turn-'+turn,status:'inProgress'}});return;
 }
}else{
 if(x.type==='control_request'){
  if(x.request.subtype==='end_session'){process.exit(0);}
  send({type:'control_response',response:{subtype:'success',request_id:x.request_id,response:{}}});
  if(x.request.subtype==='interrupt')send({type:'result',is_error:false});return;
 }
 if(x.type==='user'){
  send({type:'stream_event',event:{type:'message_start'}});const text=x.message.content[0].text;
  if(text==='HOLD')return;
  send({type:'stream_event',event:{type:'content_block_delta',delta:{type:'thinking_delta',thinking:'considering'}}});
  send({type:'assistant',message:{content:[{type:'thinking',thinking:'considering'},{type:'text',text:'reply:'+text},{type:'tool_use',id:'tool',name:'test_tool',input:{value:1}}]}});
  send({type:'user',message:{content:[{type:'tool_result',tool_use_id:'tool',content:'tool result'}]}});
  await writeFile(join(process.cwd(),'saved-session'),x.session_id);send({type:'result',is_error:false});return;
 }
}}
let queue=Promise.resolve();createInterface({input:process.stdin}).on('line',line=>{queue=queue.then(()=>handle(line)).catch(error=>{console.error(error);process.exit(1);});});
`;

for (const name of ["codex", "claude"] as const) test(`${name} driver keeps one session, streams output, steers, interrupts and resumes`, { timeout: testTimeout(20000) }, async () => {
  const temp = await temporary(), events: { kind: string; text: string }[] = [], states: string[] = [], exits: unknown[] = [];
  const script = join(temp.directory, "fixture.mjs"); await writeFile(script, fixture);
  const host: OmpHost = { event: (kind, text) => events.push({ kind, text }), state: state => states.push(state), exit: error => exits.push(error), tool: async () => ({ room: null }) };
  const create = () => name === "codex" ? new ManagedCodex({ command: process.execPath, args: [script, name] }, temp.directory, join(temp.directory, "sessions"), host, entry)
    : new ManagedClaude({ command: process.execPath, args: [script, name] }, temp.directory, join(temp.directory, "sessions"), host, entry, temp.directory);
  let driver = create();
  try {
    await driver.start({}); const id = driver.sessionFile; assert.ok(id); assert.equal(states.at(-1), "idle");
    await driver.prompt("HOLD"); await until(() => states.at(-1) === "busy");
    await driver.prompt("FOLLOW"); await until(() => states.at(-1) === "idle");
    assert.equal(events.filter(event => event.kind === "assistant").map(event => event.text).join(""), "reply:FOLLOW");
    if (name === "claude") { assert.equal(events.filter(event => event.kind === "thinking").length, 1); assert.ok(events.some(event => event.kind === "tool-output")); }
    await driver.prompt("HOLD"); await until(() => states.at(-1) === "busy"); await driver.interrupt(); await until(() => states.at(-1) === "idle");
    await driver.stop(); assert.deepEqual(exits, []);
    driver = create(); await driver.start({ resume: id }); assert.equal(driver.sessionFile, id); await driver.prompt("RESUMED"); await until(() => events.some(event => event.text === "reply:RESUMED"));
    const requests = (await readFile(join(temp.directory, "requests.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
    if (name === "codex") { assert.ok(requests.some(request => request.method === "turn/steer")); assert.equal(requests.filter(request => request.method === "turn/start").length, 3); }
    else { assert.equal(requests.filter(request => request.type === "user").length, 4); assert.ok(requests.some(request => request.request?.subtype === "interrupt")); }
  } finally { await driver.stop(); await temp.close(); }
});

test("managed MCP authenticates locally, exposes only room tools, and loses access when its runner closes", async () => {
  const temp = await temporary(), calls: string[] = [];
  const bridge = new ManagedRoomTools({ event() {}, state() {}, exit() {}, tool: async (name, args) => { calls.push(name); return { name, args }; } }, join(temp.directory, "bootstrap.json"));
  const client = new Client({ name: "fixture", version: "1" }); let connected = false;
  try {
    await bridge.start(); const config = JSON.parse(await readFile(bridge.path, "utf8"));
    const wrong = connect({ host: "127.0.0.1", port: config.port }); const closed = new Promise(resolve => wrong.once("close", resolve)); wrong.on("error", () => {});
    wrong.once("connect", () => writeLocal(wrong, { type: "hello", token: "invalid" })); await closed;
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [entry, "managed-mcp", bridge.path], stderr: "ignore" })); connected = true;
    assert.deepEqual((await client.listTools()).tools.map(tool => tool.name), ["sideband_room_send", "sideband_room_status", "sideband_room_members", "sideband_room_history"]);
    const result = await client.callTool({ name: "sideband_room_send", arguments: { text: "hello" } }); assert.equal(result.isError, undefined); assert.deepEqual(calls, ["sideband_room_send"]);
    await bridge.close(); await assert.rejects(client.listTools());
  } finally { if (connected) await client.close(); await bridge.close(); await temp.close(); }
});

test("native Claude gates input on its own hooks, refuses dialogs and only interrupts a busy session", async () => {
  const temp = await temporary(), inputs: { text: string; escape: boolean }[] = [], events: { kind: string; text: string }[] = [];
  await writeFile(join(temp.directory, "settings.json"), JSON.stringify({ skipDangerousModePermissionPrompt: true }));
  let launched = false, stopped = false, args: string[] = [];
  const driver = new ManagedClaudeNative({ command: "fixture" }, temp.directory, join(temp.directory, "sessions"), { event: (kind, text) => events.push({ kind, text }), state() {}, exit() {}, tool: async () => ({}) }, entry,
    () => ({ start: async (_executable, actual) => { launched = true; args = actual; }, input: async (text, escape = false) => { inputs.push({ text, escape }); }, stop: async () => { stopped = true; } }), temp.directory);
  let socket: ReturnType<typeof connect> | undefined;
  const start = driver.start({});
  try {
    await until(() => launched); await assert.rejects(driver.prompt("before ready"), /local setup/);
    assert.ok(!args.some(arg => arg.includes("development-channels")), "console mode needs no development channel or its startup dialog");
    const settings = JSON.parse(args[args.indexOf("--settings") + 1]!); assert.ok(settings.hooks.SessionStart); assert.equal(settings.skipDangerousModePermissionPrompt, true);
    const bootstrap = JSON.parse(await readFile(join(temp.directory, "sessions", "room-tools.json"), "utf8"));
    socket = connect({ host: "127.0.0.1", port: bootstrap.port });
    await new Promise<void>((resolve, reject) => { socket!.once("error", reject); socket!.once("connect", () => writeLocal(socket, { type: "hello", token: bootstrap.token })); readLocal(socket!, packet => { if (packet.type === "ready") resolve(); }); });
    const send = async (name: string, values: object = {}, id = driver.sessionFile) => {
      const requestId = Math.random().toString();
      await new Promise<void>(resolve => { readLocalHook = packet => { if (packet.id === requestId) resolve(); }; writeLocal(socket, { type: "hook", id: requestId, event: { hook_event_name: name, session_id: id, ...values } }); });
    };
    let readLocalHook: (packet: any) => void = () => {}; readLocal(socket, packet => readLocalHook(packet));
    await send("SessionStart", {}, "22222222-2222-4222-8222-222222222222"); await assert.rejects(driver.prompt("wrong session"), /local setup/);
    await send("SessionStart"); await start; await driver.prompt("private instructions"); assert.equal(inputs.at(-1)!.text, "private instructions");
    await send("UserPromptSubmit", { prompt: "private instructions" }); await send("PermissionRequest");
    const before = inputs.length; await assert.rejects(driver.prompt("do not accept this dialog"), /dialog/); await assert.rejects(driver.interrupt(), /dialog/); assert.equal(inputs.length, before);
    await send("PostToolUse", { agent_id: "child" }); await assert.rejects(driver.prompt("a child must not clear the parent dialog"), /dialog/);
    await send("Stop"); await driver.interrupt(); assert.equal(inputs.length, before, "Escape must not clear idle local input");
    await send("PermissionRequest", { agent_id: "child" }); await send("PostToolUse"); await assert.rejects(driver.prompt("a parent must not clear the child dialog"), /dialog/); await send("SubagentStop", { agent_id: "child" });
    await send("UserPromptSubmit", { prompt: "working" }); await driver.interrupt(); assert.deepEqual(inputs.at(-1), { text: "", escape: true });
    const interrupted = inputs.length; await driver.interrupt(); assert.equal(inputs.length, interrupted, "a repeated interrupt must not clear the idle input box");
    await send("PreToolUse"); await driver.interrupt(); assert.equal(inputs.length, interrupted + 1, "new main-agent activity restores busy state");
    await send("Stop"); await driver.deliver("<sideband sender=\"peer\">hello</sideband>"); await send("UserPromptSubmit", { prompt: inputs.at(-1)!.text });
    assert.equal(events.filter(event => event.kind === "user").length, 2, "room delivery must not appear as a duplicate owner instruction");
  } finally { socket?.destroy(); await driver.stop(); await start.catch(() => {}); assert.ok(stopped); await temp.close(); }
});

test("Claude hooks remain silent and successful when their controller is unavailable", async () => {
  const temp = await temporary();
  try {
    const bootstrap = join(temp.directory, "missing.json");
    const child = spawn(process.execPath, [entry, "managed-hook", bootstrap], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = ""; child.stdout.on("data", data => stdout += data); child.stderr.on("data", data => stderr += data);
    const exit = new Promise(resolve => child.once("close", resolve));
    child.stdin.end(JSON.stringify({ hook_event_name: "PreToolUse", session_id: "fixture" }));
    assert.equal(await exit, 0); assert.equal(stdout, ""); assert.equal(stderr, "");
  } finally { await temp.close(); }
});

test("Claude transcript tails split Unicode records and excludes subagent and other-session output", async () => {
  const temp = await temporary(), events: { kind: string; text: string }[] = [];
  const id = "11111111-1111-4111-8111-111111111111", projects = join(temp.directory, "projects"), directory = join(projects, temp.directory.replace(/[^a-zA-Z0-9]/g, "-")), path = join(directory, `${id}.jsonl`);
  const host: OmpHost = { event: (kind, text) => events.push({ kind, text }), state() {}, exit() {}, tool: async () => ({}) };
  await mkdir(directory, { recursive: true });
  const record = (text: string, extra = {}) => JSON.stringify({ type: "assistant", sessionId: id, message: { content: [{ type: "text", text }] }, ...extra }) + "\n";
  await writeFile(path, record("old"));
  assert.equal(await hasClaudeSession(id, temp.directory, temp.directory), true);
  let interruptions = 0;
  const transcript = new ClaudeTranscript(id, host, true, projects, temp.directory, () => interruptions++); transcript.start();
  try {
    await pause(400); assert.deepEqual(events, []);
    const bytes = Buffer.from(record("hello 😀")), split = bytes.indexOf(Buffer.from("😀")) + 2;
    await appendFile(path, bytes.subarray(0, split)); await pause(350); assert.deepEqual(events, []);
    await appendFile(path, bytes.subarray(split));
    await appendFile(path, record("child", { isSidechain: true }) + record("other", { sessionId: "22222222-2222-4222-8222-222222222222" }));
    await until(() => events.length === 1); assert.deepEqual(events, [{ kind: "assistant", text: "hello 😀" }]);
    await appendFile(path, JSON.stringify({ type: "user", sessionId: id, message: { content: [{ type: "text", text: "[Request interrupted by user]" }] } }) + "\n");
    await until(() => interruptions === 1);
  } finally { await transcript.close(); await temp.close(); }
});
