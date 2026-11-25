import { testTimeout } from "./waits.js";
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { updateHarnessPlugins, officialSidebandSource } from "../src/plugin-updates.js";
import { activeRuntime, buildInfo, installRuntime, privateJson, runtimeEntry, runtimeDirectory, runUpdateCommand, UPDATE_REPOSITORY, type RunUpdateCommand } from "../src/update-runtime.js";
import { RuntimeUpdater } from "../src/updater.js";
import { UpdateFleet } from "../src/update-fleet.js";
import type { Machine } from "../src/orchestration-protocol.js";
import { until } from "./browser-fixture.js";

const target = "a".repeat(40), previous = "b".repeat(40), entry = resolve("dist/src/cli.js");
async function temporary() {
  const directory = await mkdtemp(join(tmpdir(), "sideband-update-"));
  return { directory, async close() { assert.ok(directory.startsWith(join(tmpdir(), "sideband-update-"))); await rm(directory, { recursive: true, force: true }); } };
}
async function candidate(directory: string, commit = target) {
  const cli = runtimeEntry(directory, commit), root = resolve(dirname(cli), "../..");
  await mkdir(dirname(cli), { recursive: true });
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "sideband", type: "module", version: "99.0.0" }));
  await writeFile(cli, `console.log('sideband 99.0.0 ${commit}');`);
  return cli;
}

test("plugin refresh uses official installed sources, exact Codex marketplace command and real Claude metadata", async () => {
  const temp = await temporary(), path = join(temp.directory, "node_modules", "sideband");
  await mkdir(path, { recursive: true }); await writeFile(join(temp.directory, "package.json"), JSON.stringify({ dependencies: { sideband: "github:momo5502/sideband#main" } }));
  const calls: string[] = [], counts = new Map<string, number>();
  const run: RunUpdateCommand = async (command, args, options) => {
    calls.push(`${command} ${args.join(" ")}`);
    if (command === "codex") { assert.equal(args[0], "--no-daemon"); assert.equal(options?.killTree, false); args = args.slice(1); }
    if (args.includes("list")) assert.equal(options?.timeout, 120_000, "metadata queries allow a loaded machine two minutes");
    if (command === "codex" && args[1] === "list") { assert.deepEqual(args, ["plugin", "list", "--marketplace", "sideband", "--json"]); args = [...args.slice(0, 2), ...args.slice(4)]; }
    if (args.join(" ") === "plugin marketplace list --json") return JSON.stringify([{ name: "sideband", source: "github", repo: "momo5502/sideband" }]);
    if (args.join(" ") === "plugin list --json") {
      const count = counts.get(command) ?? 0; counts.set(command, count + 1); const version = count ? "99.0.0" : "0.20.0";
      return JSON.stringify(command === "omp" ? { npm: [{ name: "sideband", version, path }] } : command === "claude" ? [{ id: "sideband@sideband", version, scope: "user" }] : { installed: [{ pluginId: "sideband@sideband", version, marketplaceSource: { sourceType: "git", source: "git@github.com:momo5502/sideband.git" } }] });
    }
    return "updated";
  };
  try {
    const results = await updateHarnessPlugins(run);
    assert.ok(results.slice(0, 3).every(result => result.state === "updated" && result.from === "0.20.0" && result.to === "99.0.0" && result.restartRequired));
    assert.ok(calls.includes("omp plugin upgrade sideband"));
    assert.ok(calls.includes("claude plugin update sideband@sideband --json -y --scope user"));
    assert.ok(calls.includes("codex --no-daemon plugin marketplace upgrade sideband"));
    assert.ok(!calls.some(call => /plugin (add|install|remove)/.test(call)));
  } finally { await temp.close(); }
});

test("plugin refresh failures identify the Codex operation that timed out", async () => {
  const results = await updateHarnessPlugins(async (command, args) => {
    if (command !== "codex") return "[]";
    if (args.includes("upgrade")) throw new Error("codex timed out.");
    return JSON.stringify({ installed: [{ pluginId: "sideband@sideband", version: "0.22.0", marketplaceSource: { sourceType: "git", source: UPDATE_REPOSITORY } }] });
  });
  assert.equal(results[2]!.state, "failed"); assert.equal(results[2]!.message, "Refresh marketplace: codex timed out.");
});

