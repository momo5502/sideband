import { STARTUP_TIMEOUT_MS, REQUEST_TIMEOUT_MS, SHUTDOWN_TIMEOUT_MS } from "./timeouts.js";
import { createServer, connect } from "node:net";
import { randomBytes, randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import spawn from "cross-spawn";
import { writeLocal, readLocal } from "./local-wire.js";
import { managedInstructions } from "./managed-omp.js";
import { launchTerminal, terminalLauncher, shellQuote } from "./terminal-launch.js";
import { terminateTree } from "./process-tree.js";
import { StringDecoder } from "node:string_decoder";
/** Owns only a private control channel. OMP and its terminal own all terminal I/O. */
export class ManagedTerminal {
    executable;
    cwd;
    sessions;
    host;
    entry;
    openTerminal;
    detectTerminal;
    settings;
    sessionFile;
    server = createServer(socket => this.accept(socket));
    sockets = new Set();
    ownerToken = randomBytes(32).toString("base64url");
    pluginToken = randomBytes(32).toString("base64url");
    reconnectToken;
    owner;
    plugin;
    ready;
    stopped = false;
    stopping;
    exited = false;
    lastSequence = 0;
    pluginInstance;
    headless;
    headlessExit;
    id = 0;
    bootstrapFile = "";
    scriptFile = "";
    runtime = {};
    pending = new Map();
    constructor(executable, cwd, sessions, host, entry, openTerminal = launchTerminal, detectTerminal = terminalLauncher, settings = {}) {
        this.executable = executable;
        this.cwd = cwd;
        this.sessions = sessions;
        this.host = host;
        this.entry = entry;
        this.openTerminal = openTerminal;
        this.detectTerminal = detectTerminal;
        this.settings = settings;
        // npm's Unix bin is a symlink; companion assets belong beside the actual CLI module.
        this.entry = realpathSync(entry);
    }
    async start(options) {
        const launcher = this.detectTerminal();
        if (!launcher && !this.settings.headless)
            throw new Error("No terminal launcher is available. Install tmux on a headless machine, or choose Background mode.");
        await new Promise((resolve, reject) => { this.server.once("error", reject); this.server.listen(0, "127.0.0.1", () => { this.server.off("error", reject); resolve(); }); });
        const port = this.server.address().port;
        const plugin = join(dirname(this.entry), ...(basename(this.entry) === "cli.js" ? [".."] : []), this.settings.harness === "pi" ? "sideband-pi.cjs" : "sideband-omp.cjs");
        this.runtime = { executable: this.executable.command, args: [...(this.executable.args ?? []), ...(this.settings.harness === "pi" ? [...(this.settings.headless ? ["--mode", "rpc"] : []), "--no-approve"] : ["--auto-approve", "--approval-mode", "yolo", "--no-title"]), "-e", plugin,
                "--session-dir", this.sessions, "--append-system-prompt", managedInstructions,
                ...(options.model ? ["--model", options.model] : []), ...(options.effort ? ["--thinking", options.effort] : []), ...(options.resume ? [this.settings.harness === "pi" ? "--session" : "--resume", options.resume] : [])],
            cwd: this.cwd, env: { ...process.env, SIDEBAND_MANAGED_BRIDGE: JSON.stringify({ port, token: this.pluginToken }) } };
        await mkdir(this.sessions, { recursive: true, mode: 0o700 });
        const unique = randomUUID();
        this.bootstrapFile = join(dirname(this.sessions), `terminal-${unique}.json`);
        this.scriptFile = join(dirname(this.sessions), `terminal-${unique}.${process.platform === "win32" ? "cmd" : process.platform === "darwin" ? "command" : "sh"}`);
        await writeFile(this.bootstrapFile, JSON.stringify({ port, token: this.ownerToken }), { flag: "wx", mode: 0o600 });
        const command = [process.execPath, this.entry, "terminal-agent", this.bootstrapFile];
        const script = process.platform === "win32" ? `@echo off\r\nsetlocal DisableDelayedExpansion\r\n${command.map(value => `"${value.replace(/%/g, "%%")}"`).join(" ")}\r\n` : `#!/bin/sh\nexec ${command.map(shellQuote).join(" ")}\n`;
        await writeFile(this.scriptFile, script, { flag: "wx", mode: 0o700 });
        const ready = new Promise((resolve, reject) => { this.ready = { resolve, reject }; });
        const timer = setTimeout(() => this.ready?.reject(new Error("OMP's terminal did not register within five minutes. Check the terminal window and the worker's desktop access, or choose Background mode.")), STARTUP_TIMEOUT_MS);
        try {
            if (this.stopped)
                throw new Error("OMP terminal was stopped.");
            if (this.settings.headless) {
                this.startHeadless();
                await ready;
                return;
            }
            const child = this.openTerminal(launcher, this.scriptFile, unique);
            child.on("error", error => this.ready?.reject(error));
            child.stderr?.setEncoding("utf8");
            child.stderr?.on("data", text => this.host.event("terminal", String(text)));
            child.on("exit", code => { if (code)
                this.ready?.reject(new Error(`Terminal launcher exited (${code}). Check desktop access or choose Background mode.`)); });
            child.unref();
            if (launcher.kind === "tmux")
                this.host.event("terminal", `Attach locally: tmux attach -t sb-${unique}`);
            else
                this.host.event("terminal", `Opening ${this.settings.harness === "pi" ? "PI" : "OMP"} in a terminal window on this machine.`);
            await ready;
        }
        catch (error) {
            await this.stop();
            for (const path of [this.bootstrapFile, this.scriptFile])
                if (path)
                    await unlink(path).catch(() => { });
            throw error;
        }
        finally {
            clearTimeout(timer);
            this.ready = undefined;
        }
    }
    startHeadless() {
        const runtime = this.runtime;
        const child = this.headless = spawn(runtime.executable, runtime.args, { cwd: runtime.cwd, env: runtime.env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true, detached: process.platform !== "win32" });
        this.headlessExit = new Promise(resolve => {
            let done = false;
            const finished = (error) => {
                if (done)
                    return;
                done = true;
                // A tool's surviving subprocess may hold inherited pipes. The harness
                // process exiting, not those pipes closing, determines its lifetime.
                child.stdin?.destroy();
                child.stdout?.destroy();
                child.stderr?.destroy();
                this.exit(error);
                resolve();
            };
            child.once("exit", code => finished(code === 0 ? undefined : new Error(`PI exited (${code ?? child.signalCode}).`)));
            child.once("error", finished);
        });
        child.on("error", error => this.ready?.reject(error));
        child.stdin.on("error", error => { if (!this.stopped)
            this.ready?.reject(error); });
        child.stderr.setEncoding("utf8");
        child.stderr.on("data", text => this.host.event("stderr", String(text)));
        let buffer = "", dropping = false;
        const decoder = new StringDecoder("utf8");
        child.stdout.on("data", (chunk) => {
            buffer += decoder.write(chunk);
            while (buffer.includes("\n")) {
                const end = buffer.indexOf("\n"), line = buffer.slice(0, end);
                buffer = buffer.slice(end + 1);
                if (dropping) {
                    dropping = false;
                    continue;
                }
                if (Buffer.byteLength(line) > 8 * 1024 * 1024)
                    continue;
                let packet;
                try {
                    packet = JSON.parse(line);
                }
                catch {
                    continue;
                }
                // PI's RPC UI cannot stop this unattended session waiting for a dialog.
                if (packet.type === "extension_ui_request" && ["select", "confirm", "input", "editor"].includes(packet.method))
                    child.stdin.write(JSON.stringify({ type: "extension_ui_response", id: packet.id, ...(packet.method === "confirm" ? { confirmed: false } : { cancelled: true }) }) + "\n");
            }
            // Full turn/message snapshots can be huge. The extension streams bounded
            // deltas separately; discarding these frames must never kill a healthy PI run.
            if (Buffer.byteLength(buffer) > 8 * 1024 * 1024) {
                buffer = "";
                dropping = true;
            }
        });
    }
    accept(socket) {
        if (this.stopped || this.sockets.size >= 8) {
            socket.destroy();
            return;
        }
        this.sockets.add(socket);
        let role = "";
        const timer = setTimeout(() => socket.destroy(), REQUEST_TIMEOUT_MS);
        timer.unref();
        readLocal(socket, packet => {
            if (!role) {
                if (packet.type !== "hello") {
                    socket.destroy();
                    return;
                }
                if (packet.role === "owner" && packet.token === this.ownerToken && !this.owner) {
                    role = "owner";
                    this.owner = socket;
                    clearTimeout(timer);
                    writeLocal(socket, { type: "start", ...this.runtime });
                    void unlink(this.bootstrapFile).catch(() => { });
                    return;
                }
                const authorized = this.reconnectToken ? packet.token === this.reconnectToken : packet.token === this.pluginToken;
                if (packet.role !== "plugin" || !authorized || this.plugin || typeof packet.sessionFile !== "string" || !packet.sessionFile || packet.sessionFile.length > 4096) {
                    socket.destroy();
                    return;
                }
                if (!packet.hasUI || packet.mode !== (this.settings.headless ? "rpc" : "tui")) {
                    this.ready?.reject(new Error("The harness did not start in the requested terminal/background mode."));
                    socket.destroy();
                    return;
                }
                role = "plugin";
                this.plugin = socket;
                clearTimeout(timer);
                if (typeof packet.instance === "string" && packet.instance !== this.pluginInstance) {
                    this.pluginInstance = packet.instance;
                    this.lastSequence = 0;
                }
                this.reconnectToken ??= randomBytes(32).toString("base64url");
                this.sessionFile = packet.sessionFile;
                this.host.state(packet.busy ? "busy" : "idle");
                writeLocal(socket, { type: "ready", token: this.reconnectToken });
                this.ready?.resolve();
                return;
            }
            if (role === "owner") {
                if (packet.type === "exit")
                    this.exit(packet.code === 0 ? undefined : new Error(`OMP terminal exited (${packet.code ?? "closed"}).`));
                return;
            }
            if (packet.type === "reply") {
                const pending = this.pending.get(packet.id);
                if (!pending)
                    return;
                clearTimeout(pending.timer);
                this.pending.delete(packet.id);
                packet.error ? pending.reject(new Error(String(packet.error).slice(0, 2048))) : pending.resolve(packet.result);
                return;
            }
            if (packet.type === "session" && typeof packet.sessionFile === "string" && packet.sessionFile.length <= 4096)
                this.sessionFile = packet.sessionFile;
            if (packet.type === "state" && ["busy", "idle"].includes(packet.state))
                this.host.state(packet.state);
            if (packet.type === "events" && Array.isArray(packet.events) && packet.events.length <= 32)
                for (const event of packet.events) {
                    if (Number.isSafeInteger(event.seq) && event.seq > this.lastSequence && typeof event.kind === "string" && typeof event.text === "string" && Buffer.byteLength(event.text) <= 4096) {
                        this.lastSequence = event.seq;
                        this.host.event(event.kind, event.text);
                    }
                }
            if (packet.type === "tool" && typeof packet.id === "string")
                void this.host.tool(packet.name, packet.args)
                    .then(result => writeLocal(socket, { type: "reply", id: packet.id, result }), error => writeLocal(socket, { type: "reply", id: packet.id, error: error instanceof Error ? error.message : "Room tool failed." }));
            if (packet.type === "exit")
                this.exit();
        });
        socket.on("close", () => {
            clearTimeout(timer);
            this.sockets.delete(socket);
            if (this.plugin === socket) {
                this.plugin = undefined;
                this.rejectPending("OMP terminal connection lost; request acceptance is unknown.");
            }
            if (this.owner === socket && !this.exited && !this.stopped)
                this.exit();
        });
    }
    exit(error) {
        if (this.exited)
            return;
        this.exited = true;
        this.rejectPending("OMP terminal closed; request acceptance is unknown.");
        this.ready?.reject(error ?? new Error("OMP's terminal closed during startup."));
        if (!this.stopped)
            this.host.exit(error);
        for (const path of [this.bootstrapFile, this.scriptFile])
            if (path)
                void unlink(path).catch(() => { });
    }
    rejectPending(message) { for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error(message));
    } this.pending.clear(); }
    request(method, params = {}, timeout = REQUEST_TIMEOUT_MS) {
        const id = `terminal-${++this.id}`;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`OMP ${method} timed out; acceptance is unknown.`)); }, timeout);
            this.pending.set(id, { resolve, reject, timer });
            if (!writeLocal(this.plugin, { type: "command", id, method, ...params })) {
                clearTimeout(timer);
                this.pending.delete(id);
                reject(new Error("OMP terminal is disconnected."));
            }
        });
    }
    async prompt(text) { await this.request("prompt", { text }); }
    async deliver(text) { await this.request("aside", { text }); }
    async interrupt() { await this.request("interrupt"); }
    stop() { return this.stopping ??= this.closeTerminal(); }
    async closeTerminal() {
        this.stopped = true;
        this.ready?.reject(new Error("OMP terminal was stopped."));
        if (this.plugin && !this.plugin.destroyed)
            await this.request("shutdown", {}, SHUTDOWN_TIMEOUT_MS).catch(() => { });
        if (this.headless && this.headless.exitCode === null && this.headless.signalCode === null) {
            const child = this.headless;
            const timer = setTimeout(() => terminateTree(child), SHUTDOWN_TIMEOUT_MS);
            child.stdin?.end();
            try {
                await this.headlessExit;
            }
            finally {
                clearTimeout(timer);
            }
        }
        if (!this.exited && this.owner) {
            await new Promise(resolve => {
                let cap;
                const timer = setTimeout(() => {
                    writeLocal(this.owner, { type: "kill" });
                    this.owner?.end();
                    cap = setTimeout(resolve, SHUTDOWN_TIMEOUT_MS);
                }, SHUTDOWN_TIMEOUT_MS);
                this.owner.once("close", () => { clearTimeout(timer); if (cap)
                    clearTimeout(cap); resolve(); });
            });
        }
        this.rejectPending("OMP terminal stopped.");
        for (const socket of this.sockets)
            socket.destroy();
        await new Promise(resolve => this.server.close(() => resolve()));
        for (const path of [this.bootstrapFile, this.scriptFile])
            if (path)
                await unlink(path).catch(() => { });
    }
}
/** Runs inside the visible terminal; only this process owns OMP's stdin/stdout. */
export async function runTerminalAgent(path) {
    const bootstrap = JSON.parse(await readFile(path, "utf8"));
    if (!Number.isInteger(bootstrap.port) || bootstrap.port < 1 || bootstrap.port > 65535 || !/^[A-Za-z0-9_-]{43}$/.test(bootstrap.token))
        throw new Error("Invalid terminal bootstrap.");
    const socket = connect({ port: bootstrap.port, host: "127.0.0.1", allowHalfOpen: true });
    // The foreground OMP process owns Ctrl+C. The terminal wrapper must not disappear
    // when the console delivers the same interrupt to both processes.
    const interrupt = () => { };
    process.on("SIGINT", interrupt);
    let child, killing = false, notified = false;
    const lost = () => { if (!killing && !notified && child?.exitCode === null) {
        notified = true;
        console.error("Sideband controller lost. This OMP session remains available locally; managed controls are disconnected.");
    } };
    await new Promise((resolve, reject) => {
        socket.once("error", reject);
        socket.once("connect", () => writeLocal(socket, { type: "hello", role: "owner", token: bootstrap.token, pid: process.pid }));
        readLocal(socket, packet => {
            if (packet.type === "start" && !child) {
                child = spawn(packet.executable, packet.args, { cwd: packet.cwd, env: packet.env, stdio: "inherit", windowsHide: false });
                child.once("spawn", () => writeLocal(socket, { type: "spawned" }));
                child.on("error", reject);
                child.on("exit", code => { writeLocal(socket, { type: "exit", code }); socket.end(); process.exitCode = code ?? 0; resolve(); });
            }
            if (packet.type === "kill" && child) {
                killing = true;
                terminateTree(child, false);
            }
        });
        socket.on("end", () => { if (!killing) {
            lost();
            socket.end();
        } });
        socket.on("close", () => { if (!child)
            reject(new Error("Terminal controller disconnected before OMP started."));
        else
            lost(); });
    }).finally(() => { socket.destroy(); process.off("SIGINT", interrupt); });
}
//# sourceMappingURL=managed-terminal.js.map