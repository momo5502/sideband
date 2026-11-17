import { createHash } from "node:crypto";
import { hostname, homedir, platform } from "node:os";
import { resolve, join } from "node:path";
import { spawn } from "node:child_process";
import crossSpawn from "cross-spawn";
import { RoomClient } from "./room-client.js";
import { launchSpec, type ControlCommand, type Machine } from "./orchestration-protocol.js";
import { stateDirectory } from "./room-profiles.js";
import type { ConnectionProfile } from "./room-protocol.js";
import type { RunnerConfig } from "./agent-runner.js";
import type { Executable } from "./managed-omp.js";

export type WorkerOptions = { profile: ConnectionProfile; entry: string; name?: string; root?: string; omp?: Executable };
export class Worker {
  readonly client: RoomClient;
  readonly machine: Machine;
  private readonly root: string;
  private launches = new Map<string, Promise<object>>();
  constructor(private readonly options: WorkerOptions) {
    this.root = resolve(options.root ?? join(stateDirectory, "workspaces"));
    const digest = createHash("sha256").update(JSON.stringify([hostname(), homedir(), this.root, options.profile.server])).digest("hex").slice(0, 32);
    const id = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}-${digest.slice(16, 20)}-${digest.slice(20)}`;
    this.machine = { id, name: options.name ?? hostname(), platform: platform(), harnesses: ["omp"], online: true };
    this.client = new RoomClient(options.profile, undefined, { keepAlive: true });
    this.client.onConnected(async () => { await this.client.request("control.worker", { machine: this.machine }); });
    this.client.onEvent((event, command: ControlCommand) => { if (event === "control.command") void this.command(command); });
  }
  async start(): Promise<void> {
    const executable = this.options.omp ?? { command: process.env.OMP_BINARY ?? "omp" };
    const probe = crossSpawn.sync(executable.command, [...(executable.args ?? []), "--version"], { encoding: "utf8", windowsHide: true, timeout: 5000 });
    this.machine.harnesses = probe.status === 0 ? ["omp"] : [];
    await this.client.connect();
  }
  private async command(command: ControlCommand): Promise<void> {
    try {
      if (command.method !== "launch") throw new Error("Unknown worker operation.");
      const id = command.params.id;
      if (typeof id !== "string" || !/^[a-f0-9-]{36}$/.test(id)) throw new Error("Invalid agent ID.");
      const spec = launchSpec(command.params.spec);
      let launched = this.launches.get(id);
      if (!launched) {
        const config: RunnerConfig = { profile: this.options.profile, id, machineId: this.machine.id, machineName: this.machine.name, root: this.root, spec,
          omp: this.options.omp ?? { command: process.env.OMP_BINARY ?? "omp" } };
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
  async close(): Promise<void> { await this.client.close(); }
}
