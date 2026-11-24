import { CONTROL_TIMEOUT_MS } from "./timeouts.js";
import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import { fields, text, RoomError, type AgentIdentity } from "./room-protocol.js";
import { launchSpec, modelCatalog, type HarnessName, type Machine, type ManagedAgent, type OutputEvent } from "./orchestration-protocol.js";
import { parseBuild, parseUpdate } from "./update-types.js";
import type { RuntimeUpdater } from "./updater.js";
import type { Registry } from "./persistence.js";
import { UpdateFleet } from "./update-fleet.js";

type Peer = { socket: WebSocket; kind: "worker" | "runner"; id: string };
type Pending = { socket: WebSocket; resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout };
const uuid = (value: unknown) => { const id = text(value, "ID", 64); if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("Invalid ID."); return id; };

/** Authenticated control plane. Room messages never pass through this broker. */
export class OrchestrationServer {
  private peers = new Map<WebSocket, Peer>();
  private workers = new Map<string, Peer>();
  private runners = new Map<string, Peer>();
  private machines = new Map<string, Machine>();
  private agents = new Map<string, ManagedAgent>();
  private runnerOwners = new Map<string, string>();
  private forgotten = new Set<string>();
  private archived = new Set<string>();
  private resuming = new Set<string>();
  private legacyRemoval = new WeakSet<WebSocket>();
  private async stopLegacyRunner(peer: Peer): Promise<void> {
    try { await this.dispatch(peer, "stop", {}); await this.dispatch(peer, "dispose", {}); }
    catch { peer.socket.terminate(); }
  }
  private async forget(id: string): Promise<void> {
    const machineId = this.agents.get(id)?.machineId;
    await this.store?.change(() => { this.store!.put("removal", id, { kind: "forgotten", machineId }); this.store!.remove("agent", id); });
    this.forgotten.add(id);
    if (this.forgotten.size > 10000) this.forgotten.delete(this.forgotten.values().next().value!);
    this.agents.delete(id); this.changed();
  }
  private browsers = new Map<WebSocket, string | undefined>();
  private pending = new Map<string, Pending>();
  private updates?: UpdateFleet;
  constructor(private readonly send: (socket: WebSocket, packet: object) => void, updater?: RuntimeUpdater, private readonly store?: Registry) {
    for (const [id, machine] of store?.all<Machine>("machine") ?? []) this.machines.set(id, { ...machine, online: false });
    for (const [id, agent] of store?.all<ManagedAgent>("agent") ?? []) this.agents.set(id, { ...agent, online: false, state: "stopped" });
    for (const [id, owner] of store?.all<string>("owner") ?? []) this.runnerOwners.set(id, owner);
    for (const [id, removal] of store?.all<{ kind: string }>("removal") ?? []) (removal.kind === "archived" ? this.archived : this.forgotten).add(id);
    if (updater) { this.updates = new UpdateFleet(updater, () => [...this.machines.values()], (id, target) => this.dispatch(this.workers.get(id), "update", { target })); this.updates.onChange(() => this.changed()); }
  }
  private save(kind: string, id: string, value: unknown): Promise<unknown> {
    if (kind === "machine") { const { models: _catalogs, ...metadata } = value as Machine; value = metadata; }
    return this.store?.change(() => this.store!.put(kind, id, value)) ?? Promise.resolve();
  }
  isWorker(socket?: WebSocket): boolean { return !!socket && this.peers.get(socket)?.kind === "worker"; }
  private changed(): void { for (const socket of this.browsers.keys()) this.send(socket, { event: "control.changed", data: {} }); }
  private online(peer?: Peer): boolean { return peer?.socket.readyState === WebSocket.OPEN; }
  private dispatch(peer: Peer | undefined, method: string, params: Record<string, unknown>): Promise<unknown> {
    if (!peer || !this.online(peer)) throw new Error("Machine or agent is offline.");
    if (this.pending.size >= 256) throw new Error("Too many pending control requests.");
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error("Control request timed out; acceptance is unknown. Check the agent before retrying.")); }, CONTROL_TIMEOUT_MS);
      this.pending.set(id, { socket: peer.socket, resolve, reject, timer });
      this.send(peer.socket, { event: "control.command", data: { id, method, params } });
    });
  }
  private agent(input: unknown): ManagedAgent {
    const value = fields(input, ["name", "harness", "repository", "folder", "ref", "model", "effort", "room", "prompt", "terminal", "id", "machineId", "machineName", "state", "online", "createdAt", "error", "canResume", "persistent", "archived", "identityId"]);
    const { id, machineId, machineName, state, createdAt, error, online, canResume, persistent, archived, identityId, ...spec } = value;
    for (const flag of [persistent, archived]) if (flag !== undefined && typeof flag !== "boolean") throw new Error("Invalid persistence flag.");
    if (canResume !== undefined && typeof canResume !== "boolean") throw new Error("Invalid resume capability.");
    if (!["preparing", "starting", "idle", "busy", "stopped", "failed"].includes(state as string) || !Number.isFinite(createdAt)) throw new Error("Invalid agent state.");
    return { ...launchSpec(spec), id: uuid(id), machineId: uuid(machineId), machineName: text(machineName, "machine name", 100), state: state as ManagedAgent["state"], createdAt: createdAt as number,
      room: typeof spec.room === "string" ? spec.room : "", online: true, ...(persistent !== undefined ? { persistent: persistent as boolean } : {}), ...(archived !== undefined ? { archived: archived as boolean } : {}), ...(typeof identityId === "string" ? { identityId: text(identityId, "identity", 100) } : {}), ...(error ? { error: text(error, "error", 2048) } : {}), ...(canResume !== undefined ? { canResume: canResume as boolean } : {}) };
  }
  async request(socket: WebSocket, browser: boolean, method: string, params: unknown, identity: AgentIdentity): Promise<unknown> {
    if (method === "control.worker" || method === "control.runner") {
      if (browser) throw new Error("Worker registration requires a native connection.");
      const kind = method === "control.worker" ? "worker" : "runner";
      const existing = this.peers.get(socket);
      const args = fields(params, [kind === "worker" ? "machine" : "agent"]);
      if (kind === "worker") {
        const machine = fields(args.machine, ["id", "name", "platform", "harnesses", "online", "terminal", "build", "updater", "update"]);
        if (machine.terminal !== undefined && !["window", "tmux", "none"].includes(String(machine.terminal))) throw new Error("Invalid terminal capability.");
        const id = uuid(machine.id);
        if (existing && (existing.kind !== kind || existing.id !== id)) throw new Error("Connection already registered.");
        if (!Array.isArray(machine.harnesses) || machine.harnesses.some(h => !["omp", "codex", "claude"].includes(String(h)))) throw new Error("Invalid harness list.");
        if (machine.updater !== undefined && typeof machine.updater !== "boolean") throw new Error("Invalid updater capability.");
        const metadata = { ...(machine.build !== undefined ? { build: parseBuild(machine.build) } : {}),
          ...(machine.update !== undefined ? { update: parseUpdate(machine.update) } : {}), ...(machine.updater !== undefined ? { updater: machine.updater } : {}) };
        const prior = this.workers.get(id);
        if (prior && prior.socket !== socket && this.online(prior)) throw new Error("A worker for this machine is already connected.");
        const peer: Peer = { socket, kind, id }; this.peers.set(socket, peer); this.workers.set(id, peer);
        this.machines.set(id, { id, name: text(machine.name, "machine name", 100), platform: text(machine.platform, "platform", 32), harnesses: machine.harnesses as string[], online: true, ...metadata, ...(machine.terminal ? { terminal: machine.terminal as Machine["terminal"] } : {}) });
        await this.save("machine", id, this.machines.get(id));
      } else {
        const agent = this.agent(args.agent);
        if (agent.name !== identity.name) throw new Error("Runner name must match its authenticated room identity.");
        const owner = this.runnerOwners.get(agent.id);
        if (owner && owner !== identity.id) throw new Error("This agent ID belongs to another verified identity.");
        if (this.archived.has(agent.id)) throw new RoomError("AGENT_ARCHIVED", "This agent is archived. Resume it through the worker.");
        if (this.forgotten.has(agent.id)) {
          if (agent.canResume === undefined) {
            // Runners from 0.16 don't understand AGENT_FORGOTTEN. Their existing stop/dispose
            // commands still let a new server retire them without upgrading a live process.
            const peer: Peer = { socket, kind, id: agent.id }; this.peers.set(socket, peer);
            if (!this.legacyRemoval.has(socket)) {
              this.legacyRemoval.add(socket);
              setTimeout(() => { void this.stopLegacyRunner(peer); }, 0).unref();
            }
            return { registered: true, removed: true };
          }
          throw new RoomError("AGENT_FORGOTTEN", "This agent was removed. Its runner must shut down.");
        }
        if (existing && (existing.kind !== kind || existing.id !== agent.id)) throw new Error("Connection already registered.");
        const prior = this.runners.get(agent.id);
        if (prior && prior.socket !== socket && this.online(prior)) throw new Error("Agent runner already connected.");
        const peer: Peer = { socket, kind, id: agent.id }; this.peers.set(socket, peer); this.runners.set(agent.id, peer); this.agents.set(agent.id, { ...agent, identityId: identity.id }); this.runnerOwners.set(agent.id, identity.id);
        await this.store?.change(() => { if (agent.persistent) this.store!.put("agent", agent.id, this.agents.get(agent.id)); this.store!.put("owner", agent.id, identity.id); });
        if (!this.machines.has(agent.machineId)) this.machines.set(agent.machineId, { id: agent.machineId, name: agent.machineName, platform: "unknown", harnesses: [], online: false });
      }
      this.changed(); return { registered: true, ...(kind === "worker" ? { capabilities: { models: true, folders: true } } : {}) };
    }
    if (method === "control.features") {
      const peer = this.peers.get(socket); if (browser || peer?.kind !== "worker") throw new Error("Only a registered worker can report its features.");
      const args = fields(params, ["folders"]); if (args.folders !== true) throw new Error("Invalid folder capability.");
      const machine = this.machines.get(peer.id)!; machine.folders = true; await this.save("machine", peer.id, machine); this.changed(); return {};
    }
    if (method === "control.models") {
      const peer = this.peers.get(socket); if (browser || peer?.kind !== "worker") throw new Error("Only a registered worker can report models.");
      const args = fields(params, ["harness", "catalog"]), machine = this.machines.get(peer.id)!;
      if (!machine.harnesses.includes(args.harness as string)) throw new Error("Harness is not available on this machine.");
      const catalog = modelCatalog(args.catalog);
      machine.models = { ...machine.models, [args.harness as HarnessName]: catalog }; this.changed(); return {};
    }
    if (method === "control.inventory") {
      const peer = this.peers.get(socket); if (browser || peer?.kind !== "worker") throw new Error("Only a registered worker can report saved sessions.");
      const args = fields(params, ["agents"]); if (!Array.isArray(args.agents) || args.agents.length > 30) throw new Error("Invalid saved-agent inventory.");
      const archived: string[] = [], errors: { id: string; message: string }[] = [];
      for (const value of args.agents) {
        try {
        const agent = this.agent(value);
        if (agent.machineId !== peer.id || agent.persistent !== true) throw new Error("Invalid saved-agent machine.");
        if (this.agents.has(agent.id) && this.agents.get(agent.id)!.machineId !== peer.id) throw new Error("Agent belongs to a different machine.");
        if (this.forgotten.has(agent.id)) { archived.push(agent.id); continue; }
        if (this.resuming.has(agent.id)) continue;
        if (this.online(this.runners.get(agent.id)) && !this.archived.has(agent.id)) continue;
        if (this.archived.has(agent.id) || agent.archived) {
          archived.push(agent.id); this.archived.add(agent.id); agent.archived = true; agent.state = "stopped";
          await this.save("removal", agent.id, { kind: "archived", machineId: peer.id });
        }
        if (this.resuming.has(agent.id) || this.online(this.runners.get(agent.id)) && !this.archived.has(agent.id)) {
          const index = archived.indexOf(agent.id); if (index >= 0) archived.splice(index, 1);
          continue;
        }
        if (!this.online(this.runners.get(agent.id)) || agent.archived) { this.agents.set(agent.id, { ...agent, online: false }); await this.save("agent", agent.id, this.agents.get(agent.id)); }
        } catch (error) { errors.push({ id: typeof value?.id === "string" ? value.id.slice(0, 64) : "unknown", message: error instanceof Error ? error.message : "Invalid saved agent." }); }
      }
      this.machines.get(peer.id)!.persistent = true; await this.save("machine", peer.id, this.machines.get(peer.id));
      this.changed(); return { archived, errors };
    }
    if (method === "control.worker_update") {
      const peer = this.peers.get(socket); if (browser || peer?.kind !== "worker") throw new Error("Only a registered worker can report update status.");
      const args = fields(params, ["update"]); this.machines.get(peer.id)!.update = parseUpdate(args.update); this.changed(); return { accepted: true };
    }
    if (method === "control.reply") {
      const args = fields(params, ["id", "result", "error"]), id = text(args.id, "command ID", 64), pending = this.pending.get(id);
      if (!this.peers.has(socket) || !pending || pending.socket !== socket) throw new Error("Unknown control command.");
      clearTimeout(pending.timer); this.pending.delete(id);
      if (args.error) pending.reject(new Error(text(args.error, "error", 2048))); else pending.resolve(args.result);
      return {};
    }
    if (method === "control.publish") {
      const peer = this.peers.get(socket); if (peer?.kind !== "runner") throw new Error("Only an agent runner can publish output.");
      if (this.forgotten.has(peer.id) || this.archived.has(peer.id)) return { removed: true };
      const args = fields(params, ["agent", "events"]), agent = this.agent(args.agent);
      if (agent.id !== peer.id || agent.machineId !== this.agents.get(peer.id)?.machineId || agent.name !== identity.name) throw new Error("Invalid runner identity.");
      if (!Array.isArray(args.events) || args.events.length > 30) throw new Error("Invalid event batch.");
      const events = args.events.map(value => {
        const event = fields(value, ["seq", "at", "kind", "text"]);
        if (!Number.isSafeInteger(event.seq) || (event.seq as number) < 1 || !Number.isFinite(event.at)) throw new Error("Invalid output event.");
        return { seq: event.seq, at: event.at, kind: text(event.kind, "event kind", 64), text: typeof event.text === "string" && event.text.length <= 8192 ? event.text : text(event.text, "event text", 8192) } as OutputEvent;
      });
      const previous = this.agents.get(peer.id)!;
      this.agents.set(peer.id, { ...agent, identityId: identity.id });
      if (previous.state !== agent.state || previous.room !== agent.room || previous.error !== agent.error || previous.canResume !== agent.canResume) { if (agent.persistent) await this.save("agent", peer.id, this.agents.get(peer.id)); this.changed(); }
      if (events.length) for (const [watcher, watching] of this.browsers) if (watching === peer.id) this.send(watcher, { event: "control.output", data: { agentId: peer.id, events } });
      return {};
    }
    if (!browser) throw new Error("Orchestration controls are available through the authenticated web panel.");
    if (method === "control.folders") {
      const args = fields(params, ["machineId", "path", "cursor"]), machine = this.machines.get(uuid(args.machineId));
      if (!machine?.online || !machine.folders) throw new Error("Update this worker to browse or use existing folders.");
      if (args.path !== undefined) text(args.path, "folder path", 4096);
      if (args.cursor !== undefined) text(args.cursor, "folder cursor", 255);
      return this.dispatch(this.workers.get(machine.id), "folders", { ...(args.path !== undefined ? { path: args.path } : {}), ...(args.cursor !== undefined ? { cursor: args.cursor } : {}) });
    }
    if (method === "control.models.refresh") {
      const args = fields(params, ["machineId", "harness"]), machine = this.machines.get(uuid(args.machineId));
      if (!machine?.online || !machine.harnesses.includes(args.harness as string)) throw new Error("Choose an online machine with this harness.");
      return this.dispatch(this.workers.get(machine.id), "models", { harness: args.harness });
    }
    if (method === "control.list") {
      fields(params, []); if (!this.browsers.has(socket)) this.browsers.set(socket, undefined);
      // Catalogs can contain hundreds of models. Fetch the selected catalog separately.
      const machines = [...this.machines.values()].map(machine => ({ ...machine, ...(machine.models ? { models: Object.fromEntries(Object.entries(machine.models).map(([harness, catalog]) => [harness, { ...catalog, models: [] }])) } : {}) }));
      return { machines, agents: [...this.agents.values()], ...(this.updates ? { updates: this.updates.state } : {}) };
    }
    if (method === "control.models.list") {
      const args = fields(params, ["machineId", "harness"]), machine = this.machines.get(uuid(args.machineId));
      if (!machine || !machine.harnesses.includes(args.harness as string)) throw new Error("Unknown machine or harness.");
      return machine.models?.[args.harness as HarnessName] ?? { models: [], at: 0 };
    }
    if (method === "control.updates.check" || method === "control.updates.start") {
      fields(params, []); if (!this.updates) throw new Error("Automatic updates require a supervised Sideband server. Install the latest CLI manually once.");
      return method === "control.updates.check" ? this.updates.check() : this.updates.start();
    }
    if (method === "control.claude_trust") {
      const args = fields(params, ["machineId", "confirm"]);
      if (args.confirm !== true) throw new Error("Confirm trusting this machine's Sideband workspace root first.");
      const machine = this.machines.get(uuid(args.machineId));
      if (!machine?.online || !machine.harnesses.includes("claude")) throw new Error("Select an online machine with Claude installed.");
      return this.dispatch(this.workers.get(machine.id), "claude-trust", {});
    }
    if (method === "control.launch") {
      const { machineId, ...specInput } = fields(params, ["machineId", "name", "harness", "repository", "folder", "ref", "model", "effort", "room", "prompt", "terminal"]);
      const machine = this.machines.get(uuid(machineId)); if (!machine?.online) throw new Error("Select an online machine.");
      const spec = launchSpec(specInput); if (!machine.harnesses.includes(spec.harness)) throw new Error("This harness is not available on that machine.");
      if (spec.folder && !machine.folders) throw new Error("Update this worker to launch in an existing folder.");
      if (spec.terminal && (!machine.terminal || machine.terminal === "none")) throw new Error("This worker cannot open a terminal. Update it, add a terminal launcher, or choose Background mode.");
      if (spec.terminal && spec.harness === "claude" && machine.platform !== "win32" && machine.terminal !== "tmux") throw new Error("Native Claude input requires Windows or tmux. Choose Background mode.");
      const id = randomUUID();
      await this.dispatch(this.workers.get(machine.id), "launch", { id, spec });
      return { id };
    }
    if (method === "control.watch") {
      const args = fields(params, ["agentId"]);
      if (!args.agentId) { this.browsers.set(socket, undefined); return { events: [], first: 1, next: 1 }; }
      const id = uuid(args.agentId); if (!this.agents.has(id)) throw new Error("Unknown agent.");
      this.browsers.set(socket, id); if (this.agents.get(id)?.persistent && !this.online(this.runners.get(id))) return { events: [], first: 1, next: 1 }; return this.dispatch(this.runners.get(id), "logs", {});
    }
    if (method === "control.action") {
      const args = fields(params, ["agentId", "action", "text", "room"]), id = uuid(args.agentId);
      let action = text(args.action, "action", 32);
      if (!["prompt", "interrupt", "stop", "resume", "room", "dispose", "archive"].includes(action)) throw new Error("Unknown agent action.");
      if (action === "prompt") text(args.text, "instructions", 16000);
      if (action === "room" && (typeof args.room !== "string" || args.room.length > 100)) throw new Error("Invalid room name.");
      const agent = this.agents.get(id);
      if (action === "dispose" && agent?.persistent) action = "archive";
      if (action === "archive") {
        if (!agent?.persistent) throw new Error("Restart this agent with a persistence-enabled runner before archiving it.");
        this.archived.add(id); Object.assign(agent, { archived: true, state: "stopped", online: false });
        await this.store?.change(() => { this.store!.put("removal", id, { kind: "archived", machineId: agent.machineId }); this.store!.put("agent", id, agent); });
        this.changed();
        const runner = this.runners.get(id), worker = this.workers.get(agent.machineId);
        if (this.online(runner)) await this.dispatch(runner, "archive", {});
        else if (this.online(worker)) await this.dispatch(worker, "archive", { id });
        return { archived: true, workspaceRetained: true };
      }
      if (agent?.persistent && !this.online(this.runners.get(id)) && ["resume", "stop"].includes(action)) {
        if (!this.online(this.workers.get(agent.machineId))) throw new Error("Bring this agent's machine online before resuming or stopping it.");
        if (action === "resume" && !agent.canResume) throw new Error(agent.error ?? "This session cannot be resumed.");
        const wasArchived = agent.archived;
        this.resuming.add(id);
        try {
          if (action === "resume") { this.archived.delete(id); agent.archived = false; await this.store?.change(() => { this.store!.remove("removal", id); this.store!.put("agent", id, agent); }); }
          const result = await this.dispatch(this.workers.get(agent.machineId), action, { id }); this.changed(); return result;
        } catch (error) {
          if (wasArchived && action === "resume" && !this.online(this.runners.get(id))) {
            this.archived.add(id); Object.assign(agent, { archived: true, online: false, state: "stopped" }); this.agents.set(id, agent);
            await this.store?.change(() => { this.store!.put("removal", id, { kind: "archived", machineId: agent.machineId }); this.store!.put("agent", id, agent); }); this.changed();
          }
          throw error;
        } finally { this.resuming.delete(id); }
      }
      if (action === "dispose" && this.agents.has(id) && !this.online(this.runners.get(id))) {
        await this.forget(id); return { removed: true, offline: true, workspaceRetained: true };
      }
      const result = await this.dispatch(this.runners.get(id), action, { ...(action === "prompt" ? { text: args.text } : {}), ...(action === "room" ? { room: args.room } : {}) });
      if (action === "dispose") await this.forget(id);
      return result;
    }
    throw new Error("Unknown orchestration operation.");
  }
  disconnect(socket: WebSocket): void {
    this.browsers.delete(socket);
    for (const [id, pending] of this.pending) if (pending.socket === socket) { clearTimeout(pending.timer); pending.reject(new Error("Connection lost; control request acceptance is unknown.")); this.pending.delete(id); }
    const peer = this.peers.get(socket); this.peers.delete(socket); if (!peer) return;
    if (peer.kind === "worker" && this.workers.get(peer.id) === peer) {
      this.workers.delete(peer.id); const machine = this.machines.get(peer.id); if (machine) machine.online = false;
    }
    if (peer.kind === "runner" && this.runners.get(peer.id) === peer) {
      this.runners.delete(peer.id); const agent = this.agents.get(peer.id); if (agent) agent.online = false;
    }
    this.changed();
  }
  async close(): Promise<void> { this.updates?.close(); for (const socket of [...this.peers.keys(), ...this.browsers.keys()]) this.disconnect(socket); await this.store?.close(); this.machines.clear(); this.agents.clear(); this.runnerOwners.clear(); this.forgotten.clear(); }
}
