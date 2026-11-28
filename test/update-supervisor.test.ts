import { testTimeout } from "./waits.js";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { privateJson, activeRuntime, runtimeDirectory, runtimeEntry } from "../src/update-runtime.js";

const target = "c".repeat(40), other = "d".repeat(40);
async function run(script: string, directory: string) {
  const child = spawn(process.execPath, [script], { env: { ...process.env, SIDEBAND_STATE_DIR: directory }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  let output = ""; child.stdout.on("data", data => { output += data; }); child.stderr.on("data", data => { output += data; });
  const timer = setTimeout(() => child.kill(), testTimeout(15000));
  try { const code = await new Promise<number | null>((resolvePromise, reject) => { child.once("error", reject); child.once("exit", resolvePromise); }); return { code, output }; }
  finally { clearTimeout(timer); }
}

for (const fails of [false, true]) test(`supervisor ${fails ? "rolls back a failed switch" : "switches runtime and preserves argv"} without changing another role`, async () => {
  const directory = await mkdtemp(join(tmpdir(), "sideband-supervisor-"));
  try {
    const base = join(directory, "bootstrap.mjs"), next = runtimeEntry(directory, target), script = join(directory, "supervisor.mjs");
    await mkdir(dirname(next), { recursive: true });
    const rt = runtimeDirectory(directory), once = join(directory, "once");
    await writeFile(base, `import { existsSync, writeFileSync } from 'node:fs';
if (existsSync(${JSON.stringify(once)})) { console.log('restored bootstrap'); process.send({type:'sideband.ready'}); process.disconnect(); }
else { writeFileSync(${JSON.stringify(once)},'1'); writeFileSync(${JSON.stringify(join(rt, "worker-active.json"))},JSON.stringify({commit:'${target}',previous:null}));
writeFileSync(${JSON.stringify(join(rt, "worker-update.json"))},JSON.stringify({attempt:'test-attempt',phase:'restarting',target:'${target}',plugins:[]}));
process.send({type:'sideband.restart',args:['worker','--profile','selected-profile','--name','literal space']},()=>process.exit(75)); }`);
    await writeFile(next, fails ? "process.exit(1);" : "console.log(JSON.stringify(process.argv.slice(2))); process.send({type:'sideband.ready'}); process.disconnect();");
    await privateJson(join(rt, "server-active.json"), { commit: other, previous: null });
    await writeFile(script, `import { supervise } from ${JSON.stringify(pathToFileURL(resolve("dist/src/update-supervisor.js")).href)}; process.exitCode=await supervise(${JSON.stringify(base)},['worker'],${JSON.stringify(directory)});`);
    const result = await run(script, directory); assert.equal(result.code, 0, result.output);
    assert.equal((await activeRuntime(directory, "server"))?.commit, other);
    if (fails) {
      assert.match(result.output, /restored bootstrap/); assert.equal(await activeRuntime(directory, "worker"), undefined);
      const status = JSON.parse(await readFile(join(rt, "worker-update.json"), "utf8")); assert.equal(status.phase, "failed"); assert.equal(status.attempt, "test-attempt");
    } else {
      assert.match(result.output, /selected-profile/); assert.match(result.output, /literal space/); assert.equal((await activeRuntime(directory, "worker"))?.commit, target);
      assert.equal((await activeRuntime(directory))?.commit, target);
    }
  } finally { assert.ok(directory.startsWith(join(tmpdir(), "sideband-supervisor-"))); await rm(directory, { recursive: true, force: true }); }
});

test("ordinary startup failure does not roll back an installed runtime", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sideband-supervisor-"));
  try {
    const next = runtimeEntry(directory, target), base = join(directory, "base.mjs"), script = join(directory, "supervisor.mjs");
    await mkdir(dirname(next), { recursive: true }); await writeFile(next, "console.error('bad profile');process.exit(1);"); await writeFile(base, "process.exit(0)");
    await privateJson(join(runtimeDirectory(directory), "worker-active.json"), { commit: target, previous: null });
    await writeFile(script, `import { supervise } from ${JSON.stringify(pathToFileURL(resolve("dist/src/update-supervisor.js")).href)};process.exitCode=await supervise(${JSON.stringify(base)},['worker'],${JSON.stringify(directory)});`);
    const result = await run(script, directory); assert.equal(result.code, 1); assert.match(result.output, /bad profile/);
    assert.equal((await activeRuntime(directory, "worker"))?.commit, target);
  } finally { assert.ok(directory.startsWith(join(tmpdir(), "sideband-supervisor-"))); await rm(directory, { recursive: true, force: true }); }
});

test("run uses the server runtime slot and keeps its foreground command across an update", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sideband-supervisor-run-"));
  try {
    const base = join(directory, "base.mjs"), next = runtimeEntry(directory, target), script = join(directory, "supervisor.mjs"), rt = runtimeDirectory(directory);
    await mkdir(dirname(next), { recursive: true });
    await writeFile(base, `import{writeFileSync}from'node:fs';writeFileSync(${JSON.stringify(join(rt, "server-active.json"))},JSON.stringify({commit:'${target}',previous:null}));process.send({type:'sideband.restart',args:['run','--no-browser']},()=>process.exit(75));`);
    await writeFile(next, "console.log('updated '+process.argv.slice(2).join(' '));process.send({type:'sideband.ready'});process.disconnect();");
    await privateJson(join(rt, "worker-active.json"), { commit: other, previous: null });
    await writeFile(script, `import{supervise}from ${JSON.stringify(pathToFileURL(resolve("dist/src/update-supervisor.js")).href)};process.exitCode=await supervise(${JSON.stringify(base)},['run'],${JSON.stringify(directory)});`);
    const result = await run(script, directory); assert.equal(result.code, 0, result.output); assert.match(result.output, /updated run --no-browser/);
    assert.equal((await activeRuntime(directory, "worker"))?.commit, other); assert.equal((await activeRuntime(directory, "server"))?.commit, target);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
