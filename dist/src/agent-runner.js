import { mkdir } from "node:fs/promises";
import { join, resolve, relative } from "node:path";
import spawn from "cross-spawn";
import { RoomClient } from "./room-client.js";
import { formatDelivery } from "./protocol.js";
import { ManagedOmp } from "./managed-omp.js";
import { OutputBuffer, launchSpec } from "./orchestration-protocol.js";
import { terminateTree } from "./process-tree.js";
const errorText = (error) => (error instanceof Error ? error.message : "Operation failed.").slice(0, 2048);
/** Independent of the worker: owns the harness, room identity, and bounded output. */
export class AgentRunner {
    config;
    client;
    output = new OutputBuffer();
    agent;
    driver;
    sessionFile;
    timer;
    flushing = false;
    events = [];
    operations = Promise.resolve();
    inbox = Promise.resolve();
    inboxSize = 0;
    roomEpoch = 0;
    closed = false;
    desiredRoom;
    directory;
    workspace;
    checkoutReady = false;
    preparing;
    published = "";
    stopRequested = false;
    constructor(config) {
        this.config = config;
        const spec = launchSpec(config.spec);
        if (!/^[a-f0-9-]{36}$/.test(config.id))
            throw new Error("Invalid runner ID.");
        this.directory = resolve(config.root, config.id);
        if (relative(resolve(config.root), this.directory) !== config.id)
            throw new Error("Invalid workspace path.");
        this.workspace = join(this.directory, "repo");
        this.desiredRoom = spec.room ?? "";
        const { prompt: _prompt, ...description } = spec;
        this.agent = { ...description, id: config.id, machineId: config.machineId, machineName: config.machineName, room: this.desiredRoom, state: "preparing", online: true, createdAt: Date.now() };
        this.client = new RoomClient(config.profile, spec.name, { onError: error => this.record("connection", error.message) });
        this.client.onConnected(async () => { await this.client.request("control.runner", { agent: this.agent }); });
        this.client.onEvent((event, data) => { if (event === "control.command")
            this.command(data); });
        this.client.onMessage(message => this.deliver(formatDelivery({ messageId: message.id, channelId: message.roomId, sender: message.sender, senderAccountId: message.sender.id,
            text: message.text, createdAt: message.createdAt, attachments: [], verified: true }), message.roomId));
        this.client.onPresence(event => this.deliver(formatDelivery({ messageId: event.id, channelId: event.roomId, sender: event.participant, senderAccountId: event.participant.id,
            presence: event.kind, text: "", createdAt: event.createdAt, attachments: [] }), event.roomId));
    }
    record(kind, text) {
        if (!text)
            return;
        const event = this.output.append(kind, text);
        this.events.push(event);
        if (this.events.length > 1000)
            this.events.shift();
    }
    state(state, error) {
        this.agent.state = state;
        this.agent.error = error === undefined ? undefined : errorText(error);
        this.record("state", error ? `${state}: ${this.agent.error}` : state);
    }
    async flush() {
        if (this.closed || this.flushing || this.client.state !== "on")
            return;
        const status = JSON.stringify(this.agent);
        if (!this.events.length && status === this.published)
            return;
        this.flushing = true;
        const batch = this.events.splice(0, 20);
        try {
            await this.client.request("control.publish", { agent: this.agent, events: batch });
            this.published = status;
        }
        catch { /* Ring buffer remains authoritative. Do not replay uncertain live packets. */ }
        finally {
            this.flushing = false;
        }
    }
    command(command) {
        if (command.method === "stop") {
            this.stopRequested = true;
            if (this.preparing)
                terminateTree(this.preparing);
            if (this.agent.state === "starting")
                void this.driver?.stop();
        }
        // Log reads never wait for clone/start operations; the panel stays inspectable during startup.
        const handle = command.method === "logs" ? Promise.resolve(this.output.snapshot()) : this.operations.then(() => this.action(command.method, command.params));
        if (command.method !== "logs")
            this.operations = handle.then(() => { }, () => { });
        void handle.then(result => this.client.request("control.reply", { id: command.id, result })).catch(async (error) => {
            await this.client.request("control.reply", { id: command.id, error: errorText(error) }).catch(() => { });
        });
    }
    deliver(text, roomId) {
        if (this.agent.state === "stopped" || this.closed)
            return;
        if (this.inboxSize >= 100) {
            this.record("error", "Room delivery backlog is full; inspect room history for missed messages.");
            return;
        }
        const epoch = this.roomEpoch;
        this.inboxSize++;
        this.inbox = this.inbox.then(async () => {
            if (this.closed || epoch !== this.roomEpoch || this.client.room?.id !== roomId || !this.driver)
                return;
            this.record("room", text);
            await this.driver.prompt(text);
        }).catch(error => this.record("error", errorText(error))).finally(() => { this.inboxSize--; });
    }
    async start() {
        await this.client.connect();
        this.timer = setInterval(() => { void this.flush(); }, 200);
        // The runner registers before cloning, so a failed clone is visible and never creates an orphan.
        this.operations = this.launch().catch(error => { if (!this.stopRequested && !this.closed)
            this.state("failed", error); });
    }
    async git(args) {
        await new Promise((resolvePromise, reject) => {
            const child = spawn("git", args, { cwd: this.directory, windowsHide: true, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"],
                env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never", GIT_SSH_COMMAND: "ssh -oBatchMode=yes" } });
            this.preparing = child;
            child.stdout?.setEncoding("utf8");
            child.stderr?.setEncoding("utf8");
            child.stdout?.on("data", chunk => this.record("git", String(chunk)));
            child.stderr?.on("data", chunk => this.record("git", String(chunk)));
            const timer = setTimeout(() => { terminateTree(child); reject(new Error("Repository operation timed out.")); }, 10 * 60_000);
            child.once("error", error => { clearTimeout(timer); reject(error); });
            child.once("close", code => { clearTimeout(timer); this.preparing = undefined; code === 0 ? resolvePromise() : reject(new Error(`Git exited (${code}). Check the repository URL and this machine's Git credentials.`)); });
        });
    }
    async launch() {
        await mkdir(this.directory, { recursive: true, mode: 0o700 });
        this.record("git", `Cloning ${this.agent.repository}`);
        await this.git(["clone", "--", this.agent.repository, "repo"]);
        if (this.closed || this.stopRequested)
            return;
        if (this.agent.ref)
            await this.git(["-C", "repo", "checkout", "--detach", this.agent.ref]);
        this.checkoutReady = true;
        await this.startHarness();
        if (this.closed || this.stopRequested)
            return;
        if (this.desiredRoom)
            await this.changeRoom(this.desiredRoom);
        const prompt = launchSpec(this.config.spec).prompt;
        if (prompt) {
            this.record("user", prompt);
            await this.driver.prompt(prompt);
        }
    }
    async tool(name, args) {
        if (!args || typeof args !== "object" || Array.isArray(args))
            throw new Error("Invalid tool arguments.");
        if (name === "sideband_room_send") {
            const value = args.text;
            if (typeof value !== "string" || !value.trim())
                throw new Error("A message is required.");
            return this.client.send(value);
        }
        if (name === "sideband_room_status")
            return { identity: this.client.identity, room: this.client.room, state: this.client.state };
        if (name === "sideband_room_members")
            return this.client.members();
        if (name === "sideband_room_history")
            return this.client.history();
        throw new Error("Unknown managed room tool.");
    }
    async startHarness() {
        if (this.closed || this.stopRequested)
            throw new Error("Runner is stopped.");
        this.state("starting");
        const driver = new ManagedOmp(this.config.omp, this.workspace, join(this.directory, "sessions"), {
            event: (kind, text) => this.record(kind, text), state: state => { if (this.driver === driver && !this.closed && !this.stopRequested)
                this.agent.state = state; },
            exit: error => { if (this.driver === driver && !this.closed && !this.stopRequested)
                this.state("failed", error); },
            tool: (name, args) => this.tool(name, args),
        });
        this.driver = driver;
        try {
            await driver.start({ model: this.agent.model, effort: this.agent.effort, resume: this.sessionFile });
        }
        catch (error) {
            if (!this.closed && !this.stopRequested)
                this.state("failed", error);
            throw error;
        }
        this.sessionFile = driver.sessionFile;
        if (!this.closed && !this.stopRequested)
            this.state("idle");
    }
    async changeRoom(room) {
        ++this.roomEpoch;
        if (room) {
            const joined = await this.client.joinRoom(room);
            this.desiredRoom = joined.name;
        }
        else {
            if (this.client.room)
                await this.client.leaveRoom();
            this.desiredRoom = "";
        }
        this.agent.room = this.desiredRoom;
        this.record("state", this.desiredRoom ? `Joined room ${this.desiredRoom}` : "Left room");
    }
    async action(method, params) {
        if (this.closed)
            throw new Error("Runner is closed.");
        switch (method) {
            case "prompt": {
                if (!this.driver || !["idle", "busy"].includes(this.agent.state))
                    throw new Error("Resume the agent before sending instructions.");
                const text = params.text;
                if (typeof text !== "string" || !text.trim() || text.length > 16000)
                    throw new Error("Invalid instructions.");
                this.record("user", text);
                await this.driver.prompt(text);
                return { accepted: true };
            }
            case "interrupt":
                if (!this.driver)
                    throw new Error("Agent is not running.");
                await this.driver.interrupt();
                return { interrupted: true };
            case "room":
                if (typeof params.room !== "string" || params.room.length > 100)
                    throw new Error("Invalid room.");
                await this.changeRoom(params.room);
                return { room: this.agent.room };
            case "stop": {
                if (this.agent.state === "stopped")
                    return { stopped: true };
                this.state("stopped");
                ++this.roomEpoch;
                if (this.driver) {
                    this.sessionFile = this.driver.sessionFile ?? this.sessionFile;
                    await this.driver.stop();
                    this.driver = undefined;
                }
                if (this.client.room)
                    await this.client.leaveRoom();
                return { stopped: true };
            }
            case "resume": {
                if (!["stopped", "failed"].includes(this.agent.state) || !this.checkoutReady)
                    throw new Error("This agent cannot be resumed.");
                if (this.driver)
                    await this.driver.stop();
                this.stopRequested = false;
                await this.startHarness();
                if (this.desiredRoom)
                    await this.changeRoom(this.desiredRoom);
                return { resumed: true };
            }
            case "dispose": {
                if (this.agent.state !== "stopped" && this.agent.state !== "failed")
                    throw new Error("Stop the agent before removing its runner.");
                // Preserve checkout/history. Reclaiming disk is a separate, explicit workspace operation.
                setTimeout(() => { void this.close(); }, 100);
                return { removed: true, workspaceRetained: true };
            }
            default: throw new Error("Unknown runner operation.");
        }
    }
    async close() {
        if (this.closed)
            return;
        this.closed = true;
        if (this.timer)
            clearInterval(this.timer);
        ++this.roomEpoch;
        if (this.preparing)
            terminateTree(this.preparing);
        await this.driver?.stop();
        await this.client.close();
    }
}
/** Private CLI entry: bootstrap travels through stdin, never command arguments or disk. */
export async function runAgentRunner() {
    let input = "";
    for await (const chunk of process.stdin) {
        input += chunk.toString();
        if (Buffer.byteLength(input) > 64 * 1024)
            throw new Error("Runner bootstrap is too large.");
    }
    let runner;
    try {
        runner = new AgentRunner(JSON.parse(input));
        process.once("SIGINT", () => { void runner?.close(); });
        process.once("SIGTERM", () => { void runner?.close(); });
        await runner.start();
        process.send?.({ type: "runner.ready" });
    }
    catch (error) {
        process.send?.({ type: "runner.error", error: errorText(error) });
        await runner?.close();
        throw error;
    }
}
//# sourceMappingURL=agent-runner.js.map