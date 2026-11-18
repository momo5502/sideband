import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, realpath, rename, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { REQUEST_TIMEOUT_MS } from "./timeouts.js";
import { lock } from "proper-lockfile";

type JsonObject = Record<string, unknown>;
function object(value: unknown): value is JsonObject { return !!value && typeof value === "object" && !Array.isArray(value); }
export function claudeConfigFile(home = homedir(), configDirectory = process.env.CLAUDE_CONFIG_DIR, customOAuth = process.env.CLAUDE_CODE_CUSTOM_OAUTH_URL): string {
  return join(configDirectory ? resolve(configDirectory) : home, `.claude${customOAuth ? "-custom-oauth" : ""}.json`);
}
async function contents(file: string): Promise<string | undefined> {
  try { return await readFile(file, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}
function parse(source: string | undefined): JsonObject {
  let value: unknown;
  try { value = source === undefined ? {} : JSON.parse(source); } catch { throw new Error("Claude configuration is not valid JSON. Fix it in Claude before recording trust."); }
  if (!object(value) || value.projects !== undefined && !object(value.projects)) throw new Error("Claude configuration has an invalid projects object. No trust was changed.");
  return value;
}

/** Only the worker's configured root is accepted; the browser cannot supply a path.
 * Share Claude's config lock and merge against its latest document. Keep the
 * configured lock path even when the config itself is a symlink.
 * Never return or log the configuration: it can contain account information.
 */
export async function trustClaudeWorkspaces(root: string, file = claudeConfigFile()): Promise<{ root: string }> {
  if (await contents(file) === undefined) throw new Error("Run Claude once on this machine, then retry recording trust.");
  await mkdir(root, { recursive: true });
  const workspace = resolve(root).replaceAll("\\", "/"), canonical = (await realpath(root)).replaceAll("\\", "/");
  const roots = [...new Set([workspace, canonical])];
  const lockPath = `${file}.lock`, deadline = Date.now() + REQUEST_TIMEOUT_MS;
  let release: (() => Promise<void>) | undefined, compromised: Error | undefined;
  while (!release) {
    try { release = await lock(file, { lockfilePath: lockPath, realpath: false, stale: 10000, update: 5000, retries: 0, onCompromised: error => { compromised = error; } }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ELOCKED") throw error;
      if (Date.now() >= deadline) throw new Error("Claude's configuration is busy. Retry recording trust after it finishes saving.");
      await delay(250);
    }
  }
  const checkLock = () => { if (compromised) throw new Error("Claude configuration lock was lost. Retry recording trust."); };
  try {
    // Resolve profile symlinks instead of replacing the link with a different config.
    file = await realpath(file);
    for (let attempt = 0; attempt < 8; attempt++) {
      checkLock();
      const before = await contents(file);
      if (before === undefined) throw new Error("Claude's configuration disappeared. Run Claude once and retry.");
      const config = parse(before), projects = config.projects as JsonObject | undefined ?? {};
      const normalize = (path: string) => process.platform === "win32" ? path.replaceAll("\\", "/").toLowerCase() : path;
      if (roots.every(key => object(projects[key]) && projects[key].hasTrustDialogAccepted === true)) return { root: workspace };
      const merged = { ...projects };
      for (const key of roots) {
        const existing = Object.keys(projects).find(path => normalize(path) === normalize(key));
        const prior = projects[existing ?? key];
        if (prior !== undefined && !object(prior)) throw new Error("Claude's workspace configuration is invalid. No trust was changed.");
        merged[key] = { ...(prior as JsonObject | undefined), hasTrustDialogAccepted: true };
      }
      config.projects = merged;
      const temporary = `${file}.sideband-${randomUUID()}.tmp`;
      try {
        const output = await open(temporary, "wx", 0o600);
        try { await output.writeFile(JSON.stringify(config, null, 2) + "\n"); await output.sync(); } finally { await output.close(); }
        if (await contents(file) !== before) continue;
        checkLock();
        await rename(temporary, file);
        await delay(100);
        checkLock();
        const current = parse(await contents(file));
        const saved = current.projects;
        if (object(saved) && roots.every(key => object(saved[key]) && saved[key].hasTrustDialogAccepted === true)) return { root: workspace };
      } finally { await unlink(temporary).catch(error => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }); }
    }
    throw new Error("Claude kept changing its configuration. Close Claude briefly and retry recording trust.");
  } finally { await release().catch(() => {}); }
}
