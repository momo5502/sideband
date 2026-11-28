import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline/promises";
import lockfile from "proper-lockfile";
import { RoomProfiles } from "./room-profiles.js";
import { privateJson, runUpdateCommand } from "./update-runtime.js";
import { detectInstallHarnesses, installHarnessPlugin, type InstallHarness } from "./plugin-install.js";
import type { ConnectionProfile } from "./room-protocol.js";
import { processStamp } from "./persistence.js";
import { RoomClient } from "./room-client.js";

export async function openBrowser(url: string): Promise<void> {
  // No shell interpolation: the URL can contain a one-time login capability.
  const [command, args] = process.platform === "win32"
    ? ["rundll32.exe", ["url.dll,FileProtocolHandler", url]]
    : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command!, args as string[], { windowsHide: true, stdio: "ignore" });
    child.once("error", reject); child.once("spawn", () => { child.unref(); resolve(); });
  });
}

/** Holds the local instance lock across setup, serving and shutdown. No credentials in its record. */
export class LocalRun {
  private readonly controller = new AbortController();
  private constructor(readonly directory: string, private readonly release: () => Promise<void>, private readonly started?: string) {}
  static async claim(directory: string, noBrowser: boolean): Promise<LocalRun | undefined> {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const file = join(directory, "local-run.json");
    let release: () => Promise<void>;
    const options = { realpath: false, stale: 300000, update: 10000,
      onCompromised: () => { console.error("The local instance lock was lost; stopping Sideband."); process.emit("SIGTERM"); } };
    try { release = await lockfile.lock(file, options); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ELOCKED") throw error;
      let record: any; try { record = JSON.parse(await readFile(file, "utf8")); } catch { /* Starting. */ }
      let alive = true;
      if (Number.isInteger(record?.pid) && record.pid > 0) {
        try { process.kill(record.pid, 0); } catch (error) { alive = !["ESRCH", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? ""); }
        if (alive && record.started) { const current = await processStamp(record.pid); if (current && current !== record.started) alive = false; }
      }
      if (!alive) {
        console.log("The previous local process exited; recovering its instance lock...");
        // proper-lockfile performs the mtime/replacement checks and atomic mkdir. Do not
        // unlink a lock by PID alone: another invocation may be recovering concurrently.
        release = await lockfile.lock(file, { ...options, stale: 10000, update: 5000, retries: { retries: 30, minTimeout: 500, maxTimeout: 500 } });
      } else {
        const url = typeof record?.url === "string" && /^http:\/\/127\.0\.0\.1:\d+\/chat$/.test(record.url) ? record.url : undefined;
        console.log(`Sideband is already running${Number.isInteger(record?.pid) ? ` (PID ${record.pid})` : ""}.${url ? `\nBrowser: ${url}` : " It is still starting; check its terminal."}`);
        if (url && !noBrowser) {
          let target = url;
          if (typeof record?.profile === "string") {
            let client: RoomClient | undefined;
            try {
              const profile = await new RoomProfiles(directory).load(record.profile);
              client = new RoomClient(profile, undefined, { proxyEnv: { NO_PROXY: "*" } });
              await client.connect(); const result = await client.request<{ url: string }>("local_browser_login");
              if (result.url.startsWith(`${url}#local-login=`)) target = result.url;
            } catch { console.error("Could not sign in automatically. Your existing browser login can still be used."); }
            finally { await client?.close(); }
          }
          await openBrowser(target).catch(() => console.error("Could not open the browser. Open the printed URL."));
        }
        return;
      }
    }
    try { const started = await processStamp(process.pid); await privateJson(file, { pid: process.pid, started }); return new LocalRun(directory, release, started); }
    catch (error) { await release(); throw error; }
  }
  async ready(url: string, profile: string): Promise<void> { await privateJson(join(this.directory, "local-run.json"), { pid: process.pid, started: this.started, url, profile }); }
  async close(): Promise<void> { this.controller.abort(); await this.release().catch(() => {}); }
  async profile(profile: ConnectionProfile): Promise<string> {
    const profiles = new RoomProfiles(this.directory), names = await profiles.names(), previousDefault = await profiles.defaultName();
    let name: string | undefined;
    // Reuse only this server's existing profile; never overwrite another server's saved login.
    for (const candidate of names) {
      const saved = await profiles.load(candidate);
      if (saved.password === profile.password) { name = candidate; break; }
    }
    if (!name) { name = "local"; for (let i = 2; names.includes(name); i++) name = `local-${i}`; }
    await profiles.save(name, profile);
    await profiles.setDefault(previousDefault ?? name);
    if (previousDefault && previousDefault !== name) console.log(`Saved local profile '${name}'; your default '${previousDefault}' is unchanged. Use --profile ${name} to select this server.`);
    return name;
  }
  async offerPlugins(options: { interactive?: boolean; detect?: typeof detectInstallHarnesses; install?: typeof installHarnessPlugin; choose?: (question: string) => Promise<string> } = {}): Promise<void> {
    const file = join(this.directory, "local-setup.json");
    try { if (JSON.parse(await readFile(file, "utf8")).complete === true) return; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("Could not read local setup state."); }
    if (!(options.interactive ?? (process.stdin.isTTY && process.stdout.isTTY))) { console.log("To install harness plugins later, run sideband install in a terminal."); return; }
    console.log("First run: checking installed harnesses...");
    const run: typeof runUpdateCommand = (command, args, settings) => runUpdateCommand(command, args, { ...settings, signal: this.controller.signal });
    const available = (await (options.detect ?? detectInstallHarnesses)(run)).filter(item => item.version);
    this.controller.signal.throwIfAborted();
    if (!available.length) { console.log("No supported harnesses found. Install one, then run sideband install. Restart Sideband to detect it."); await privateJson(file, { complete: true }); return; }
    console.log(available.map((item, i) => `  [ ] ${i + 1}. ${item.harness}: ${item.version}`).join("\n"));
    const reader = options.choose ? undefined : createInterface({ input: process.stdin, output: process.stdout }); let selected: InstallHarness[];
    try {
      const question = "Install Sideband plugins: numbers separated by commas, all, or Enter to skip: ";
      const answer = (await (options.choose ? options.choose(question) : reader!.question(question, { signal: this.controller.signal }))).trim();
      const indexes = [...new Set(answer.split(/[\s,]+/).filter(Boolean))];
      if (answer.toLowerCase() === "all") selected = available.map(item => item.harness);
      else {
        if (indexes.some(value => !/^[1-9][0-9]*$/.test(value) || !available[Number(value) - 1])) throw new Error("Choose only numbers shown in the harness list. Setup will be offered again next time.");
        selected = indexes.map(value => available[Number(value) - 1]!.harness);
      }
    } finally { reader?.close(); }
    let failed = false;
    for (const harness of selected) { this.controller.signal.throwIfAborted(); console.log(`${harness}: installing Sideband...`); const result = await (options.install ?? installHarnessPlugin)(harness, run); this.controller.signal.throwIfAborted(); console.log(`${harness}: ${result.message}`); failed ||= result.state === "failed"; }
    if (!failed) await privateJson(file, { complete: true });
    else console.log("Some plugins could not be installed. Setup will be offered again next time; you can also use sideband install.");
  }
}
