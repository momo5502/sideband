import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ManagedTerminal } from "../src/managed-terminal.js";
import { launchSpec } from "../src/orchestration-protocol.js";
import { projectPiModels } from "../src/pi-model-probe.js";
import { testTimeout } from "./waits.js";
import piSideband from "../src/pi-extension.js";
import { RoomServer } from "../src/room-server.js";
import { RoomClient } from "../src/room-client.js";
import { RoomProfiles } from "../src/room-profiles.js";

async function until(check: () => boolean | Promise<boolean>) { const end = Date.now() + testTimeout(15000); while (!await check()) { if (Date.now() > end) throw new Error("PI fixture did not settle."); await new Promise(r => setTimeout(r, 15)); } }
test("PI efforts match its own levels rather than OMP levels", () => {
  assert.equal(launchSpec({ name: "pi-agent", harness: "pi", effort: "xhigh" }).harness, "pi");
  assert.throws(() => launchSpec({ name: "pi-agent", harness: "pi", effort: "max" }));
  assert.deepEqual(projectPiModels([{ provider: "fixture", id: "model", reasoning: true, thinkingLevelMap: { xhigh: null } }])[0]!.efforts, ["off", "minimal", "low", "medium", "high"]);
});
test("standalone PI uses TypeBox room tools, native steering and separate-terminal credential guidance", async () => {
  const server = await RoomServer.start({ host: "127.0.0.1", port: 0 }), profile = { server: `127.0.0.1:${server.port}`, password: server.password };
  await new RoomProfiles().save("pi-fixture", profile);
  const peer = new RoomClient(profile, "peer"), handlers = new Map<string, Function[]>(), tools = new Map<string, any>(), commands = new Map<string, any>(), received: any[] = [], notices: string[] = [];
  const ctx = { mode: "tui", hasUI: true, sessionManager: { getSessionId: () => "manual-pi" }, ui: { notify: (text: string) => notices.push(text), input: async () => { throw new Error("PI must never collect a password through its unmasked input"); } } };
  const emit = async (event: string, value: object = {}) => { const results = []; for (const handler of handlers.get(event) ?? []) results.push(await handler(value, ctx)); return results; };
  piSideband({ registerTool: (tool: any) => tools.set(tool.name, tool), registerCommand: (name: string, command: any) => commands.set(name, command), on: (name: string, handler: Function) => handlers.set(name, [...(handlers.get(name) ?? []), handler]), sendMessage: (message: any, options: any) => received.push({ message, options }) });
  try {
    await emit("session_start"); await commands.get("sideband").handler("login example.com", ctx); assert.match(notices[0]!, /separate terminal/);
    const prompt = (await emit("before_agent_start", { systemPrompt: "Existing PI instructions" }))[0].systemPrompt;
    assert.equal(typeof prompt, "string"); assert.ok(prompt.startsWith("Existing PI instructions")); assert.doesNotMatch(prompt, /On oh-my-pi,/);
    const tool = tools.get("sideband_join_room"); assert.equal(tool.parameters.type, "object"); assert.ok(!("loadMode" in tool));
    await tool.execute("join", { name: "pi-user", room: "pi-room", profile: "pi-fixture" }, undefined, undefined, ctx);
    await peer.connect(); await peer.joinRoom("pi-room"); await peer.send("PI room delivery");
    await until(() => received.some(item => item.message.content.includes("PI room delivery")));
    assert.ok(received.every(item => item.options.deliverAs === "steer" && !("attribution" in item.message)));
    await emit("session_shutdown", { reason: "new" });
    const status = await tools.get("sideband_status").execute("status", {}, undefined, undefined, ctx).catch(() => undefined);
    assert.equal(status, undefined, "the retired PI extension runtime cannot reconnect its old binding");
  } finally { await emit("session_shutdown", { reason: "quit" }); await peer.close(); await server.close(); }
});
test("PI background bridge handles real extension lifecycle, tools, steering, large RPC frames and exact session resume", { timeout: testTimeout(45000) }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "sideband-pi-")), fixture = join(directory, "pi.mjs"), log = join(directory, "rpc.jsonl");
  const source = `import extension from ${JSON.stringify(new URL("../src/pi-extension.js", import.meta.url).href)};
import{appendFileSync}from'node:fs';import{createInterface}from'node:readline';import{join}from'node:path';
const args=process.argv.slice(2),log=args[0];appendFileSync(log,JSON.stringify({args})+'\\n');
if(args.includes('-a')||args.includes('--auto-approve')||args.includes('--no-ui')||args.includes('--resume'))throw Error('OMP flags leaked');
let tools=new Map(),handlers=new Map(),file=args.includes('--session')?args[args.indexOf('--session')+1]:join(args[args.indexOf('--session-dir')+1],'root.jsonl');
const ctx={mode:'rpc',hasUI:true,isIdle:()=>true,sessionManager:{getSessionId:()=>file,getSessionFile:()=>file},abort(){emit('agent_end')},shutdown(){emit('session_shutdown',{reason:'quit'}).then(()=>process.exit(0))},ui:{notify(){}}};
async function emit(name,event={}){for(const h of handlers.get(name)||[])await h(event,ctx)}
function setup(){tools=new Map();handlers=new Map();extension({registerTool(t){if(t.parameters.type!=='object')throw Error('not TypeBox');tools.set(t.name,t)},registerCommand(){},on(n,h){handlers.set(n,[...(handlers.get(n)||[]),h])},getActiveTools:()=>[],getAllTools:()=>[],setActiveTools:async()=>{},
async sendUserMessage(text,options){if(options.deliverAs!=='steer'||options.attribution)throw Error('bad PI options');
if(text==='switch'){await emit('session_shutdown',{reason:'new'});file=join(args[args.indexOf('--session-dir')+1],'new.jsonl');setup();await emit('session_start',{reason:'new'});return;}
await emit('agent_start');await tools.get('sideband_room_send').execute('tool',{text},undefined,undefined,ctx);
await emit('message_update',{assistantMessageEvent:{type:'text_delta',delta:text}});await emit('agent_end');},
sendMessage(message,options){if(options.deliverAs!=='steer'||message.attribution)throw Error('bad PI room options');emit('message_update',{assistantMessageEvent:{type:'text_delta',delta:message.content}})}
})}
setup();await emit('session_start',{reason:'startup'});
// Unused RPC snapshots must not kill a healthy streaming extension.
process.stdout.write(JSON.stringify({type:'agent_end',messages:['x'.repeat(9*1024*1024)]})+'\\n');
console.log(JSON.stringify({type:'extension_ui_request',id:'dialog',method:'confirm'}));
createInterface({input:process.stdin}).on('line',l=>appendFileSync(log,l+'\\n'));
process.stdin.on('end',()=>process.exit(0));`;
  await writeFile(fixture, source);
  const events: string[] = [], tools: string[] = []; let state = "", exited = 0;
  const host = { event: (_: string, text: string) => events.push(text), state: (value: string) => { state = value; }, exit: () => { exited++; }, tool: async (_: string, args: any) => { tools.push(args.text); return {}; } };
  const make = () => new ManagedTerminal({ command: process.execPath, args: [fixture, log] }, directory, join(directory, "sessions"), host, resolve("dist/src/cli.js"), undefined, () => undefined, { harness: "pi", headless: true });
  let driver = make();
  try {
    await driver.start({ model: "fixture/model", effort: "high" }); assert.equal(state, "idle");
    await driver.prompt("first"); await until(() => events.includes("first")); assert.deepEqual(tools, ["first"]);
    await driver.deliver("room"); await until(() => events.includes("room"));
    await driver.interrupt();
    // A runtime switch can close the old transport before it can confirm this
    // request. Report unknown acceptance, then reconnect without losing identity.
    await assert.rejects(driver.prompt("switch"), /connection lost/); await until(() => driver.sessionFile?.endsWith("new.jsonl") === true);
    await driver.prompt("after switch"); await until(() => events.includes("after switch"));
    await until(async () => (await readFile(log, "utf8")).includes('"confirmed":false'));
    const session = driver.sessionFile!; await driver.stop(); assert.equal(exited, 0, "intentional stop must not report a crash");
    driver = make(); await driver.start({ resume: session }); assert.equal(driver.sessionFile, session);
    await driver.prompt("resumed"); await until(() => events.includes("resumed"));
  } finally { await driver.stop(); await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
});