test("update commands settle after parent exit without waiting for or killing inherited-pipe descendants", { timeout: testTimeout(20000) }, async () => {
  const temp = await temporary();
  try {
    for (const mode of [0, 7, "timeout"] as const) {
      const marker = join(temp.directory, `descendant-${mode}.pid`);
      const parent = `import{spawn}from'node:child_process';import{writeFileSync}from'node:fs';
const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:['ignore',1,2],windowsHide:true,detached:process.platform==='win32'});
writeFileSync(process.argv[1],String(child.pid));child.unref();
${mode === "timeout" ? "setInterval(()=>{},1000);" : `process.stdout.write('parent-finished',()=>process.exit(${mode}));`}`;
      try {
        const result = runUpdateCommand(process.execPath, ["--input-type=module", "-e", parent, marker], { timeout: 4000, killTree: false });
        if (mode === 0) assert.equal(await result, "parent-finished");
        else await assert.rejects(result, mode === "timeout" ? /timed out/ : /exited \(7\): parent-finished/);
        const pid = Number(await readFile(marker, "utf8"));
        assert.doesNotThrow(() => process.kill(pid, 0), "the updater must leave the surviving descendant running");
      } finally {
        const pid = Number(await readFile(marker, "utf8").catch(() => "0"));
        if (Number.isSafeInteger(pid) && pid > 0 && pid !== process.pid) try { process.kill(pid, "SIGKILL"); } catch { /* Own fixture already exited. */ }
      }
    }
  } finally { await temp.close(); }
});

test("missing, absent and local plugins are skipped; individual failures do not stop other harness checks", async () => {
  const calls: string[] = [];
  const results = await updateHarnessPlugins(async (command, args) => {
    calls.push(`${command} ${args.join(" ")}`);
    if (command === "omp") throw Object.assign(new Error("missing"), { code: "ENOENT" });
    if (command === "claude") return "[]";
    return JSON.stringify({ installed: [{ pluginId: "sideband@sideband", version: "1.0", marketplaceSource: { sourceType: "local", source: "C:/local" } }] });
  });
  assert.deepEqual(results.map(result => result.state), ["skipped", "skipped", "skipped", "skipped"]);
  assert.equal(calls.length, 3);
  const errors = await updateHarnessPlugins(async command => { if (command === "omp") throw new Error("broken metadata"); return "[]"; });
  assert.equal(errors[0]!.state, "failed"); assert.equal(errors.length, 4);
  for (const source of ["https://evil.example/sideband", "git@github.com:other/sideband.git", "file:/local"]) assert.equal(officialSidebandSource(source), false);
});

test("runtime installer pins the fixed repository and SHA, verifies executable, and retries partial installs", async () => {
  const temp = await temporary(), calls: string[][] = [];
  // A left-over CLI without package metadata must not prevent retry.
  await mkdir(dirname(runtimeEntry(temp.directory, target)), { recursive: true }); await writeFile(runtimeEntry(temp.directory, target), "partial");
  const run: RunUpdateCommand = async (command, args, options) => {
    calls.push([command, ...args]);
    if (command === "npm") { await candidate(temp.directory); return ""; }
    return runUpdateCommand(command, args, options);
  };
  try {
    const result = await installRuntime(target, temp.directory, run);
    assert.equal(result.build.commit, target); assert.equal(result.build.version, "99.0.0");
    assert.ok(calls[0]!.includes(`git+${UPDATE_REPOSITORY}#${target}`)); assert.ok(calls[0]!.includes("--ignore-scripts"));
    await installRuntime(target, temp.directory, run); assert.equal(calls.filter(call => call[0] === "npm").length, 1);
    await assert.rejects(installRuntime("main; arbitrary", temp.directory, run), /Invalid update commit/);
    const environment = await runUpdateCommand(process.execPath, ["-e", "console.log(process.env.GIT_TERMINAL_PROMPT + ' ' + process.env.GIT_SSH_COMMAND)"]);
    assert.match(environment, /0 ssh -oBatchMode=yes/);
  } finally { await temp.close(); }
});

