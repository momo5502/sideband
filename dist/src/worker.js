import { STARTUP_TIMEOUT_MS, REQUEST_TIMEOUT_MS } from "./timeouts.js";
import { createHash } from "node:crypto";
import { hostname, homedir, platform } from "node:os";
import { resolve, join } from "node:path";
import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { AgentStore } from "./persistence.js";
import { runUpdateCommand } from "./update-runtime.js";
import { RoomClient } from "./room-client.js";
import { launchSpec } from "./orchestration-protocol.js";
import { stateDirectory } from "./room-profiles.js";
import { RoomError } from "./room-protocol.js";
import { terminalLauncher } from "./terminal-launch.js";
import { trustClaudeWorkspaces } from "./claude-trust.js";
export class Worker {
    options;
    client;
    machine;
    root;
    launches = new Map();
    store;
    recovering = new Map();
    inventory;
    inventoryTimer;
    closing = false;
    inventoryErrors = new Set();
    constructor(options) {
        this.options = options;
        this.root = resolve(options.root ?? join(stateDirectory, "workspaces"));
        // Machines belong to a server's in-memory registry; changing that server's address must not change the machine.
        const digest = createHash("sha256").update(JSON.stringify([hostname(), homedir(), this.root])).digest("hex").slice(0, 32);
        const id = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}-${digest.slice(16, 20)}-${digest.slice(20)}`;
        this.machine = { id, name: options.name ?? hostname(), platform: platform(), harnesses: ["omp"], online: true };
        if (options.updater) {
            this.machine.build = options.updater.build;
            this.machine.updater = true;
            this.machine.update = options.updater.state;
        }
        this.client = new RoomClient(options.profile, undefined, { keepAlive: true, retryInitial: true, onConnection: options.onConnection, onError: options.onError });
        this.client.onConnected(async () => {
            let machine = this.machine;
            try {
                await this.client.request("control.worker", { machine });
            }
            catch (original) {
                let error = original;
                if (error instanceof RoomError && /Invalid harness list/.test(error.message)) {
                    machine = { ...this.machine, harnesses: this.machine.harnesses.filter(name => name === "omp") };
                    try {
                        await this.client.request("control.worker", { machine });
                        options.onError?.(new Error("This server needs an update to launch Codex and Claude. Worker update metadata remains available."));
                        return;
                    }
                    catch (fallback) {
                        error = fallback;
                    }
                }
                if (!(error instanceof RoomError) || error.code !== "INVALID_ARGUMENT" || !this.machine.terminal)
                    throw error;
                const { build: _build, updater: _updater, update: _update, ...terminalKnown } = machine;
                try {
                    if (!options.updater)
                        throw error;
                    await this.client.request("control.worker", { machine: terminalKnown });
                }
                catch (fallback) {
                    if (!(fallback instanceof RoomError) || fallback.code !== "INVALID_ARGUMENT")
                        throw fallback;
                    const { terminal: _terminal, ...legacy } = terminalKnown;
                    await this.client.request("control.worker", { machine: legacy });
                }
                options.onError?.(new Error("Server does not support all worker features yet. Update the server to enable terminal launch and automatic updates."));
            }
            await this.syncInventory();
        });
        this.client.onEvent((event, command) => { if (event === "control.command")
            void this.command(command); });
        options.updater?.onChange(() => {
            this.machine.update = options.updater.state;
            if (this.client.state === "on")
                void this.client.request("control.worker_update", { update: this.machine.update }).catch(() => { });
        });
    }
    async start() {
        this.store = await AgentStore.open(this.root, this.options.profile);
        this.machine.id = await this.store.registry.change(() => {
            const stored = this.store.registry.get("meta", "machine-id");
            if (stored)
                return stored;
            this.store.registry.put("meta", "machine-id", this.machine.id);
            return this.machine.id;
        });
        const detected = await Promise.all(["omp", "codex", "claude"].map(async (name) => {
            const executable = this.options[name] ?? { command: name === "omp" ? process.env.OMP_BINARY ?? "omp" : name === "codex" ? process.env.CODEX_BIN ?? "codex" : process.env.CLAUDE_BINARY ?? "claude" };
            try {
                await runUpdateCommand(executable.command, [...(executable.args ?? []), "--version"], { timeout: REQUEST_TIMEOUT_MS, killTree: false });
                return name;
            }
            catch {
                return undefined;
            }
        }));
        this.machine.harnesses = detected.filter(name => name !== undefined);
        this.machine.terminal = terminalLauncher()?.kind ?? "none";
        await this.client.connect();
        this.inventoryTimer = setInterval(() => { if (this.client.state === "on")
            void this.syncInventory().catch(error => this.options.onError?.(error)); }, 10000);
        this.inventoryTimer.unref();
    }
    async savedAgent(record) {
        if (!/^[a-f0-9-]{36}$/.test(record.agent.id))
            throw new Error("Invalid saved agent ID.");
        const workspace = join(this.root, record.agent.id, record.agent.repository ? "repo" : "workspace");
        const present = await stat(workspace).then(info => info.isDirectory(), () => false);
        const live = await this.store.live(record.agent.id);
        return { ...record.agent, machineId: this.machine.id, machineName: this.machine.name, online: false, persistent: true, archived: record.desired === "archived",
            state: !present && record.workspaceReady ? "failed" : record.desired !== "running" || !live ? "stopped" : record.agent.state,
            canResume: record.workspaceReady && present,
            ...(!present && record.workspaceReady ? { error: "The saved workspace is missing from this machine. Its record was preserved." } : {}) };
    }
    syncInventory() {
        if (this.closing || !this.store)
            return Promise.resolve();
        if (this.inventory)
            return this.inventory;
        this.inventory = (async () => {
            const records = this.store.all();
            for (let offset = 0; offset < Math.max(records.length, 1); offset += 30) {
                const checked = await Promise.allSettled(records.slice(offset, offset + 30).map(record => this.savedAgent(record)));
                const agents = checked.flatMap(result => { if (result.status === "fulfilled")
                    return [result.value]; this.options.onError?.(new Error(`A saved agent could not be loaded: ${result.reason instanceof Error ? result.reason.message : "Invalid record."}`)); return []; });
                let response;
                try {
                    response = await this.client.request("control.inventory", { agents });
                }
                catch (error) {
                    if (error instanceof Error && /Unknown orchestration operation/.test(error.message))
                        return; // Server is still updating.
                    throw error;
                }
                for (const error of response.errors ?? [])
                    if (!this.inventoryErrors.has(error.id)) {
                        this.inventoryErrors.add(error.id);
                        this.options.onError?.(new Error(`Saved agent ${error.id}: ${error.message}`));
                    }
                for (const id of response.archived)
                    if (this.store.get(id))
                        await this.store.desired(id, "archived");
            }
        })().finally(() => { this.inventory = undefined; });
        return this.inventory;
    }
    resume(id) {
        const existing = this.recovering.get(id);
        if (existing)
            return existing;
        const operation = (async () => {
            let record = this.store.get(id);
            if (!record)
                throw new Error("No saved session exists for this agent on this machine.");
            const agent = await this.savedAgent(record);
            if (!agent.canResume)
                throw new Error(agent.error ?? "This agent has no completed workspace to resume.");
            if (record.desired === "archived") {
                const deadline = Date.now() + STARTUP_TIMEOUT_MS;
                while (await this.store.live(id) && Date.now() < deadline)
                    await new Promise(resolve => setTimeout(resolve, 250));
                record = this.store.get(id);
            }
            if (await this.store.live(id))
                throw new Error("This agent's controller is still alive. Wait for it to reconnect before resuming.");
            const spec = Object.fromEntries(["name", "harness", "repository", "ref", "model", "effort", "room", "terminal"].flatMap(key => {
                const value = record.agent[key];
                return value === undefined ? [] : [[key, value]];
            }));
            await this.store.desired(id, "running");
            try {
                return await this.spawnRunner({ profile: this.options.profile, id, machineId: this.machine.id, machineName: this.machine.name, root: this.root, spec, recover: true,
                    omp: this.options.omp ?? { command: process.env.OMP_BINARY ?? "omp" }, codex: this.options.codex ?? { command: process.env.CODEX_BIN ?? "codex" }, claude: this.options.claude ?? { command: process.env.CLAUDE_BINARY ?? "claude" }, entry: this.options.entry });
            }
            catch (error) {
                await this.store.desired(id, record.desired);
                throw error;
            }
        })().finally(() => { this.recovering.delete(id); });
        this.recovering.set(id, operation);
        return operation;
    }
    async command(command) {
        try {
            if (["resume", "archive", "stop"].includes(command.method)) {
                const id = command.params.id;
                if (typeof id !== "string" || !/^[a-f0-9-]{36}$/.test(id) || Object.keys(command.params).length !== 1)
                    throw new Error("Invalid saved agent ID.");
                const result = command.method === "resume" ? await this.resume(id) : await this.store.desired(id, command.method === "archive" ? "archived" : "stopped").then(() => ({ accepted: true }));
                await this.syncInventory();
                await this.client.request("control.reply", { id: command.id, result });
                return;
            }
            if (command.method === "claude-trust") {
                if (Object.keys(command.params).length || !this.machine.harnesses.includes("claude"))
                    throw new Error("Claude is not available on this worker.");
                const result = await trustClaudeWorkspaces(this.root);
                await this.client.request("control.reply", { id: command.id, result });
                return;
            }
            if (command.method === "update") {
                if (!this.options.updater || typeof command.params.target !== "string" || Object.keys(command.params).length !== 1)
                    throw new Error("This worker cannot perform automatic updates.");
                this.options.updater.start(command.params.target);
                await this.client.request("control.reply", { id: command.id, result: { accepted: true, attempt: this.options.updater.state.attempt } });
                return;
            }
            if (command.method !== "launch")
                throw new Error("Unknown worker operation.");
            const id = command.params.id;
            if (typeof id !== "string" || !/^[a-f0-9-]{36}$/.test(id))
                throw new Error("Invalid agent ID.");
            const spec = launchSpec(command.params.spec);
            let launched = this.launches.get(id);
            if (!launched) {
                const config = { profile: this.options.profile, id, machineId: this.machine.id, machineName: this.machine.name, root: this.root, spec,
                    omp: this.options.omp ?? { command: process.env.OMP_BINARY ?? "omp" }, codex: this.options.codex ?? { command: process.env.CODEX_BIN ?? "codex" }, claude: this.options.claude ?? { command: process.env.CLAUDE_BINARY ?? "claude" }, entry: this.options.entry };
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
            const timer = setTimeout(() => { child.kill(); reject(new Error("Runner registration timed out. Check the server connection.")); }, STARTUP_TIMEOUT_MS);
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
    async close() { this.closing = true; if (this.inventoryTimer)
        clearInterval(this.inventoryTimer); this.options.updater?.close(); await this.client.close(); await this.inventory?.catch(() => { }); await Promise.allSettled([...this.recovering.values()]); await this.store?.close(); }
}
//# sourceMappingURL=worker.js.map