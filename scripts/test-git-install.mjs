// Exercise npm's global Git dependency path, not a tarball/local directory install.
import { mkdtemp, readFile, rm } from "node:fs/promises";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const prefix = await mkdtemp(join(tmpdir(), "sideband-install-"));
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error("Run through npm run test:install.");
function run(args, env = {}) {
  const result = spawnSync(process.execPath, args, { cwd: root, stdio: "inherit", windowsHide: true, env: { ...process.env, ...env } });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Installation check failed (${result.status}).`);
}
try {
  // CI does not need GitHub credentials; npm clones the committed local Git repository.
  const source = process.argv[2] ?? `git+${pathToFileURL(root).href}`;
  run([npmCli, "install", "--global", "--prefix", prefix, "--no-audit", "--no-fund", source]);
  const installed = join(prefix, ...(process.platform === "win32" ? [] : ["lib"]), "node_modules", "sideband");
  if (!process.argv[2]) assert.equal(JSON.parse(await readFile(join(installed, "package.json"), "utf8")).version, JSON.parse(await readFile(join(root, "package.json"), "utf8")).version);
  run([join(installed, "dist/src/cli.js"), "--runtime-version"]);
  // Inspect this candidate, rather than forwarding --help to a previously activated runtime.
  run([join(installed, "dist/src/cli.js"), "--help"], { SIDEBAND_RUNTIME_SELECTED: "1" });
  run([join(root, "scripts/smoke-installed.mjs"), installed]);
} finally {
  // mkdtemp creates a unique, explicitly scoped test prefix; never remove a user install.
  if (!prefix.startsWith(join(tmpdir(), "sideband-install-"))) throw new Error("Unsafe test prefix.");
  await rm(prefix, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
