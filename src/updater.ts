import { randomUUID } from "node:crypto";
import { open, readFile, stat, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { activeRuntime, buildInfo, installRuntime, latestBuild, privateJson, runtimeDirectory, runUpdateCommand, type RunUpdateCommand } from "./update-runtime.js";
import { updateHarnessPlugins } from "./plugin-updates.js";
import { parseUpdate, validCommit, type BuildInfo, type LocalUpdate } from "./update-types.js";

export class RuntimeUpdater {
  readonly build: BuildInfo;
  state: LocalUpdate = { phase: "idle", message: "Ready", plugins: [], at: Date.now() };
  private busy = false;
  private task?: Promise<void>;
  private listeners = new Set<() => void>();
  private readonly abort = new AbortController();
  constructor(readonly role: "server" | "worker", readonly entry: string, readonly directory: string, private readonly restart: () => Promise<void>,
    private readonly run: RunUpdateCommand = runUpdateCommand, private readonly install = installRuntime, private readonly plugins = updateHarnessPlugins) {
    this.directory = resolve(directory); this.build = buildInfo(entry);
    const command = this.run; this.run = (name, args, options) => command(name, args, { ...options, signal: this.abort.signal });
  }
  latest() { return latestBuild(this.run); }
  close(): void { this.abort.abort(); }
  /** Wait for the current update's writes, lock release and restart callback to settle. */
  idle(): Promise<void> { return this.task ?? Promise.resolve(); }
  onChange(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  async restore(): Promise<void> {
    try {
      const previous = parseUpdate(JSON.parse(await readFile(join(runtimeDirectory(this.directory), `${this.role}-update.json`), "utf8")));
      if (validCommit(previous.target) && previous.target === this.build.commit && previous.phase === "restarting") {
        this.state = { ...previous, phase: "done", message: previous.plugins.some(plugin => plugin.state === "failed") ? "Runtime updated; some plugins need attention." : "Updated successfully.", at: Date.now() };
        await this.save();
      } else if (previous.phase === "failed" || previous.target === this.build.commit && previous.phase === "done") this.state = previous;
      else if (["installing", "plugins", "restarting"].includes(previous.phase)) {
        this.state = { ...previous, phase: "failed", message: "The previous update was interrupted. Check for updates and retry.", at: Date.now() }; await this.save();
      }
    } catch { /* No prior update. */ }
  }
  private async save(): Promise<void> { await privateJson(join(runtimeDirectory(this.directory), `${this.role}-update.json`), this.state); for (const listener of this.listeners) listener(); }
  private async set(phase: LocalUpdate["phase"], message: string): Promise<void> { this.state = { ...this.state, phase, message, at: Date.now() }; await this.save(); }
  start(target: string): void {
    this.abort.signal.throwIfAborted();
    if (!validCommit(target)) throw new Error("Invalid update commit.");
    if (this.busy) throw new Error("An update is already running on this machine.");
    this.busy = true; this.state = { target, attempt: randomUUID(), phase: "installing", message: "Installing Sideband", plugins: [], at: Date.now() };
    this.task = this.perform(target).catch(async error => {
      try { await this.set("failed", error instanceof Error ? error.message.slice(0, 2048) : "Update failed."); }
      catch { for (const listener of this.listeners) listener(); }
    }).finally(() => { this.busy = false; });
  }
  private async perform(target: string): Promise<void> {
    await this.save(); const lockPath = join(runtimeDirectory(this.directory), "install.lock");
    let lock: Awaited<ReturnType<typeof open>> | undefined;
    const deadline = Date.now() + 10 * 60_000;
    while (!lock) {
      this.abort.signal.throwIfAborted();
      try { lock = await open(lockPath, "wx", 0o600); await lock.writeFile(String(process.pid)); }
      catch (error) {
        if (lock) { await lock.close(); await unlink(lockPath).catch(() => {}); throw error; }
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        let owner = 0; try { owner = Number(await readFile(lockPath, "utf8")); } catch { /* A racing writer. */ }
        if (!Number.isSafeInteger(owner) || owner <= 0) {
          const info = await stat(lockPath).catch(() => undefined);
          if (info && Date.now() - info.mtimeMs > 30000) { await unlink(lockPath).catch(() => {}); continue; }
        }
        if (owner > 0) try { process.kill(owner, 0); } catch (probe) { if ((probe as NodeJS.ErrnoException).code === "ESRCH") { await unlink(lockPath).catch(() => {}); continue; } }
        if (Date.now() > deadline) throw new Error("Another local Sideband update is still running."); await sleep(250, undefined, { signal: this.abort.signal });
      }
    }
    const original = await activeRuntime(this.directory, this.role); let activated = false;
    const rollback = async () => {
      if (activated && (await activeRuntime(this.directory, this.role))?.commit === target) await privateJson(join(runtimeDirectory(this.directory), `${this.role}-active.json`), original ?? {});
    };
    try {
      await this.install(target, this.directory, this.run);
      this.abort.signal.throwIfAborted();
      if (this.role === "worker") {
        await this.set("plugins", "Updating installed Sideband harness plugins");
        this.state.plugins = await this.plugins(this.run, results => { this.state = { ...this.state, plugins: results }; for (const listener of this.listeners) listener(); });
      }
      if (this.build.commit === target) {
        this.abort.signal.throwIfAborted();
        await this.set("done", this.state.plugins.some(plugin => plugin.state === "failed") ? "Runtime is current; some plugins need attention." : "Sideband and its installed plugins are current."); return;
      }
      const active = await activeRuntime(this.directory, this.role);
      this.abort.signal.throwIfAborted();
      if (active?.commit !== target) { await privateJson(join(runtimeDirectory(this.directory), `${this.role}-active.json`), { commit: target, previous: active?.commit ?? null }); activated = true; }
      await this.set("restarting", "Restarting into the new version");
    } catch (error) { await rollback(); throw error; }
    finally { await lock.close(); await unlink(lockPath).catch(() => {}); }
    try { await this.restart(); }
    catch (error) {
      await rollback();
      throw error;
    }
  }
}
