import { STARTUP_TIMEOUT_MS, REQUEST_TIMEOUT_MS } from "./timeouts.js";
import { createHash } from "node:crypto";
import { hostname, homedir, platform } from "node:os";
import { resolve, join } from "node:path";
import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { AgentStore, type SavedAgent } from "./persistence.js";
import { runUpdateCommand } from "./update-runtime.js";
import { RoomClient, type ConnectionChange } from "./room-client.js";
import { launchSpec, type ControlCommand, type Machine, type ManagedAgent } from "./orchestration-protocol.js";
import { stateDirectory } from "./room-profiles.js";
import { RoomError, type ConnectionProfile } from "./room-protocol.js";
import type { RunnerConfig } from "./agent-runner.js";
import type { Executable } from "./managed-omp.js";
import { terminalLauncher } from "./terminal-launch.js";
import type { RuntimeUpdater } from "./updater.js";
import { trustClaudeWorkspaces } from "./claude-trust.js";
import { ModelDiscovery } from "./model-discovery.js";
import type { HarnessName } from "./orchestration-protocol.js";
import { browseFolders, existingFolder } from "./worker-folders.js";

export type WorkerOptions = { profile: ConnectionProfile; entry: string; name?: string; root?: string; omp?: Executable; codex?: Executable; claude?: Executable;
  onConnection?: (change: ConnectionChange) => void; onError?: (error: Error) => void; updater?: RuntimeUpdater };
