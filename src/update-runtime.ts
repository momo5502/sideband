import { REQUEST_TIMEOUT_MS, COMMAND_TIMEOUT_MS, INSTALL_TIMEOUT_MS } from "./timeouts.js";
import { randomUUID } from "node:crypto";
import { realpathSync, existsSync, readFileSync } from "node:fs";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { request } from "node:https";
import spawn from "cross-spawn";
import { stateDirectory } from "./room-profiles.js";
import { roomProxyAgent, roomProxyUrl } from "./room-proxy.js";
import { terminateTree } from "./process-tree.js";
import { validCommit, type BuildInfo, type LatestBuild } from "./update-types.js";

export const UPDATE_REPOSITORY = "https://github.com/momo5502/sideband.git";
export const runtimeDirectory = (directory = stateDirectory) => join(resolve(directory), "rt");
export const runtimePrefix = (directory: string, commit: string) => { if (!validCommit(commit)) throw new Error("Invalid update commit."); return join(runtimeDirectory(directory), commit.slice(0, 16)); };
export const runtimeEntry = (directory: string, commit: string) => join(runtimePrefix(directory, commit), "node_modules", "sideband", "dist", "src", "cli.js");
export async function privateJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`, file = await open(temporary, "wx", 0o600);
  try { await file.writeFile(JSON.stringify(value)); await file.sync(); await file.close(); await rename(temporary, path); }
  finally { await file.close().catch(() => {}); await unlink(temporary).catch(() => {}); }
}
export type ActiveRuntime = { commit: string; previous: string | null };
export async function activeRuntime(directory = stateDirectory, role?: "server" | "worker"): Promise<ActiveRuntime | undefined> {
  try { const value = JSON.parse(await readFile(join(runtimeDirectory(directory), role ? `${role}-active.json` : "active.json"), "utf8")); return validCommit(value.commit) && (value.previous === null || validCommit(value.previous)) ? value : undefined; }
  catch { return undefined; }
}
export function buildInfo(entry: string): BuildInfo {
  let root = dirname(realpathSync(entry));
  for (let i = 0; i < 8; i++, root = dirname(root)) {
    try {
      const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
      if (pkg.name !== "sideband" || typeof pkg.version !== "string") continue;
      let commit: string | undefined;
      try { const marker = JSON.parse(readFileSync(join(root, ".sideband-install.json"), "utf8")); if (validCommit(marker.commit) && marker.source === UPDATE_REPOSITORY) commit = marker.commit; } catch { /* Bootstrap installation. */ }
      return { version: pkg.version, ...(commit ? { commit } : {}) };
    } catch { /* Continue to the package root. */ }
  }
  throw new Error("Cannot locate the Sideband package version.");
}
export function redactUpdateOutput(value: string): string {
  return value.replace(/(https?:\/\/)[^\s/@]+(?::[^\s/@]*)?@/gi, "$1[redacted]@").replace(/(?:gh[pousr]_[A-Za-z0-9_]+|npm_[A-Za-z0-9_]+)/g, "[redacted]").slice(-4000);
}
export type RunUpdateCommand = (command: string, args: string[], options?: { timeout?: number; cwd?: string; signal?: AbortSignal; killTree?: boolean }) => Promise<string>;
export const runUpdateCommand: RunUpdateCommand = (command, args, options = {}) => new Promise((resolvePromise, reject) => {
  if (options.signal?.aborted) { reject(new Error("Update cancelled.")); return; }
  const child = spawn(command, args, { cwd: options.cwd, windowsHide: true, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_SSH_COMMAND: "ssh -oBatchMode=yes", npm_config_yes: "true" } });
  let stdout = "", stderr = "", settled = false, exited = false;
  let drain: NodeJS.Timeout | undefined;
  const cancelled = () => fail(new Error("Update cancelled."));
  const clean = () => { clearTimeout(timer); if (drain) clearTimeout(drain); options.signal?.removeEventListener("abort", cancelled); };
  const detach = () => { child.stdout?.destroy(); child.stderr?.destroy(); };
  const fail = (error: Error) => { if (settled) return; settled = true; clean(); if (!exited && child.exitCode === null && child.signalCode === null) { if (options.killTree === false) child.kill("SIGKILL"); else terminateTree(child); } detach(); reject(error); };
  const started = Date.now(), timeout = options.timeout ?? COMMAND_TIMEOUT_MS;
  const timer = setTimeout(() => fail(new Error(`${command} timed out after ${Math.round((Date.now() - started) / 1000)}s (limit ${timeout / 1000}s).`)), timeout);
  options.signal?.addEventListener("abort", cancelled, { once: true });
  child.stdout!.setEncoding("utf8"); child.stderr!.setEncoding("utf8");
  child.stdout!.on("data", value => { if (settled) return; stdout += value; if (stdout.length > 4 * 1024 * 1024) fail(new Error(`${command} produced too much output.`)); });
  child.stderr!.on("data", value => { if (!settled) stderr = (stderr + value).slice(-16000); });
  const finish = (code: number | null) => {
    if (settled) return; settled = true; clean(); detach();
    code === 0 ? resolvePromise(stdout) : reject(new Error(`${command} exited (${code}): ${redactUpdateOutput(stderr || stdout)}`));
  };
  child.once("error", fail); child.once("close", finish);
  child.once("exit", code => {
    exited = true; if (settled) return; clearTimeout(timer);
    // A background daemon may inherit these pipes. Bound the final output drain rather
    // than timing out a CLI that already exited, or killing its surviving descendants.
    drain = setTimeout(() => finish(code), 1000);
  });
});
async function latestManifest(commit: string): Promise<{ version: string }> {
  const url = `https://raw.githubusercontent.com/momo5502/sideband/${commit}/package.json`, signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const proxy = roomProxyUrl(url), agent = proxy ? roomProxyAgent(proxy, signal) : false;
  return new Promise((resolvePromise, reject) => {
    const req = request(url, { agent, signal, headers: { "User-Agent": "Sideband updater" } }, res => {
      if (res.statusCode !== 200) { res.resume(); reject(new Error(`Update manifest returned HTTP ${res.statusCode}.`)); return; }
      let body = ""; res.setEncoding("utf8"); res.on("data", chunk => { body += chunk; if (body.length > 128 * 1024) req.destroy(new Error("Update manifest is too large.")); });
      res.once("end", () => { try { const pkg = JSON.parse(body); if (pkg.name !== "sideband" || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(pkg.version)) throw new Error(); resolvePromise({ version: pkg.version }); } catch { reject(new Error("Invalid Sideband update manifest.")); } });
    });
    req.once("error", reject); req.once("close", () => { if (agent) agent.destroy(); }); req.end();
  });
}
export async function latestBuild(run: RunUpdateCommand = runUpdateCommand): Promise<LatestBuild> {
  const output = await run("git", ["ls-remote", UPDATE_REPOSITORY, "refs/heads/main"], { timeout: REQUEST_TIMEOUT_MS });
  const commit = /^([a-f0-9]{40})\s+refs\/heads\/main\s*$/m.exec(output)?.[1];
  if (!validCommit(commit)) throw new Error("Cannot resolve Sideband's main branch.");
  return { commit, ...(await latestManifest(commit)) };
}
export async function installRuntime(commit: string, directory = stateDirectory, run: RunUpdateCommand = runUpdateCommand): Promise<{ entry: string; build: BuildInfo }> {
  if (!validCommit(commit)) throw new Error("Invalid update commit.");
  const prefix = runtimePrefix(directory, commit), entry = runtimeEntry(directory, commit), root = join(prefix, "node_modules", "sideband");
  let installed = false; try { installed = buildInfo(entry).commit === commit; } catch { /* Retry an incomplete installation. */ }
  if (!installed) {
    await mkdir(prefix, { recursive: true, mode: 0o700 });
    await run("npm", ["install", "--prefix", prefix, "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund", `git+${UPDATE_REPOSITORY}#${commit}`], { timeout: INSTALL_TIMEOUT_MS });
    const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
    if (pkg.name !== "sideband" || typeof pkg.version !== "string" || !existsSync(entry)) throw new Error("Installed update is missing Sideband's CLI.");
    await privateJson(join(root, ".sideband-install.json"), { commit, source: UPDATE_REPOSITORY });
  }
  const version = await run(process.execPath, [entry, "--runtime-version"], { timeout: REQUEST_TIMEOUT_MS });
  if (!version.includes(commit)) throw new Error("The new Sideband runtime failed its version check. The current process is unchanged.");
  return { entry, build: buildInfo(entry) };
}
