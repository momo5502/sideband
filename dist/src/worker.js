import { createHash } from "node:crypto";
import { hostname, homedir, platform } from "node:os";
import { resolve, join } from "node:path";
import { spawn } from "node:child_process";
import crossSpawn from "cross-spawn";
import { RoomClient } from "./room-client.js";
import { launchSpec } from "./orchestration-protocol.js";
import { stateDirectory } from "./room-profiles.js";
export class Worker {
    options;
    client;
    machine;
    root;
    launches = new Map();
    constructor(options) {
        this.options = options;
        this.root = resolve(options.root ?? join(stateDirectory, "workspaces"));
        const digest = createHash("sha256").update(JSON.stringify([hostname(), homedir(), this.root, options.profile.server])).digest("hex").slice(0, 32);
        const id = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}-${digest.slice(16, 20)}-${digest.slice(20)}`;
        this.machine = { id, name: options.name ?? hostname(), platform: platform(), harnesses: ["omp"], online: true };
        this.client = new RoomClient(options.profile, undefined, { keepAlive: true });
        this.client.onConnected(async () => { await this.client.request("control.worker", { machine: this.machine }); });
        this.client.onEvent((event, command) => { if (event === "control.command")
            void this.command(command); });
    }
    async start() {
        const executable = this.options.omp ?? { command: process.env.OMP_BINARY ?? "omp" };
        const probe = crossSpawn.sync(executable.command, [...(executable.args ?? []), "--version"], { encoding: "utf8", windowsHide: true, timeout: 5000 });
        this.machine.harnesses = probe.status === 0 ? ["omp"] : [];
        await this.client.connect();
    }
    async command(command) {
        try {
            if (command.method !== "launch")
                throw new Error("Unknown worker operation.");
            const id = command.params.id;
            if (typeof id !== "string" || !/^[a-f0-9-]{36}$/.test(id))
                throw new Error("Invalid agent ID.");
            const spec = launchSpec(command.params.spec);
            let launched = this.launches.get(id);
            if (!launched) {
                const config = { profile: this.options.profile, id, machineId: this.machine.id, machineName: this.machine.name, root: this.root, spec,
                    omp: this.options.omp ?? { command: process.env.OMP_BINARY ?? "omp" } };
                launched = this.spawnRunner(config);
                this.launches.set(id, launched);
                if (this.launches.size > 1000)
                    this.launches.delete(this.launches.keys().next().value);
            }
            await this.client.request("control.reply", { id: command.id, result: await launched });
        }
        catch (error) {
            await this.client.request("control.reply", { id: command.id, error: error instanceof Error ? error.message.slice(0, 2048) : "Launch failed." }).catch(() => { });
        }
    }
    async spawnRunner(config) {
        await new Promise((resolvePromise, reject) => {
            // The runner has no stdout/stderr pipe to its parent, and owns the harness pipes itself.
            const child = spawn(process.execPath, [this.options.entry, "agent-runner"], { detached: true, windowsHide: true, stdio: ["pipe", "ignore", "ignore", "ipc"] });
            const timer = setTimeout(() => { child.kill(); reject(new Error("Runner registration timed out. Check the server connection.")); }, 15_000);
            const fail = (error) => { clearTimeout(timer); if (child.connected)
                child.disconnect(); child.unref(); reject(error); };
            child.once("error", fail);
            child.stdin.once("error", fail);
            child.once("exit", () => fail(new Error("Runner exited before registration.")));
            child.once("message", (message) => {
                clearTimeout(timer);
                if (child.connected)
                    child.disconnect();
                child.unref();
                message.type === "runner.ready" ? resolvePromise() : reject(new Error(message.error ?? "Runner registration failed."));
            });
            child.once("spawn", () => { child.stdin.end(JSON.stringify(config)); });
        });
        return { id: config.id };
    }
    /** Closing/updating a worker deliberately leaves its independently connected runners alive. */
    async close() { await this.client.close(); }
}
//# sourceMappingURL=worker.js.map