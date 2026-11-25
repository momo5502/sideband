import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { detectInstallHarnesses, installHarnessPlugin, selectedHarnesses } from "../src/plugin-install.js";
import { updatePiPlugin } from "../src/plugin-updates.js";
import type { RunUpdateCommand } from "../src/update-runtime.js";

test("installer detects CLIs independently and validates explicit selection without installing anything", async () => {
  const calls: string[][] = [];
  const result = await detectInstallHarnesses(async (command, args, options) => {
    assert.deepEqual(args, ["--version"]); assert.equal(options?.killTree, false); calls.push([command, ...args]);
    if (command === "pi") throw Object.assign(new Error("missing"), { code: "ENOENT" });
    return `${command} 1.2.3\n`;
  });
  assert.equal(calls.length, 4); assert.equal(result.filter(item => item.version).length, 3); assert.equal(result[3]!.error, "CLI not found");
  assert.deepEqual(selectedHarnesses(["codex, PI", "codex", "claude"]), ["codex", "pi", "claude"]);
  assert.throws(() => selectedHarnesses(["unknown"])); assert.throws(() => selectedHarnesses([""]));
});
test("OMP installation reports legacy Git rejection and preserves existing sources", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sideband-omp-installer-")), path = join(directory, "node_modules", "sideband");
  let installed = false, legacy = true; const mutations: string[][] = [];
  const run: RunUpdateCommand = async (command, args) => {
    assert.equal(command, "omp");
    if (args.includes("list")) return JSON.stringify({ npm: installed ? [{ name: "sideband", path }] : [] });
    assert.deepEqual(args, ["plugin", "install", "github:momo5502/sideband#main"]); mutations.push(args);
    if (legacy) throw new Error("omp exited (1): Failed to install github:momo5502/sideband#main: Error: Invalid package name: github:momo5502/sideband#main");
    return "installed";
  };
  try {
    await mkdir(path, { recursive: true }); await writeFile(join(directory, "package.json"), JSON.stringify({ dependencies: { sideband: "github:momo5502/sideband#main" } }));
    const failure = await installHarnessPlugin("omp", run); assert.equal(failure.state, "failed"); assert.match(failure.message, /omp update.*sideband install --harness omp/); assert.equal(mutations.length, 1, "never retry another Git alias or upgrade the harness automatically");
    legacy = false; assert.equal((await installHarnessPlugin("omp", run)).state, "installed"); assert.equal(mutations.length, 2);
    installed = true; assert.equal((await installHarnessPlugin("omp", run)).state, "present"); assert.equal(mutations.length, 2);
    await writeFile(join(directory, "package.json"), JSON.stringify({ dependencies: { sideband: "github:other/sideband" } }));
    assert.equal((await installHarnessPlugin("omp", run)).state, "failed"); assert.equal(mutations.length, 2);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
for (const harness of ["codex", "claude"] as const) test(`${harness} installer reuses only official marketplaces and never replaces a fork`, async () => {
  let present = false, official = true, existingMarketplace = true; const calls: string[][] = [];
  const run: RunUpdateCommand = async (command, original, options) => {
    assert.equal(options?.cwd, homedir());
    if (harness === "codex") { assert.equal(original[0], "--no-daemon"); assert.equal(options?.killTree, false); }
    const args = harness === "codex" ? original.slice(1) : original; calls.push(args);
    if (args.join(" ") === "plugin marketplace list --json") {
      const item = { name: "sideband", ...(harness === "codex" ? { marketplaceSource: { sourceType: "git", source: official ? "git@github.com:momo5502/sideband.git" : "https://github.com/other/sideband" } } : { source: "github", repo: official ? "momo5502/sideband" : "other/sideband" }) };
      return JSON.stringify(harness === "codex" ? { marketplaces: existingMarketplace ? [item] : [] } : existingMarketplace ? [item] : []);
    }
    if (args[1] === "list") return JSON.stringify(harness === "codex" ? { installed: present ? [{ pluginId: "sideband@sideband" }] : [] } : present ? [{ id: "sideband@sideband", scope: "user" }] : []);
    return "ok";
  };
  assert.equal((await installHarnessPlugin(harness, run)).state, "installed"); assert.ok(!calls.some(args => args[2] === "add"));
  present = true; calls.length = 0; assert.equal((await installHarnessPlugin(harness, run)).state, "present"); assert.equal(calls.length, 2);
  official = false; calls.length = 0; assert.equal((await installHarnessPlugin(harness, run)).state, "failed"); assert.equal(calls.length, 1);
  existingMarketplace = false; present = false; calls.length = 0; assert.equal((await installHarnessPlugin(harness, run)).state, "installed");
  assert.ok(calls.some(args => args.slice(0, 4).join(" ") === "plugin marketplace add momo5502/sideband"));
});
test("PI install and refresh target only Sideband, preserve pins and accept equivalent Git sources", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sideband-pi-install-")), calls: string[][] = [];
  const packageRoot = join(directory, "git", "github.com", "momo5502", "sideband"); let version = "1.0.0";
  const run: RunUpdateCommand = async (command, args, options) => { assert.equal(command, "pi"); assert.equal(options?.cwd, homedir()); calls.push(args); version = "1.1.0"; await writeFile(join(packageRoot, "package.json"), JSON.stringify({ version })); return "ok"; };
  try {
    await mkdir(packageRoot, { recursive: true }); await writeFile(join(packageRoot, "package.json"), JSON.stringify({ version }));
    assert.equal((await installHarnessPlugin("pi", run, directory)).state, "installed");
    assert.deepEqual(calls[0], ["install", "git:github.com/momo5502/sideband", "--no-approve"]);
    for (const source of ["git:github.com/momo5502/sideband", "https://github.com/momo5502/sideband.git", "ssh://git@github.com/momo5502/sideband", "git:git@github.com:momo5502/sideband.git@main"]) {
      await writeFile(join(directory, "settings.json"), JSON.stringify({ packages: [{ source }] })); calls.length = 0;
      assert.equal((await installHarnessPlugin("pi", run, directory)).state, "present"); assert.equal(calls.length, 0);
      assert.equal((await updatePiPlugin(run, directory)).state, "updated");
      assert.deepEqual(calls[0], ["update", "--extension", "git:github.com/momo5502/sideband", "--no-approve"]);
    }
    await writeFile(join(directory, "settings.json"), JSON.stringify({ packages: ["git:github.com/momo5502/sideband@v0.25.0"] })); calls.length = 0;
    assert.equal((await updatePiPlugin(run, directory)).state, "skipped"); assert.equal(calls.length, 0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
