import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { ManagedTerminal } from "../src/managed-terminal.js";

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check: () => boolean | Promise<boolean>) { const end = Date.now() + 10000; while (!(await check())) { if (Date.now() > end) throw new Error("Terminal fixture timed out."); await pause(20); } }
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const fixtureCode = `import {connect} from "node:net";
import {writeFile,access} from "node:fs/promises";
import {join} from "node:path";
import {readLocal,writeLocal} from ${JSON.stringify(new URL("../src/local-wire.js", import.meta.url).href)};
await writeFile("pid.txt",String(process.pid));
await access(process.argv[process.argv.indexOf("-e")+1]);
if(process.argv.includes("--no-plugin")){setInterval(()=>{},1000)} else {
 const bootstrap=JSON.parse(process.env.SIDEBAND_MANAGED_BRIDGE);const socket=connect(bootstrap.port,"127.0.0.1");
 const sessionFile=join(process.argv[process.argv.indexOf("--session-dir")+1],"fixture.jsonl");let seq=0;
 socket.once("connect",()=>writeLocal(socket,{type:"hello",role:"plugin",token:bootstrap.token,sessionFile,hasUI:true,mode:"tui"}));
 readLocal(socket,p=>{if(p.type!=="command")return;
 writeLocal(socket,{type:"reply",id:p.id,result:{accepted:true}});
 if(p.method==="prompt"||p.method==="aside")writeLocal(socket,{type:"events",events:[{seq:++seq,kind:"assistant",text:p.text}]});
 if((p.method==="shutdown"&&!process.argv.includes("--ignore-shutdown"))||p.text==="close-window"){socket.end();process.exit(0)}
 });
}
`;
async function fixture(args: string[] = [], linked = false) {
  const directory = await mkdtemp(join(tmpdir(), "sideband-native-terminal-")); let entry = resolve("dist/src/cli.js");
  if (linked) { const link = join(directory, "linked-cli"); await symlink(dirname(entry), link, process.platform === "win32" ? "junction" : "dir"); entry = join(link, "cli.js"); }
  const code = join(directory, "omp.mjs"); await writeFile(code, fixtureCode);
  const events: { kind: string; text: string }[] = []; let exits = 0;
  const driver = new ManagedTerminal({ command: process.execPath, args: [code, ...args] }, directory, join(directory, "sessions"), {
    event: (kind, text) => events.push({ kind, text }), state: () => {}, exit: () => { exits++; }, tool: async () => ({}),
  }, entry, (_launcher, script) => spawn(process.execPath, [entry, "terminal-agent", script.replace(/\.(cmd|command|sh)$/, ".json")], { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] }),
  () => ({ kind: "window", command: "fixture" }));
  return { directory, driver, events, get exits() { return exits; }, async pid() { return Number(await readFile(join(directory, "pid.txt"), "utf8")); },
    async close() { await driver.stop(); assert.ok(directory.startsWith(join(tmpdir(), "sideband-native-terminal-"))); await rm(directory, { recursive: true, force: true }); } };
}
test("native driver sends private instructions/asides and cleans up after a local window close", { timeout: 20000 }, async () => {
  const f = await fixture();
  try {
    await f.driver.start({}); const pid = await f.pid(); assert.equal(alive(pid), true);
    await f.driver.prompt("web instructions"); await f.driver.deliver("room aside");
    await until(() => f.events.some(event => event.text === "room aside"));
    assert.ok(f.events.some(event => event.text === "web instructions"));
    const closing = f.driver.prompt("close-window"); void closing.catch(() => {}); await until(() => f.exits === 1 && !alive(pid));
    await until(async () => !(await readdir(f.directory)).some(name => /^terminal-.*\.(cmd|command|sh|json)$/.test(name)));
    assert.ok(f.driver.sessionFile?.endsWith("fixture.jsonl"));
  } finally { await f.close(); }
});
test("native launch resolves companion plugin assets through an npm-style linked CLI", { timeout: 20000 }, async () => {
  const f = await fixture([], true);
  try { await f.driver.start({}); await f.driver.prompt("linked entry works"); await until(() => f.events.some(event => event.text === "linked entry works")); }
  finally { await f.close(); }
});
for (const flag of ["--no-plugin", "--ignore-shutdown"]) test(`stop waits for actual OMP termination when ${flag}`, { timeout: 20000 }, async () => {
  const f = await fixture([flag]); let startup: Promise<void> | undefined;
  try {
    startup = f.driver.start({}); void startup.catch(() => {});
    await until(async () => { try { return alive(await f.pid()); } catch { return false; } });
    if (flag === "--ignore-shutdown") await startup;
    const pid = await f.pid(); await f.driver.stop();
    if (flag === "--no-plugin") await assert.rejects(startup, /stopped/);
    await until(() => !alive(pid));
    assert.equal((await readdir(f.directory)).some(name => /^terminal-.*\.(cmd|command|sh|json)$/.test(name)), false);
  } finally { await f.close(); }
});