test("updater activates only its role after installation/plugins and preserves partial plugin failures across restart", async () => {
  const temp = await temporary(), order: string[] = [];
  try {
    await privateJson(join(runtimeDirectory(temp.directory), "server-active.json"), { commit: previous, previous: null });
    const install = async () => { order.push("install"); const cli = await candidate(temp.directory); await privateJson(join(resolve(dirname(cli), "../.."), ".sideband-install.json"), { commit: target, source: UPDATE_REPOSITORY }); return { entry: cli, build: buildInfo(cli) }; };
    const updater = new RuntimeUpdater("worker", entry, temp.directory, async () => { order.push("restart"); }, undefined, install, async () => { order.push("plugins"); return [{ harness: "codex", state: "failed", message: "SSH unavailable" }]; });
    updater.start(target); assert.throws(() => updater.start(target), /already running/);
    await updater.idle(); assert.deepEqual(order, ["install", "plugins", "restart"]);
    assert.equal((await activeRuntime(temp.directory, "worker"))?.commit, target); assert.equal((await activeRuntime(temp.directory, "server"))?.commit, previous);
    const restored = new RuntimeUpdater("worker", runtimeEntry(temp.directory, target), temp.directory, async () => {}); await restored.restore();
    assert.equal(restored.state.phase, "done"); assert.match(restored.state.message, /plugins need attention/); assert.equal(restored.state.attempt, updater.state.attempt);
    assert.equal(restored.state.plugins[0]!.state, "failed");
  } finally { await temp.close(); }
});

test("installation or restart failure keeps the previous role selection and reports failure", async () => {
  for (const fail of ["install", "restart"]) {
    const temp = await temporary();
    try {
      await privateJson(join(runtimeDirectory(temp.directory), "worker-active.json"), { commit: previous, previous: null });
      const updater = new RuntimeUpdater("worker", entry, temp.directory, async () => { throw new Error("restart refused"); }, undefined,
        async () => { if (fail === "install") throw new Error("npm failed"); return { entry, build: { version: "99.0.0", commit: target } }; }, async () => []);
      updater.start(target); await updater.idle(); assert.equal(updater.state.phase, "failed");
      assert.equal((await activeRuntime(temp.directory, "worker"))?.commit, previous); assert.match(updater.state.message, fail === "install" ? /npm failed/ : /restart refused/);
    } finally { await temp.close(); }
  }
});

test("a current worker can retry plugin failures without restarting its runtime", async () => {
  const temp = await temporary(); let restarted = false;
  try {
    const cli = await candidate(temp.directory); await privateJson(join(resolve(dirname(cli), "../.."), ".sideband-install.json"), { commit: target, source: UPDATE_REPOSITORY });
    const updater = new RuntimeUpdater("worker", cli, temp.directory, async () => { restarted = true; }, undefined,
      async () => ({ entry: cli, build: buildInfo(cli) }), async () => [{ harness: "codex", state: "updated", message: "Refreshed" }]);
    updater.start(target); await updater.idle(); assert.equal(updater.state.phase, "done"); assert.equal(restarted, false); assert.equal(updater.state.plugins[0]!.state, "updated");
    const machine: Machine = { id: randomUUID(), name: "current", platform: "test", harnesses: [], online: true, updater: true, build: updater.build,
      update: { ...updater.state, plugins: [{ harness: "codex", state: "failed", message: "retry me" }] } };
    const fleet = new UpdateFleet(updater, () => [machine], async () => ({}), async () => ({ version: "99.0.0", commit: target }));
    await fleet.check(); assert.equal(fleet.state.available, true); fleet.close();
  } finally { await temp.close(); }
});

