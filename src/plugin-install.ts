import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { readFile } from "node:fs/promises";
import { REQUEST_TIMEOUT_MS, INSTALL_TIMEOUT_MS } from "./timeouts.js";
import { runUpdateCommand, type RunUpdateCommand } from "./update-runtime.js";
import { officialSidebandSource, ompSource } from "./plugin-updates.js";

export const installHarnesses = ["codex", "claude", "omp", "pi"] as const;
export type InstallHarness = typeof installHarnesses[number];
export type HarnessInstall = { harness: InstallHarness; state: "installed" | "present" | "failed"; message: string };
export type DetectedHarness = { harness: InstallHarness; version?: string; error?: string };
const labels = { codex: "Codex", claude: "Claude Code", omp: "oh-my-pi", pi: "PI" };
export function selectedHarnesses(values: string[]): InstallHarness[] {
  const names = [...new Set(values.flatMap(value => value.split(",")).map(value => value.trim().toLowerCase()).filter(Boolean))];
  if (!names.length || names.some(name => !installHarnesses.includes(name as InstallHarness))) throw new Error("Choose harnesses from codex, claude, omp, pi.");
  return names as InstallHarness[];
}
function invoke(run: RunUpdateCommand): RunUpdateCommand {
  // These commands only manage user packages. Project-local extensions must not run.
  return (command, args, options) => run(command, command === "codex" ? ["--no-daemon", ...args] : args,
    { timeout: INSTALL_TIMEOUT_MS, ...options, cwd: homedir(), ...(command === "codex" ? { killTree: false } : {}) });
}
export async function detectInstallHarnesses(run: RunUpdateCommand = runUpdateCommand): Promise<DetectedHarness[]> {
  return Promise.all(installHarnesses.map(async harness => {
    try { const version = (await run(harness, ["--version"], { timeout: REQUEST_TIMEOUT_MS, killTree: false, cwd: homedir() })).trim().split(/[\r\n]/)[0]?.slice(0, 160); return { harness, version: version || labels[harness] }; }
    catch (error) { return { harness, error: (error as NodeJS.ErrnoException).code === "ENOENT" ? "CLI not found" : "CLI did not respond to --version" }; }
  }));
}
/** Installs only explicitly selected plugins; never installs harnesses, replaces sources, or changes credentials. */
export async function installHarnessPlugin(harness: InstallHarness, run: RunUpdateCommand = runUpdateCommand,
  piDirectory = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent")): Promise<HarnessInstall> {
  const command = invoke(run), present = (): HarnessInstall => ({ harness, state: "present", message: "Sideband is already installed." });
  try {
    if (harness === "pi") {
      if (process.env.PI_OFFLINE && !["0", "false"].includes(process.env.PI_OFFLINE.toLowerCase())) throw new Error("PI is offline. Disable PI_OFFLINE before installing.");
      let packages: unknown[] = [];
      try {
        const settings = JSON.parse(await readFile(join(resolve(piDirectory.replace(/^~(?=[/\\]|$)/, homedir())), "settings.json"), "utf8"));
        if (Array.isArray(settings.packages)) packages = settings.packages;
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("Could not read PI package settings. They were not changed."); }
      if (packages.some(entry => { const source = typeof entry === "string" ? entry : (entry as { source?: string })?.source; return typeof source === "string" && /^(?:git:)?(?:https:\/\/github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:|github\.com\/)momo5502\/sideband(?:\.git)?(?:@[^\s]+)?$/.test(source); })) return present();
      await command("pi", ["install", "git:github.com/momo5502/sideband", "--no-approve"]);
    } else if (harness === "omp") {
      const listed = JSON.parse(await command("omp", ["plugin", "list", "--json"], { timeout: REQUEST_TIMEOUT_MS }));
      const existing = listed.npm?.find((plugin: any) => plugin.name === "sideband");
      if (existing) { if (!await ompSource(existing.path)) throw new Error("Sideband is installed from another or local source. Keep that installation or remove it yourself first."); return present(); }
      await command("omp", ["plugin", "install", "github:momo5502/sideband#main"]);
    } else {
      const raw = JSON.parse(await command(harness, ["plugin", "marketplace", "list", "--json"], { timeout: REQUEST_TIMEOUT_MS }));
      const marketplace = (Array.isArray(raw) ? raw : raw.marketplaces ?? []).find((item: any) => item.name?.toLowerCase() === "sideband");
      if (marketplace) {
        const source = harness === "codex" ? marketplace.marketplaceSource?.sourceType === "git" && marketplace.marketplaceSource.source
          : marketplace.repo ?? marketplace.url ?? (typeof marketplace.source === "object" ? marketplace.source.repo ?? marketplace.source.url : marketplace.source);
        if (!officialSidebandSource(source)) throw new Error("The sideband marketplace uses another or local source. It was not replaced.");
      } else await command(harness, ["plugin", "marketplace", "add", "momo5502/sideband", ...(harness === "claude" ? ["--scope", "user"] : [])]);
      const listed = JSON.parse(await command(harness, ["plugin", "list", ...(harness === "codex" ? ["--marketplace", "sideband"] : []), "--json"], { timeout: REQUEST_TIMEOUT_MS }));
      const existing = (Array.isArray(listed) ? listed : listed.installed ?? []).find((item: any) => (item.id ?? item.pluginId)?.toLowerCase() === "sideband@sideband" && (harness !== "claude" || item.scope === "user"));
      if (existing) return present();
      if (marketplace) await command(harness, ["plugin", "marketplace", harness === "codex" ? "upgrade" : "update", "sideband"]);
      await command(harness, ["plugin", harness === "codex" ? "add" : "install", "sideband@sideband", ...(harness === "claude" ? ["--scope", "user", "--json", "-y"] : [])]);
    }
    return { harness, state: "installed", message: "Installed. Restart the harness to load Sideband." };
  } catch (error) { return { harness, state: "failed", message: error instanceof Error ? error.message.slice(0, 2048) : "Plugin installation failed." }; }
}
