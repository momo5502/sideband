import { createHash } from "node:crypto";
import { hostname, homedir, platform } from "node:os";
import { resolve, join } from "node:path";
import { spawn } from "node:child_process";
import crossSpawn from "cross-spawn";
import { RoomClient, type ConnectionChange } from "./room-client.js";
import { launchSpec, type ControlCommand, type Machine } from "./orchestration-protocol.js";
import { stateDirectory } from "./room-profiles.js";
import { RoomError, type ConnectionProfile } from "./room-protocol.js";
import type { RunnerConfig } from "./agent-runner.js";
import type { Executable } from "./managed-omp.js";
import { terminalLauncher } from "./terminal-launch.js";
import type { RuntimeUpdater } from "./updater.js";

export type WorkerOptions = { profile: ConnectionProfile; entry: string; name?: string; root?: string; omp?: Executable; codex?: Executable; claude?: Executable;
  onConnection?: (change: ConnectionChange) => void; onError?: (error: Error) => void; updater?: RuntimeUpdater };
export class Worker {
  readonly client: RoomClient;
  readonly machine: Machine;
  private readonly root: string;
  private launches = new Map<string, Promise<object>>();
  constructor(private readonly options: WorkerOptions) {
    this.root = resolve(options.root ?? join(stateDirectory, "workspaces"));
    // Machines belong to a server's in-memory registry; changing that server's address must not change the machine.
    const digest = createHash("sha256").update(JSON.stringify([hostname(), homedir(), this.root])).digest("hex").slice(0, 32);
    const id = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}-${digest.slice(16, 20)}-${digest.slice(20)}`;
    this.machine = { id, name: options.name ?? hostname(), platform: platform(), harnesses: ["omp"], online: true };
    if (options.updater) { this.machine.build = options.updater.build; this.machine.updater = true; this.machine.update = options.updater.state; }
    this.client = new RoomClient(options.profile, undefined, { keepAlive: true, retryInitial: true, onConnection: options.onConnection, onError: options.onError });
    this.client.onConnected(async () => {
      let machine = this.machine;
      try { await this.client.request("control.worker", { machine }); }
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
    });
    this.client.onEvent((event, command: ControlCommand) => { if (event === "control.command") void this.command(command); });
    options.updater?.onChange(() => {
      this.machine.update = options.updater!.state;
      if (this.client.state === "on") void this.client.request("control.worker_update", { update: this.machine.update }).catch(() => {});
    });
  }
  async start(): Promise<void> {
    this.machine.harnesses = [];
    for (const name of ["omp", "codex", "claude"] as const) {
      const executable = this.options[name] ?? { command: name === "omp" ? process.env.OMP_BINARY ?? "omp" : name === "codex" ? process.env.CODEX_BIN ?? "codex" : process.env.CLAUDE_BINARY ?? "claude" };
      const probe = crossSpawn.sync(executable.command, [...(executable.args ?? []), "--version"], { encoding: "utf8", windowsHide: true, timeout: 5000 });
      if (probe.status === 0) this.machine.harnesses.push(name);
    }
    this.machine.terminal = terminalLauncher()?.kind ?? "none";
    await this.client.connect();
  }
  private async command(command: ControlCommand): Promise<void> {
    try {
      if (command.method === "update") {
        if (!this.options.updater || typeof command.params.target !== "string" || Object.keys(command.params).length !== 1) throw new Error("This worker cannot perform automatic updates.");
        this.options.updater.start(command.params.target);
        await this.client.request("control.reply", { id: command.id, result: { accepted: true, attempt: this.options.updater.state.attempt } }); return;
      }
      if (command.method !== "launch") throw new Error("Unknown worker operation.");
      const id = command.params.id;
      if (typeof id !== "string" || !/^[a-f0-9-]{36}$/.test(id)) throw new Error("Invalid agent ID.");
      const spec = launchSpec(command.params.spec);
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
      const timer = setTimeout(() => { child.kill(); reject(new Error("Runner registration timed out. Check the server connection.")); }, 15_000);
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
  async close(): Promise<void> { this.options.updater?.close(); await this.client.close(); }
}