export class Worker {
  private readonly models: ModelDiscovery;
  private modelSupport = false;
  private folderSupport = false;
  readonly client: RoomClient;
  readonly machine: Machine;
  private readonly root: string;
  private launches = new Map<string, Promise<object>>();
  private store?: AgentStore;
  private recovering = new Map<string, Promise<object>>();
  private inventory?: Promise<void>;
  private inventoryTimer?: NodeJS.Timeout;
  private closing = false;
  private inventoryErrors = new Set<string>();
  private inventoryFailure = "";
  private inventoryAgain = false;
  private inventoryVersion = 0;
  private savedActions = 0;
  constructor(private readonly options: WorkerOptions) {
    this.root = resolve(options.root ?? join(stateDirectory, "workspaces"));
    this.models = new ModelDiscovery(name => this.executable(name), this.root, options.entry);
    // Machines belong to a server's in-memory registry; changing that server's address must not change the machine.
    const digest = createHash("sha256").update(JSON.stringify([hostname(), homedir(), this.root])).digest("hex").slice(0, 32);
    const id = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}-${digest.slice(16, 20)}-${digest.slice(20)}`;
    this.machine = { id, name: options.name ?? hostname(), platform: platform(), harnesses: ["omp"], online: true };
    if (options.updater) { this.machine.build = options.updater.build; this.machine.updater = true; this.machine.update = options.updater.state; }
    this.client = new RoomClient(options.profile, undefined, { keepAlive: true, retryInitial: true, onConnection: options.onConnection, onError: options.onError });
    this.client.onConnected(async () => {
      let machine = this.machine;
      this.modelSupport = false;
      this.folderSupport = false;
      try { const response = await this.client.request<{ capabilities?: { models?: boolean; folders?: boolean } }>("control.worker", { machine }); this.modelSupport = response.capabilities?.models === true; this.folderSupport = response.capabilities?.folders === true; }
      catch (original) {
        let error = original;
        if (error instanceof RoomError && /Invalid harness list/.test(error.message)) {
          machine = { ...this.machine, harnesses: this.machine.harnesses.filter(name => name === "omp") };
          try { await this.client.request("control.worker", { machine }); options.onError?.(new Error("This server needs an update to launch Codex and Claude. Worker update metadata remains available.")); return; }
          catch (fallback) { error = fallback; }
        }
        if (!(error instanceof RoomError) || error.code !== "INVALID_ARGUMENT" || !this.machine.terminal) throw error;
        const { build: _build, updater: _updater, update: _update, ...terminalKnown } = machine;
        try { if (!options.updater) throw error; await this.client.request("control.worker", { machine: terminalKnown }); }
        catch (fallback) {
          if (!(fallback instanceof RoomError) || fallback.code !== "INVALID_ARGUMENT") throw fallback;
          const { terminal: _terminal, ...legacy } = terminalKnown; await this.client.request("control.worker", { machine: legacy });
        }
        options.onError?.(new Error("Server does not support all worker features yet. Update the server to enable terminal launch and automatic updates."));
      }
      // Inventory is optional recovery metadata, never part of transport readiness.
      this.scheduleInventory(true);
      // Optional capabilities are never sent to an older server or awaited by registration.
      if (this.modelSupport) for (const harness of this.machine.harnesses as HarnessName[]) void this.refreshModels(harness).catch(() => {});
      if (this.folderSupport) void this.client.request("control.features", { folders: true }).catch(() => {});
    });
    this.client.onEvent((event, command: ControlCommand) => { if (event === "control.command") void this.command(command); });
    options.updater?.onChange(() => {
      this.machine.update = options.updater!.state;
      if (this.client.state === "on") void this.client.request("control.worker_update", { update: this.machine.update }).catch(() => {});
    });
  }
  private executable(name: HarnessName): Executable { return this.options[name] ?? { command: name === "omp" ? process.env.OMP_BINARY ?? "omp" : name === "codex" ? process.env.CODEX_BIN ?? "codex" : process.env.CLAUDE_BINARY ?? "claude" }; }
  private async refreshModels(harness: HarnessName, fresh = false): Promise<void> {
    const catalog = !fresh && this.models.catalogs[harness] || await this.models.refresh(harness);
    if (!this.closing && this.modelSupport) await this.client.request("control.models", { harness, catalog });
  }
  async start(): Promise<void> {
    this.store = await AgentStore.open(this.root, this.options.profile);
    this.machine.id = await this.store.registry.change(() => {
      const stored = this.store!.registry.get<string>("meta", "machine-id");
      if (stored) return stored;
      this.store!.registry.put("meta", "machine-id", this.machine.id); return this.machine.id;
    });
    const detected = await Promise.all((["omp", "codex", "claude"] as const).map(async name => {
      const executable = this.options[name] ?? { command: name === "omp" ? process.env.OMP_BINARY ?? "omp" : name === "codex" ? process.env.CODEX_BIN ?? "codex" : process.env.CLAUDE_BINARY ?? "claude" };
      try { await runUpdateCommand(executable.command, [...(executable.args ?? []), "--version"], { timeout: REQUEST_TIMEOUT_MS, killTree: false }); return name; }
      catch { return undefined; }
    }));
    this.machine.harnesses = detected.filter(name => name !== undefined);
    this.machine.terminal = terminalLauncher()?.kind ?? "none";
    await this.client.connect();
    this.inventoryTimer = setInterval(() => { if (this.client.state === "on") this.scheduleInventory(); }, 10000); this.inventoryTimer.unref();
  }
  private async savedAgent(record: SavedAgent): Promise<ManagedAgent> {
    if (!/^[a-f0-9-]{36}$/.test(record.agent.id)) throw new Error("Invalid saved agent ID.");
    const workspace = record.agent.folder ?? join(this.root, record.agent.id, record.agent.repository ? "repo" : "workspace");
    let folderError = "";
    const present = record.agent.folder ? await existingFolder(workspace, true).then(() => true, error => { folderError = error.message; return false; }) : await stat(workspace).then(info => info.isDirectory(), () => false);
    const live = await this.store!.live(record.agent.id);
    return { ...record.agent, machineId: this.machine.id, machineName: this.machine.name, online: false, persistent: true, archived: record.desired === "archived",
      state: !present && record.workspaceReady ? "failed" : record.desired !== "running" || !live ? "stopped" : record.agent.state,
      canResume: record.workspaceReady && present,
      ...(!present && record.workspaceReady ? { error: folderError || "The saved workspace is missing from this machine. Its record was preserved." } : {}) };
  }
  private reportInventoryFailure(error: unknown): void {
    if (this.closing) return;
    const message = error instanceof Error ? error.message : "Inventory synchronization failed.";
    if (message === this.inventoryFailure) return;
    this.inventoryFailure = message;
    this.options.onError?.(new Error(`Saved-agent inventory will retry without disconnecting the worker: ${message}`));
  }
  private scheduleInventory(fresh = false): void {
    if (fresh && this.inventory) this.inventoryAgain = true;
    void this.syncInventory().catch(error => this.reportInventoryFailure(error));
  }
  private syncInventory(): Promise<void> {
    if (this.closing || !this.store) return Promise.resolve();
    if (this.inventory) return this.inventory;
    this.inventory = (async () => {
      const version = this.inventoryVersion;
      const records = this.store!.all();
      for (let offset = 0; offset < Math.max(records.length, 1); offset += 30) {
        const checked = await Promise.allSettled(records.slice(offset, offset + 30).map(record => this.savedAgent(record)));
        const agents = checked.flatMap(result => { if (result.status === "fulfilled") return [result.value]; this.options.onError?.(new Error(`A saved agent could not be loaded: ${result.reason instanceof Error ? result.reason.message : "Invalid record."}`)); return []; });
        if (version !== this.inventoryVersion || this.savedActions) return;
        const response = await this.client.request<{ archived: string[]; errors: { id: string; message: string }[] }>("control.inventory", { agents });
        for (const error of response.errors ?? []) { const key = `${error.id}:${error.message}`; if (!this.inventoryErrors.has(key)) { this.inventoryErrors.add(key); this.options.onError?.(new Error(`Saved agent ${error.id}: ${error.message}`)); } }
        // A response captured before/during a local action must not undo that action.
        for (const id of response.archived) {
          if (version !== this.inventoryVersion || this.savedActions) break;
          if (this.store!.get(id)) await this.store!.desired(id, "archived");
        }
      }
      this.inventoryFailure = "";
    })().finally(() => {
      this.inventory = undefined;
      const again = this.inventoryAgain; this.inventoryAgain = false;
      if (again && !this.closing) this.scheduleInventory();
    });
    return this.inventory;
  }
  private resume(id: string): Promise<object> {
    const existing = this.recovering.get(id); if (existing) return existing;
    const operation = (async () => {
      let record = this.store!.get(id); if (!record) throw new Error("No saved session exists for this agent on this machine.");
      const agent = await this.savedAgent(record); if (!agent.canResume) throw new Error(agent.error ?? "This agent has no completed workspace to resume.");
      if (record.desired === "archived") {
        const deadline = Date.now() + STARTUP_TIMEOUT_MS;
        while (await this.store!.live(id) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 250));
        record = this.store!.get(id)!;
      }
      if (await this.store!.live(id)) throw new Error("This agent's controller is still alive. Wait for it to reconnect before resuming.");
      const spec = Object.fromEntries(["name", "harness", "repository", "folder", "ref", "model", "effort", "room", "terminal"].flatMap(key => {
        const value = (record.agent as unknown as Record<string, unknown>)[key]; return value === undefined ? [] : [[key, value]];
      }));
      await this.store!.desired(id, "running");
      try {
        return await this.spawnRunner({ profile: this.options.profile, id, machineId: this.machine.id, machineName: this.machine.name, root: this.root, spec, recover: true,
          omp: this.options.omp ?? { command: process.env.OMP_BINARY ?? "omp" }, codex: this.options.codex ?? { command: process.env.CODEX_BIN ?? "codex" }, claude: this.options.claude ?? { command: process.env.CLAUDE_BINARY ?? "claude" }, entry: this.options.entry });
      } catch (error) { await this.store!.desired(id, record.desired); throw error; }
    })().finally(() => { this.recovering.delete(id); });
    this.recovering.set(id, operation); return operation;
  }
  private async command(command: ControlCommand): Promise<void> {
    try {
      if (command.method === "folders") {
        if (!this.folderSupport || Object.keys(command.params).some(key => !["path", "cursor"].includes(key))) throw new Error("Folder browsing is unavailable on this worker.");
        const { path, cursor } = command.params;
        if (path !== undefined && (typeof path !== "string" || path.length > 4096) || cursor !== undefined && (typeof cursor !== "string" || cursor.length > 255)) throw new Error("Invalid folder browsing request.");
        const result = await browseFolders(path as string | undefined, cursor as string | undefined);
        await this.client.request("control.reply", { id: command.id, result }); return;
      }
      if (command.method === "models") {
        const harness = command.params.harness as HarnessName;
        if (Object.keys(command.params).length !== 1 || !this.machine.harnesses.includes(harness) || !this.modelSupport) throw new Error("Model discovery is unavailable for this harness.");
        await this.refreshModels(harness, true); await this.client.request("control.reply", { id: command.id, result: {} }); return;
      }
      if (["resume", "archive", "stop"].includes(command.method)) {
        const id = command.params.id;
        if (typeof id !== "string" || !/^[a-f0-9-]{36}$/.test(id) || Object.keys(command.params).length !== 1) throw new Error("Invalid saved agent ID.");
        this.savedActions++; this.inventoryVersion++;
        let result: object;
        try { result = command.method === "resume" ? await this.resume(id) : await this.store!.desired(id, command.method === "archive" ? "archived" : "stopped").then(() => ({ accepted: true })); }
        finally { this.savedActions--; this.inventoryVersion++; }
        await this.client.request("control.reply", { id: command.id, result }); this.scheduleInventory(true); return;
      }
      if (command.method === "claude-trust") {
        if (Object.keys(command.params).length || !this.machine.harnesses.includes("claude")) throw new Error("Claude is not available on this worker.");
        const result = await trustClaudeWorkspaces(this.root);
        await this.client.request("control.reply", { id: command.id, result }); return;
      }
      if (command.method === "update") {
        if (!this.options.updater || typeof command.params.target !== "string" || Object.keys(command.params).length !== 1) throw new Error("This worker cannot perform automatic updates.");
        this.options.updater.start(command.params.target);
        await this.client.request("control.reply", { id: command.id, result: { accepted: true, attempt: this.options.updater.state.attempt } }); return;
      }
      if (command.method !== "launch") throw new Error("Unknown worker operation.");
      const id = command.params.id;
      if (typeof id !== "string" || !/^[a-f0-9-]{36}$/.test(id)) throw new Error("Invalid agent ID.");
      const spec = launchSpec(command.params.spec);
      if (spec.folder) { if (!this.folderSupport) throw new Error("Update the server and worker to launch in an existing folder."); spec.folder = await existingFolder(spec.folder); }
      let launched = this.launches.get(id);
      if (!launched) {
        const config: RunnerConfig = { profile: this.options.profile, id, machineId: this.machine.id, machineName: this.machine.name, root: this.root, spec,
          omp: this.options.omp ?? { command: process.env.OMP_BINARY ?? "omp" }, codex: this.options.codex ?? { command: process.env.CODEX_BIN ?? "codex" }, claude: this.options.claude ?? { command: process.env.CLAUDE_BINARY ?? "claude" }, entry: this.options.entry };
        launched = this.spawnRunner(config); this.launches.set(id, launched);
        if (this.launches.size > 1000) this.launches.delete(this.launches.keys().next().value!);
      }
      await this.client.request("control.reply", { id: command.id, result: await launched });
    } catch (error) { await this.client.request("control.reply", { id: command.id, error: error instanceof Error ? error.message.slice(0, 2048) : "Launch failed." }).catch(() => {}); }
  }
  private async spawnRunner(config: RunnerConfig): Promise<object> {
    await new Promise<void>((resolvePromise, reject) => {
      // The runner has no stdout/stderr pipe to its parent, and owns the harness pipes itself.
      const child = spawn(process.execPath, [this.options.entry, "agent-runner"], { detached: true, windowsHide: true, stdio: ["pipe", "ignore", "ignore", "ipc"] });
      const timer = setTimeout(() => { child.kill(); reject(new Error("Runner registration timed out. Check the server connection.")); }, STARTUP_TIMEOUT_MS);
      const fail = (error: Error) => { clearTimeout(timer); if (child.connected) child.disconnect(); child.unref(); reject(error); };
      child.once("error", fail); child.stdin!.once("error", fail);
      child.once("exit", () => fail(new Error("Runner exited before registration.")));
      child.once("message", (message: any) => {
        clearTimeout(timer);
        if (child.connected) child.disconnect(); child.unref();
        message.type === "runner.ready" ? resolvePromise() : reject(new Error(message.error ?? "Runner registration failed."));
      });
      child.once("spawn", () => { child.stdin!.end(JSON.stringify(config)); });
    });
    return { id: config.id };
  }
  /** Closing/updating a worker deliberately leaves its independently connected runners alive. */
  async close(): Promise<void> { this.closing = true; if (this.inventoryTimer) clearInterval(this.inventoryTimer); this.options.updater?.close(); await Promise.all([this.client.close(), this.models.close()]); await this.inventory?.catch(() => {}); await Promise.allSettled([...this.recovering.values()]); await this.store?.close(); }
}
