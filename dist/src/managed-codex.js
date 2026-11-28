import { STARTUP_TIMEOUT_MS, REQUEST_TIMEOUT_MS } from "./timeouts.js";
import { mkdir, writeFile, unlink } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import WebSocket from "ws";
import { HarnessProcess } from "./harness-process.js";
import { ManagedRoomTools } from "./managed-room-tools.js";
import { managedInstructions } from "./managed-omp.js";
import { NativeView } from "./native-view.js";
export class ManagedCodex {
    executable;
    cwd;
    directory;
    host;
    entry;
    terminal;
    openView;
    sessionFile;
    process;
    tools;
    view;
    socket;
    stopping = false;
    exited = false;
    closing;
    listener;
    listenerText = "";
    activeTurn;
    effort;
    streamed = new Set();
    completed = new Set();
    roomInputs = new Set();
    tokenFile;
    constructor(executable, cwd, directory, host, entry, terminal = false, openView = exit => new NativeView(directory, entry, host, exit)) {
        this.executable = executable;
        this.cwd = cwd;
        this.directory = directory;
        this.host = host;
        this.entry = entry;
        this.terminal = terminal;
        this.openView = openView;
        this.process = new HarnessProcess({ ...host, exit: error => this.exit(error), event: (kind, text) => {
                if (this.listener) {
                    this.listenerText = (this.listenerText + text).slice(-4096);
                    const match = /listening on:\s+(ws:\/\/127\.0\.0\.1:\d+)/.exec(this.listenerText);
                    if (match)
                        this.listener.resolve(match[1]);
                }
                host.event(kind, text);
            } }, "codex", frame => this.frame(frame));
        this.tools = new ManagedRoomTools(host, join(directory, "room-tools.json"));
        this.tokenFile = join(directory, "codex-ws-token");
    }
    async start(options) {
        await mkdir(this.directory, { recursive: true, mode: 0o700 });
        await this.tools.start();
        this.effort = options.effort === "off" ? "none" : options.effort === "auto" ? undefined : options.effort;
        const config = { mcp_servers: { sideband_managed: { command: process.execPath, args: [this.entry, "managed-mcp", this.tools.path], required: true } }, plugins: { "sideband@sideband": { enabled: false } }, ...(this.effort ? { model_reasoning_effort: this.effort } : {}) };
        if (this.terminal) {
            const token = randomBytes(32).toString("base64url");
            await writeFile(this.tokenFile, token, { mode: 0o600 });
            const listening = new Promise((resolve, reject) => { this.listener = { resolve, reject }; });
            const timer = setTimeout(() => this.listener?.reject(new Error("Codex did not announce its private listener. Update Codex or choose Background mode.")), STARTUP_TIMEOUT_MS);
            this.process.start(this.executable, ["app-server", "--listen", "ws://127.0.0.1:0", "--ws-auth", "capability-token", "--ws-token-file", this.tokenFile], this.cwd);
            let url;
            try {
                url = await listening;
            }
            finally {
                clearTimeout(timer);
                this.listener = undefined;
            }
            const deadline = Date.now() + STARTUP_TIMEOUT_MS;
            while (!this.socket) {
                const socket = new WebSocket(url, { agent: false, maxPayload: 8 * 1024 * 1024, handshakeTimeout: REQUEST_TIMEOUT_MS, headers: { Authorization: `Bearer ${token}` } });
                try {
                    await new Promise((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
                    this.socket = socket;
                }
                catch {
                    socket.terminate();
                    if (Date.now() > deadline)
                        throw new Error("Codex's private app-server did not start. Update Codex or choose Background mode.");
                    await new Promise(resolve => setTimeout(resolve, 150));
                }
            }
            this.socket.on("message", data => { try {
                this.process.receive(JSON.parse(data.toString()));
            }
            catch { /* Ignore non-protocol frames. */ } });
            this.socket.on("error", error => this.host.event("error", error.message));
            this.socket.once("close", () => { if (!this.stopping) {
                this.exit(new Error("Codex's private app-server disconnected."));
            } });
            this.process.send = value => { if (this.socket?.readyState !== WebSocket.OPEN)
                throw new Error("Codex is disconnected."); if (this.socket.bufferedAmount > 2 * 1024 * 1024)
                throw new Error("Codex input backlog is full."); this.socket.send(JSON.stringify(value)); };
            await this.initialize(options, config);
            this.view = this.openView(error => { if (!this.stopping) {
                this.exit(error);
            } });
            // Remote resume inherits our thread's policy; CLI permission overrides are rejected.
            await this.view.start(this.executable, ["resume", this.sessionFile, "--remote", url, "--remote-auth-token-env", "SIDEBAND_CODEX_WS_TOKEN"], this.cwd, { ...process.env, SIDEBAND_CODEX_WS_TOKEN: token });
        }
        else {
            this.process.start(this.executable, ["app-server", "--listen", "stdio://"], this.cwd);
            await this.initialize(options, config);
        }
    }
    async handshake() {
        await this.process.request("initialize", { clientInfo: { name: "sideband-managed", title: "Sideband", version: "1.0.0" }, capabilities: { experimentalApi: true } });
        this.process.send({ method: "initialized" });
    }
    async initialize(options, config) {
        await this.handshake();
        await this.openThread(options, config);
        if (!options.resume) {
            // Codex creates rollouts lazily. Archive flushes a newly owned empty thread;
            // immediately restore it, without a fake model turn or private history writes.
            // This also makes stop/resume work before the operator's first message.
            await this.process.request("thread/archive", { threadId: this.sessionFile });
            await this.process.request("thread/unarchive", { threadId: this.sessionFile });
            await this.openThread({ ...options, resume: this.sessionFile }, config);
        }
    }
    async openThread(options, config) {
        const result = await this.process.request(options.resume ? "thread/resume" : "thread/start", { ...(options.resume ? { threadId: options.resume } : {}), cwd: this.cwd, approvalPolicy: "never", sandbox: "danger-full-access", developerInstructions: managedInstructions, config, ...(options.model ? { model: options.model } : {}), ...(options.resume ? { excludeTurns: true } : { ephemeral: false, historyMode: "legacy" }) });
        if (typeof result?.thread?.id !== "string" || !result.thread.id)
            throw new Error("Codex did not return a saved thread ID.");
        this.sessionFile = result.thread.id;
        this.host.state("idle");
    }
    frame(frame) {
        const params = frame.params ?? {}, method = frame.method;
        if (frame.id !== undefined && method) {
            // An attached TUI owns interactive approval/user-input requests. Headless requests fail visibly.
            if (!this.terminal || !this.view)
                this.process.send({ id: frame.id, error: { code: -32601, message: "This unattended session cannot answer interactive approval or input requests. Use the Sideband room to ask its operator." } });
            return;
        }
        if (method === "error" && !params.threadId) {
            this.host.event("error", params.error?.message ?? params.message ?? "Codex error.");
            return;
        }
        if (params.threadId !== this.sessionFile)
            return;
        if (method === "turn/started") {
            this.streamed.clear();
            this.activeTurn = params.turn?.id;
            this.host.state("busy");
        }
        else if (method === "turn/completed") {
            this.activeTurn = undefined;
            if (typeof params.turn?.id === "string") {
                this.completed.add(params.turn.id);
                if (this.completed.size > 128)
                    this.completed.delete(this.completed.values().next().value);
            }
            if (params.turn?.error?.message)
                this.host.event("error", params.turn.error.message);
            this.host.state("idle");
        }
        else if (method === "item/agentMessage/delta" || method === "item/reasoning/summaryTextDelta" || method === "item/reasoning/textDelta") {
            if (typeof params.itemId === "string")
                this.streamed.add(params.itemId);
            this.host.event(method.includes("reasoning") ? "thinking" : "assistant", String(params.delta ?? ""));
        }
        else if (method === "item/commandExecution/outputDelta")
            this.host.event("tool-output", String(params.delta ?? ""));
        else if (method === "item/started" || method === "item/completed") {
            const item = params.item;
            if (!item)
                return;
            if (item.type === "agentMessage" && method.endsWith("completed") && !this.streamed.has(item.id))
                this.host.event("assistant", item.text ?? "");
            else if (item.type === "userMessage" && this.terminal && method.endsWith("completed")) {
                const text = (item.content ?? []).filter((part) => part.type === "text").map((part) => part.text).join("\n");
                if (!this.roomInputs.delete(text))
                    this.host.event("user", text);
            }
            else if (["commandExecution", "mcpToolCall", "dynamicToolCall", "fileChange", "webSearch"].includes(item.type))
                this.host.event(method.endsWith("started") ? "tool" : "tool-output", JSON.stringify(item));
        }
        else if (method === "thread/status/changed" && params.status?.type === "idle")
            this.host.state("idle");
        else if (method === "error")
            this.host.event("error", params.error?.message ?? "Codex error.");
    }
    async prompt(text) {
        for (let attempt = 0; attempt < 3; attempt++) {
            try {
                if (this.activeTurn)
                    await this.process.request("turn/steer", { threadId: this.sessionFile, expectedTurnId: this.activeTurn, input: [{ type: "text", text, text_elements: [] }] });
                else {
                    const result = await this.process.request("turn/start", { threadId: this.sessionFile, input: [{ type: "text", text, text_elements: [] }], disabledPluginIds: ["sideband@sideband"], ...(this.effort ? { effort: this.effort } : {}) });
                    if (!this.activeTurn && result.turn?.status === "inProgress" && !this.completed.has(result.turn.id))
                        this.activeTurn = result.turn.id;
                }
                return;
            }
            catch (error) {
                if (!(error instanceof Error) || !/no active turn|turn.*mismatch|turn.*in progress|expected.*turn|turn.*already/i.test(error.message))
                    throw error;
                const read = await this.process.request("thread/read", { threadId: this.sessionFile, includeTurns: true });
                this.activeTurn = read.thread?.turns?.findLast((turn) => turn.status === "inProgress")?.id;
            }
        }
        throw new Error("The Codex turn changed repeatedly; message was not accepted.");
    }
    async interrupt() { if (this.activeTurn)
        await this.process.request("turn/interrupt", { threadId: this.sessionFile, turnId: this.activeTurn }); }
    async deliver(text) {
        const value = text;
        if (this.terminal) {
            this.roomInputs.add(value);
            if (this.roomInputs.size > 100)
                this.roomInputs.delete(this.roomInputs.values().next().value);
        }
        try {
            await this.prompt(value);
        }
        catch (error) {
            this.roomInputs.delete(value);
            throw error;
        }
    }
    exit(error) { if (this.exited || this.stopping)
        return; this.exited = true; this.listener?.reject(error ?? new Error("Codex exited during startup.")); this.host.exit(error); void this.stop(); }
    stop() { return this.closing ??= this.close(); }
    async close() { this.stopping = true; await this.view?.stop(); this.socket?.terminate(); await this.process.stop(); await this.tools.close(); await unlink(this.tokenFile).catch(() => { }); }
}
//# sourceMappingURL=managed-codex.js.map