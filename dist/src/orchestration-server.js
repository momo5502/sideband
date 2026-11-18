import { CONTROL_TIMEOUT_MS } from "./timeouts.js";
import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import { fields, text, RoomError } from "./room-protocol.js";
import { launchSpec } from "./orchestration-protocol.js";
import { parseBuild, parseUpdate } from "./update-types.js";
import { UpdateFleet } from "./update-fleet.js";
const uuid = (value) => { const id = text(value, "ID", 64); if (!/^[a-f0-9-]{36}$/.test(id))
    throw new Error("Invalid ID."); return id; };
/** Authenticated control plane. Room messages never pass through this broker. */
export class OrchestrationServer {
    send;
    peers = new Map();
    workers = new Map();
    runners = new Map();
    machines = new Map();
    agents = new Map();
    runnerOwners = new Map();
    forgotten = new Set();
    legacyRemoval = new WeakSet();
    async stopLegacyRunner(peer) {
        try {
            await this.dispatch(peer, "stop", {});
            await this.dispatch(peer, "dispose", {});
        }
        catch {
            peer.socket.terminate();
        }
    }
    forget(id) {
        this.forgotten.add(id);
        if (this.forgotten.size > 10000)
            this.forgotten.delete(this.forgotten.values().next().value);
        this.agents.delete(id);
        this.changed();
    }
    browsers = new Map();
    pending = new Map();
    updates;
    constructor(send, updater) {
        this.send = send;
        if (updater) {
            this.updates = new UpdateFleet(updater, () => [...this.machines.values()], (id, target) => this.dispatch(this.workers.get(id), "update", { target }));
            this.updates.onChange(() => this.changed());
        }
    }
    isWorker(socket) { return !!socket && this.peers.get(socket)?.kind === "worker"; }
    changed() { for (const socket of this.browsers.keys())
        this.send(socket, { event: "control.changed", data: {} }); }
    online(peer) { return peer?.socket.readyState === WebSocket.OPEN; }
    dispatch(peer, method, params) {
        if (!peer || !this.online(peer))
            throw new Error("Machine or agent is offline.");
        if (this.pending.size >= 256)
            throw new Error("Too many pending control requests.");
        const id = randomUUID();
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => { this.pending.delete(id); reject(new Error("Control request timed out; acceptance is unknown. Check the agent before retrying.")); }, CONTROL_TIMEOUT_MS);
            this.pending.set(id, { socket: peer.socket, resolve, reject, timer });
            this.send(peer.socket, { event: "control.command", data: { id, method, params } });
        });
    }
    agent(input) {
        const value = fields(input, ["name", "harness", "repository", "ref", "model", "effort", "room", "prompt", "terminal", "id", "machineId", "machineName", "state", "online", "createdAt", "error", "canResume"]);
        const { id, machineId, machineName, state, createdAt, error, online, canResume, ...spec } = value;
        if (canResume !== undefined && typeof canResume !== "boolean")
            throw new Error("Invalid resume capability.");
        if (!["preparing", "starting", "idle", "busy", "stopped", "failed"].includes(state) || !Number.isFinite(createdAt))
            throw new Error("Invalid agent state.");
        return { ...launchSpec(spec), id: uuid(id), machineId: uuid(machineId), machineName: text(machineName, "machine name", 100), state: state, createdAt: createdAt,
            room: typeof spec.room === "string" ? spec.room : "", online: true, ...(error ? { error: text(error, "error", 2048) } : {}), ...(canResume !== undefined ? { canResume: canResume } : {}) };
    }
    async request(socket, browser, method, params, identity) {
        if (method === "control.worker" || method === "control.runner") {
            if (browser)
                throw new Error("Worker registration requires a native connection.");
            const kind = method === "control.worker" ? "worker" : "runner";
            const existing = this.peers.get(socket);
            const args = fields(params, [kind === "worker" ? "machine" : "agent"]);
            if (kind === "worker") {
                const machine = fields(args.machine, ["id", "name", "platform", "harnesses", "online", "terminal", "build", "updater", "update"]);
                if (machine.terminal !== undefined && !["window", "tmux", "none"].includes(String(machine.terminal)))
                    throw new Error("Invalid terminal capability.");
                const id = uuid(machine.id);
                if (existing && (existing.kind !== kind || existing.id !== id))
                    throw new Error("Connection already registered.");
                if (!Array.isArray(machine.harnesses) || machine.harnesses.some(h => !["omp", "codex", "claude"].includes(String(h))))
                    throw new Error("Invalid harness list.");
                if (machine.updater !== undefined && typeof machine.updater !== "boolean")
                    throw new Error("Invalid updater capability.");
                const metadata = { ...(machine.build !== undefined ? { build: parseBuild(machine.build) } : {}),
                    ...(machine.update !== undefined ? { update: parseUpdate(machine.update) } : {}), ...(machine.updater !== undefined ? { updater: machine.updater } : {}) };
                const prior = this.workers.get(id);
                if (prior && prior.socket !== socket && this.online(prior))
                    throw new Error("A worker for this machine is already connected.");
                const peer = { socket, kind, id };
                this.peers.set(socket, peer);
                this.workers.set(id, peer);
                this.machines.set(id, { id, name: text(machine.name, "machine name", 100), platform: text(machine.platform, "platform", 32), harnesses: machine.harnesses, online: true, ...metadata, ...(machine.terminal ? { terminal: machine.terminal } : {}) });
            }
            else {
                const agent = this.agent(args.agent);
                if (agent.name !== identity.name)
                    throw new Error("Runner name must match its authenticated room identity.");
                const owner = this.runnerOwners.get(agent.id);
                if (owner && owner !== identity.id)
                    throw new Error("This agent ID belongs to another verified identity.");
                if (this.forgotten.has(agent.id)) {
                    if (agent.canResume === undefined) {
                        // Runners from 0.16 don't understand AGENT_FORGOTTEN. Their existing stop/dispose
                        // commands still let a new server retire them without upgrading a live process.
                        const peer = { socket, kind, id: agent.id };
                        this.peers.set(socket, peer);
                        if (!this.legacyRemoval.has(socket)) {
                            this.legacyRemoval.add(socket);
                            setTimeout(() => { void this.stopLegacyRunner(peer); }, 0).unref();
                        }
                        return { registered: true, removed: true };
                    }
                    throw new RoomError("AGENT_FORGOTTEN", "This agent was removed. Its runner must shut down.");
                }
                if (existing && (existing.kind !== kind || existing.id !== agent.id))
                    throw new Error("Connection already registered.");
                const prior = this.runners.get(agent.id);
                if (prior && prior.socket !== socket && this.online(prior))
                    throw new Error("Agent runner already connected.");
                const peer = { socket, kind, id: agent.id };
                this.peers.set(socket, peer);
                this.runners.set(agent.id, peer);
                this.agents.set(agent.id, { ...agent, identityId: identity.id });
                this.runnerOwners.set(agent.id, identity.id);
                if (!this.machines.has(agent.machineId))
                    this.machines.set(agent.machineId, { id: agent.machineId, name: agent.machineName, platform: "unknown", harnesses: [], online: false });
            }
            this.changed();
            return { registered: true };
        }
        if (method === "control.worker_update") {
            const peer = this.peers.get(socket);
            if (browser || peer?.kind !== "worker")
                throw new Error("Only a registered worker can report update status.");
            const args = fields(params, ["update"]);
            this.machines.get(peer.id).update = parseUpdate(args.update);
            this.changed();
            return { accepted: true };
        }
        if (method === "control.reply") {
            const args = fields(params, ["id", "result", "error"]), id = text(args.id, "command ID", 64), pending = this.pending.get(id);
            if (!this.peers.has(socket) || !pending || pending.socket !== socket)
                throw new Error("Unknown control command.");
            clearTimeout(pending.timer);
            this.pending.delete(id);
            if (args.error)
                pending.reject(new Error(text(args.error, "error", 2048)));
            else
                pending.resolve(args.result);
            return {};
        }
        if (method === "control.publish") {
            const peer = this.peers.get(socket);
            if (peer?.kind !== "runner")
                throw new Error("Only an agent runner can publish output.");
            if (this.forgotten.has(peer.id))
                return { removed: true };
            const args = fields(params, ["agent", "events"]), agent = this.agent(args.agent);
            if (agent.id !== peer.id || agent.machineId !== this.agents.get(peer.id)?.machineId || agent.name !== identity.name)
                throw new Error("Invalid runner identity.");
            if (!Array.isArray(args.events) || args.events.length > 30)
                throw new Error("Invalid event batch.");
            const events = args.events.map(value => {
                const event = fields(value, ["seq", "at", "kind", "text"]);
                if (!Number.isSafeInteger(event.seq) || event.seq < 1 || !Number.isFinite(event.at))
                    throw new Error("Invalid output event.");
                return { seq: event.seq, at: event.at, kind: text(event.kind, "event kind", 64), text: typeof event.text === "string" && event.text.length <= 8192 ? event.text : text(event.text, "event text", 8192) };
            });
            const previous = this.agents.get(peer.id);
            this.agents.set(peer.id, { ...agent, identityId: identity.id });
            if (previous.state !== agent.state || previous.room !== agent.room || previous.error !== agent.error)
                this.changed();
            if (events.length)
                for (const [watcher, watching] of this.browsers)
                    if (watching === peer.id)
                        this.send(watcher, { event: "control.output", data: { agentId: peer.id, events } });
            return {};
        }
        if (!browser)
            throw new Error("Orchestration controls are available through the authenticated web panel.");
        if (method === "control.list") {
            fields(params, []);
            if (!this.browsers.has(socket))
                this.browsers.set(socket, undefined);
            return { machines: [...this.machines.values()], agents: [...this.agents.values()], ...(this.updates ? { updates: this.updates.state } : {}) };
        }
        if (method === "control.updates.check" || method === "control.updates.start") {
            fields(params, []);
            if (!this.updates)
                throw new Error("Automatic updates require a supervised Sideband server. Install the latest CLI manually once.");
            return method === "control.updates.check" ? this.updates.check() : this.updates.start();
        }
        if (method === "control.claude_trust") {
            const args = fields(params, ["machineId", "confirm"]);
            if (args.confirm !== true)
                throw new Error("Confirm trusting this machine's Sideband workspace root first.");
            const machine = this.machines.get(uuid(args.machineId));
            if (!machine?.online || !machine.harnesses.includes("claude"))
                throw new Error("Select an online machine with Claude installed.");
            return this.dispatch(this.workers.get(machine.id), "claude-trust", {});
        }
        if (method === "control.launch") {
            const { machineId, ...specInput } = fields(params, ["machineId", "name", "harness", "repository", "ref", "model", "effort", "room", "prompt", "terminal"]);
            const machine = this.machines.get(uuid(machineId));
            if (!machine?.online)
                throw new Error("Select an online machine.");
            const spec = launchSpec(specInput);
            if (!machine.harnesses.includes(spec.harness))
                throw new Error("This harness is not available on that machine.");
            if (spec.terminal && (!machine.terminal || machine.terminal === "none"))
                throw new Error("This worker cannot open a terminal. Update it, add a terminal launcher, or choose Background mode.");
            if (spec.terminal && spec.harness === "claude" && machine.platform !== "win32" && machine.terminal !== "tmux")
                throw new Error("Native Claude input requires Windows or tmux. Choose Background mode.");
            const id = randomUUID();
            await this.dispatch(this.workers.get(machine.id), "launch", { id, spec });
            return { id };
        }
        if (method === "control.watch") {
            const args = fields(params, ["agentId"]);
            if (!args.agentId) {
                this.browsers.set(socket, undefined);
                return { events: [], first: 1, next: 1 };
            }
            const id = uuid(args.agentId);
            if (!this.agents.has(id))
                throw new Error("Unknown agent.");
            this.browsers.set(socket, id);
            return this.dispatch(this.runners.get(id), "logs", {});
        }
        if (method === "control.action") {
            const args = fields(params, ["agentId", "action", "text", "room"]), id = uuid(args.agentId);
            const action = text(args.action, "action", 32);
            if (!["prompt", "interrupt", "stop", "resume", "room", "dispose"].includes(action))
                throw new Error("Unknown agent action.");
            if (action === "prompt")
                text(args.text, "instructions", 16000);
            if (action === "room" && (typeof args.room !== "string" || args.room.length > 100))
                throw new Error("Invalid room name.");
            if (action === "dispose" && this.agents.has(id) && !this.online(this.runners.get(id))) {
                this.forget(id);
                return { removed: true, offline: true, workspaceRetained: true };
            }
            const result = await this.dispatch(this.runners.get(id), action, { ...(action === "prompt" ? { text: args.text } : {}), ...(action === "room" ? { room: args.room } : {}) });
            if (action === "dispose")
                this.forget(id);
            return result;
        }
        throw new Error("Unknown orchestration operation.");
    }
    disconnect(socket) {
        this.browsers.delete(socket);
        for (const [id, pending] of this.pending)
            if (pending.socket === socket) {
                clearTimeout(pending.timer);
                pending.reject(new Error("Connection lost; control request acceptance is unknown."));
                this.pending.delete(id);
            }
        const peer = this.peers.get(socket);
        this.peers.delete(socket);
        if (!peer)
            return;
        if (peer.kind === "worker" && this.workers.get(peer.id) === peer) {
            this.workers.delete(peer.id);
            const machine = this.machines.get(peer.id);
            if (machine)
                machine.online = false;
        }
        if (peer.kind === "runner" && this.runners.get(peer.id) === peer) {
            this.runners.delete(peer.id);
            const agent = this.agents.get(peer.id);
            if (agent)
                agent.online = false;
        }
        this.changed();
    }
    close() { this.updates?.close(); for (const socket of [...this.peers.keys(), ...this.browsers.keys()])
        this.disconnect(socket); this.machines.clear(); this.agents.clear(); this.runnerOwners.clear(); this.forgotten.clear(); }
}
//# sourceMappingURL=orchestration-server.js.map