test("updater idle waits for the terminal status write and install-lock cleanup", async () => {
  const temp = await temporary(); let release!: () => void, saving = false, settled = false;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const updater = new RuntimeUpdater("worker", entry, temp.directory, async () => {}, undefined,
    async () => ({ entry, build: { version: "99.0.0", commit: target } }), async () => []);
  updater.build.commit = target;
  const internals = updater as unknown as { save(): Promise<void> }, originalSave = internals.save.bind(updater);
  internals.save = async () => { if (updater.state.phase === "done") { saving = true; await gate; } await originalSave(); };
  try {
    await updater.idle(); // No update has started yet.
    updater.start(target); await until(() => saving);
    assert.equal(updater.state.phase, "done", "the visible phase can precede durable completion");
    const idle = updater.idle().then(() => { settled = true; });
    await Promise.resolve(); assert.equal(settled, false);
    assert.equal(await readFile(join(runtimeDirectory(temp.directory), "install.lock"), "utf8"), String(process.pid));
    release(); await idle;
    await assert.rejects(readFile(join(runtimeDirectory(temp.directory), "install.lock")), { code: "ENOENT" });
    assert.equal(JSON.parse(await readFile(join(runtimeDirectory(temp.directory), "worker-update.json"), "utf8")).phase, "done");
  } finally { release(); await updater.idle(); await temp.close(); }
});

test("fleet ignores stale failures, waits for new attempts and updates server last", async () => {
  const temp = await temporary(), order: string[] = [], attempt = randomUUID();
  const machines: Machine[] = [{ id: randomUUID(), name: "worker", platform: "test", harnesses: [], online: true, updater: true,
    update: { target, attempt: randomUUID(), phase: "failed", message: "old failure", plugins: [], at: 0 } },
    { id: randomUUID(), name: "offline", platform: "test", harnesses: [], online: false }];
  const updater = new RuntimeUpdater("server", entry, temp.directory, async () => {}); updater.start = () => { order.push("server"); };
  const fleet = new UpdateFleet(updater, () => machines, async () => { order.push("worker"); return { attempt }; }, async () => ({ version: "99.0.0", commit: target }));
  try {
    await fleet.check(); fleet.start(); await until(() => order.includes("worker"));
    await new Promise(resolve => setTimeout(resolve, 30)); assert.deepEqual(order, ["worker"]);
    machines[0]!.build = { version: "99.0.0", commit: target }; machines[0]!.update = { target, attempt, phase: "done", message: "updated", plugins: [], at: 1 };
    await until(() => order.includes("server")); assert.deepEqual(order, ["worker", "server"]); assert.equal(fleet.state.workers[1]!.state, "skipped");
  } finally { fleet.close(); await temp.close(); }
});

test("cancelling an update during installation prevents activation and restart", async () => {
  const temp = await temporary(); let release!: () => void, installing = false, restarted = false;
  const gate = new Promise<void>(resolvePromise => { release = resolvePromise; });
  const updater = new RuntimeUpdater("worker", entry, temp.directory, async () => { restarted = true; }, undefined, async () => {
    installing = true; await gate; return { entry, build: { version: "99.0.0", commit: target } };
  });
  try {
    updater.start(target); await until(() => installing); updater.close(); release(); await updater.idle(); assert.equal(updater.state.phase, "failed");
    assert.equal(restarted, false); assert.equal(await activeRuntime(temp.directory, "worker"), undefined);
    const cancelled = new AbortController(); cancelled.abort();
    await assert.rejects(runUpdateCommand(process.execPath, ["-e", "process.exit(0)"], { signal: cancelled.signal }), /cancelled/);
  } finally { release(); await temp.close(); }
});

test("fleet reports failed and bootstrap-only workers, keeps server running, and cancels cleanly", async () => {
  const temp = await temporary(); const updater = new RuntimeUpdater("server", entry, temp.directory, async () => {});
  let serverStarts = 0; updater.start = () => { serverStarts++; };
  const machine: Machine = { id: randomUUID(), name: "old", platform: "test", harnesses: [], online: true };
  const fleet = new UpdateFleet(updater, () => [machine], async () => { throw new Error("npm failed"); }, async () => ({ version: "99.0.0", commit: target }));
  try {
    await fleet.check(); fleet.start(); await until(() => fleet.state.phase === "failed"); assert.equal(fleet.state.workers[0]!.state, "unsupported"); assert.equal(serverStarts, 0);
    machine.updater = true; fleet.start(); await until(() => fleet.state.phase === "failed"); assert.match(fleet.state.workers[0]!.message, /npm failed/); assert.equal(serverStarts, 0);
  } finally { fleet.close(); await temp.close(); }
});
