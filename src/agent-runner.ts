import { INSTALL_TIMEOUT_MS } from "./timeouts.js";
import { randomUUID } from "node:crypto";
import { AgentStore, LeaseLost, type SavedAgent } from "./persistence.js";
import { mkdir } from "node:fs/promises";
import { join, resolve, relative } from "node:path";
import spawn from "cross-spawn";
import { RoomClient } from "./room-client.js";
import { formatDelivery } from "./protocol.js";
import { AgentKeys, RoomError, type ConnectionProfile } from "./room-protocol.js";
import { ManagedOmp, type Executable, type OmpHost } from "./managed-omp.js";
import { ManagedTerminal, type ManagedHarness } from "./managed-terminal.js";
import { OutputBuffer, launchSpec, type ControlCommand, type ManagedAgent, type OutputEvent } from "./orchestration-protocol.js";
import { ManagedCodex } from "./managed-codex.js";
import { ManagedClaudeNative } from "./managed-claude-native.js";
import { ManagedClaude } from "./managed-claude.js";
import { terminateTree } from "./process-tree.js";
import { existingFolder } from "./worker-folders.js";

export type RunnerConfig = { profile: ConnectionProfile; id: string; machineId: string; machineName: string; root: string; spec: unknown; omp: Executable; codex?: Executable; claude?: Executable; entry?: string; recover?: boolean };
const errorText = (error: unknown) => (error instanceof Error ? error.message : "Operation failed.").slice(0, 2048);

/** Independent of the worker: owns the harness, room identity, and bounded output. */
export class AgentRunner {
  readonly client: RoomClient;
  readonly output = new OutputBuffer();
  readonly agent: ManagedAgent;
  private driver?: ManagedHarness;
  private sessionFile?: string;
  private timer?: NodeJS.Timeout;
  private flushing = false;
  private events: OutputEvent[] = [];
  private operations = Promise.resolve();
  private inbox = Promise.resolve();
  private inboxSize = 0;
  private roomEpoch = 0;
  private closed = false;
  private desiredRoom: string;
  private readonly directory: string;
  private workspace: string;
  private workspaceReady = false;
  private preparing?: ReturnType<typeof spawn>;
  private published = "";
  private legacyServer = false;
  private stopRequested = false;
  private readonly lease = randomUUID();
  private claimed = false;
  private desired: SavedAgent["desired"] = "running";
  private saved = "";
  private checking = false;
  private lastCheckpoint = 0;
  private lastHeartbeat = 0;
  private recoveryNotice = "";
  private closing?: Promise<void>;
  static async create(config: RunnerConfig): Promise<AgentRunner> {
    const store = await AgentStore.open(config.root, config.profile);
    try {
      const restored = config.recover ? store.get(config.id) : undefined;
      if (restored && (restored.agent.id !== config.id || restored.agent.machineId !== config.machineId)) throw new Error("Saved agent does not belong to this machine.");
      if (config.recover && !restored) throw new Error("This agent has no saved session on this machine.");
      return new AgentRunner(config, store, restored);
    } catch (error) { await store.close(); throw error; }
  }
  constructor(private readonly config: RunnerConfig, private store?: AgentStore, restored?: SavedAgent) {
    const spec = launchSpec(config.spec);
    if (!/^[a-f0-9-]{36}$/.test(config.id)) throw new Error("Invalid runner ID.");
    this.directory = resolve(config.root, config.id);
    if (relative(resolve(config.root), this.directory) !== config.id) throw new Error("Invalid workspace path.");
    this.workspace = restored?.agent.folder ?? spec.folder ?? join(this.directory, spec.repository ? "repo" : "workspace");
    this.desiredRoom = spec.room ?? "";
    const { prompt: _prompt, ...description } = spec;
    this.agent = { ...description, id: config.id, machineId: config.machineId, machineName: config.machineName, room: this.desiredRoom, state: "preparing", online: true, createdAt: Date.now(), canResume: false };
    if (restored) {
      Object.assign(this.agent, restored.agent, { online: true, state: restored.desired === "running" ? "starting" : "stopped", persistent: true, archived: restored.desired === "archived" });
      this.sessionFile = restored.session; this.workspaceReady = restored.workspaceReady; this.desired = restored.desired; this.desiredRoom = restored.agent.room;
    }
    this.agent.persistent = true;
    this.client = new RoomClient(config.profile, spec.name, { keys: new AgentKeys(spec.name, restored?.privateKey), onError: error => this.record("connection", error.message) });
    this.client.onConnected(async () => {
      this.legacyServer = false;
      try {
        try { await this.client.request("control.runner", { agent: this.agent }); }
        catch (error) {
          if (!(error instanceof RoomError) || error.code !== "INVALID_ARGUMENT") throw error;
          if (this.agent.folder) throw new Error("This server must be updated before using agents in existing folders.");
          this.legacyServer = true; await this.client.request("control.runner", { agent: this.wireAgent() });
        }
      }
      catch (error) {
        if (error instanceof RoomError && ["AGENT_FORGOTTEN", "AGENT_ARCHIVED"].includes(error.code)) { this.desired = "archived"; this.agent.archived = true; await this.checkpoint("archived"); await this.close(); }
        throw error;
      }
    });
    this.client.onEvent((event, data) => { if (event === "control.command") this.command(data); });
    this.client.onMessage(message => this.deliver(formatDelivery({ messageId: message.id, channelId: message.roomId, sender: message.sender, senderAccountId: message.sender.id,
      text: message.text, createdAt: message.createdAt, attachments: [], verified: true }), message.roomId));
    this.client.onPresence(event => this.deliver(formatDelivery({ messageId: event.id, channelId: event.roomId, sender: event.participant, senderAccountId: event.participant.id,
      presence: event.kind, text: "", createdAt: event.createdAt, attachments: [] }), event.roomId));
  }
  private record(kind: string, text: string): void {
    if (!text) return;
    const event = this.output.append(kind, text); this.events.push(event);
    if (this.events.length > 1000) this.events.shift();
  }
  private state(state: ManagedAgent["state"], error?: unknown): void {
    this.agent.state = state; this.agent.error = error === undefined ? undefined : errorText(error);
    this.record("state", error ? `${state}: ${this.agent.error}` : state);
  }
  private wireAgent(): ManagedAgent {
    if (!this.legacyServer) return this.agent;
    const { persistent: _persistent, archived: _archived, identityId: _identity, ...agent } = this.agent; return agent;
  }
  private snapshot(): SavedAgent {
    return { agent: { ...this.agent, online: false, identityId: this.client.identity.id }, session: this.driver?.sessionFile ?? this.sessionFile, workspaceReady: this.workspaceReady,
      privateKey: this.client.keys.exportPrivateKey(), desired: this.desired, updatedAt: Date.now() };
  }
  private async checkpoint(desired?: SavedAgent["desired"]): Promise<void> {
    if (!this.store || !this.claimed) return;
    const record = this.snapshot(), signature = JSON.stringify({ ...record, updatedAt: 0 });
    if (desired !== undefined || signature !== this.saved) { await this.store.checkpoint(record, this.lease, desired); this.saved = signature; }
  }
  private async check(): Promise<void> {
    if (this.checking || this.closed || Date.now() - this.lastCheckpoint < 1000) return;
    this.checking = true; this.lastCheckpoint = Date.now();
    try {
      await this.checkpoint();
      if (Date.now() - this.lastHeartbeat > 5000) { this.lastHeartbeat = Date.now(); await this.store?.heartbeat(this.agent.id, this.lease); }
      if (this.closed) return;
      const desired = this.store?.get(this.agent.id)?.desired;
      if (desired && desired !== this.desired && desired !== "running") {
        this.desired = desired; this.stopRequested = true;
        if (this.preparing) terminateTree(this.preparing);
        if (this.agent.state === "starting") void this.driver?.stop();
        this.operations = this.operations.then(() => this.action(desired === "archived" ? "archive" : "stop", {})).then(() => {}, error => this.record("error", errorText(error)));
      }
    } catch (error) { this.record("error", `Could not save session recovery metadata: ${errorText(error)}`); if (error instanceof LeaseLost) await this.close().catch(() => {}); }
    finally { this.checking = false; }
  }
  private async flush(): Promise<void> {
    if (this.closed || this.flushing || this.client.state !== "on") return;
    const status = JSON.stringify(this.agent);
    if (!this.events.length && status === this.published) return;
    this.flushing = true;
    const batch = this.events.splice(0, 20);
    try { await this.client.request("control.publish", { agent: this.wireAgent(), events: batch }); this.published = status; }
    catch { /* Ring buffer remains authoritative. Do not replay uncertain live packets. */ }
    finally { this.flushing = false; }
  }
  private async publishState(): Promise<void> {
    if (this.closed || this.client.state !== "on") return;
    try { await this.client.request("control.publish", { agent: this.wireAgent(), events: [] }); }
    catch { /* The local record is durable; registration/inventory reconciles after an outage. */ }
  }
  private command(command: ControlCommand): void {
    if (["stop", "archive"].includes(command.method)) {
      this.stopRequested = true;
      if (this.preparing) terminateTree(this.preparing);
      if (this.agent.state === "starting") void this.driver?.stop();
    }
    // Log reads never wait for clone/start operations; the panel stays inspectable during startup.
    const handle = command.method === "logs" ? Promise.resolve(this.output.snapshot()) : this.operations.then(() => this.action(command.method, command.params));
    if (command.method !== "logs") this.operations = handle.then(() => {}, () => {});
    void handle.then(result => this.client.request("control.reply", { id: command.id, result })).catch(async error => {
      await this.client.request("control.reply", { id: command.id, error: errorText(error) }).catch(() => {});
    });
  }
  private deliver(text: string, roomId: string): void {
    if (this.agent.state === "stopped" || this.closed) return;
    if (this.inboxSize >= 100) { this.record("error", "Room delivery backlog is full; inspect room history for missed messages."); return; }
    const epoch = this.roomEpoch; this.inboxSize++;
    this.inbox = this.inbox.then(async () => {
      if (this.closed || epoch !== this.roomEpoch || this.client.room?.id !== roomId || !this.driver) return;
      this.record("room", text); const input = this.recoveryInput(text); if (this.driver.deliver) await this.driver.deliver(input); else await this.driver.prompt(input);
    }).catch(error => this.record("error", errorText(error))).finally(() => { this.inboxSize--; });
  }
  async start(): Promise<void> {
    this.store ??= await AgentStore.open(this.config.root, this.config.profile);
    await this.store.claim(this.snapshot(), this.lease, !!this.config.recover); this.claimed = true;
    await this.client.connect();
    this.timer = setInterval(() => { void this.flush(); void this.check(); }, 200);
    // The runner registers before cloning, so a failed clone is visible and never creates an orphan.
    this.operations = (this.config.recover ? this.restore() : this.launch()).catch(async error => {
      if (!this.stopRequested && !this.closed) {
        this.state("failed", error); this.desired = "stopped";
        await this.driver?.stop().catch(stopError => this.record("error", errorText(stopError)));
        await this.checkpoint("stopped").catch(saveError => this.record("error", errorText(saveError)));
        await this.publishState();
      }
    });
  }
  private async restore(): Promise<void> {
    if (this.desired !== "running") { this.state("stopped"); await this.checkpoint(); return; }
    if (!this.workspaceReady) throw new Error("Workspace setup did not complete. Launch a new agent; the existing files were preserved.");
    await this.startHarness(); if (this.desiredRoom) await this.changeRoom(this.desiredRoom);
    this.record("state", "Restored the saved harness session. Room messages sent while offline may have been missed.");
    // This is recovery context, never a replay of the original task or a room history.
    this.recoveryNotice = "Sideband restored this saved session after its controller restarted. An earlier turn may have been interrupted; room messages sent while offline may have been missed. Check the existing session before repeating work.";

  }
  private recoveryInput(text: string): string { const notice = this.recoveryNotice; this.recoveryNotice = ""; return notice ? `${notice}\n\n${text}` : text; }
  private async git(args: string[]): Promise<void> {
    await new Promise<void>((resolvePromise, reject) => {
      const child = spawn("git", args, { cwd: this.directory, windowsHide: true, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never", GIT_SSH_COMMAND: "ssh -oBatchMode=yes" } });
      this.preparing = child;
      child.stdout?.setEncoding("utf8"); child.stderr?.setEncoding("utf8");
      child.stdout?.on("data", chunk => this.record("git", String(chunk))); child.stderr?.on("data", chunk => this.record("git", String(chunk)));
      const timer = setTimeout(() => { terminateTree(child); reject(new Error("Repository operation timed out.")); }, INSTALL_TIMEOUT_MS);
      child.once("error", error => { clearTimeout(timer); reject(error); });
      child.once("close", code => { clearTimeout(timer); this.preparing = undefined; code === 0 ? resolvePromise() : reject(new Error(`Git exited (${code}). Check the repository URL and this machine's Git credentials.`)); });
    });
  }
  private async launch(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    if (this.agent.folder) {
      this.workspace = await existingFolder(this.agent.folder, true); this.agent.folder = this.workspace;
      this.record("state", `Using existing folder: ${this.workspace}`);
    } else if (this.agent.repository) {
      this.record("git", `Cloning ${this.agent.repository}`);
      await this.git(["clone", "--", this.agent.repository, "repo"]);
    } else {
      this.record("state", "Creating an empty workspace");
      await mkdir(this.workspace, { recursive: true, mode: 0o700 });
    }
    if (this.closed || this.stopRequested) return;
    if (this.agent.ref) await this.git(["-C", "repo", "checkout", "--detach", this.agent.ref]);
    this.workspaceReady = true;
    this.agent.canResume = true;
    await this.checkpoint();
    await this.startHarness();
    if (this.closed || this.stopRequested) return;
    if (this.desiredRoom) await this.changeRoom(this.desiredRoom);
    const prompt = launchSpec(this.config.spec).prompt;
    if (prompt) { if (!this.agent.terminal) this.record("user", prompt); await this.driver!.prompt(prompt); }
  }
  private async tool(name: string, args: unknown): Promise<unknown> {
    if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("Invalid tool arguments.");
    if (name === "sideband_room_send") {
      const value = (args as { text?: unknown }).text;
      if (typeof value !== "string" || !value.trim()) throw new Error("A message is required.");
      return this.client.send(value);
    }
    if (name === "sideband_room_status") return { identity: this.client.identity, room: this.client.room, state: this.client.state };
    if (name === "sideband_room_members") return this.client.members();
    if (name === "sideband_room_history") return this.client.history();
    throw new Error("Unknown managed room tool.");
  }
  private async startHarness(): Promise<void> {
    if (this.closed || this.stopRequested) throw new Error("Runner is stopped.");
    if (this.agent.folder) this.workspace = await existingFolder(this.agent.folder, true);
    this.state("starting");
    const host: OmpHost = {
      event: (kind, text) => this.record(kind, text), state: state => { if (this.driver === driver && !this.closed && !this.stopRequested) this.agent.state = state; },
      exit: error => {
        if (this.driver !== driver || this.closed || this.stopRequested) return;
        this.sessionFile = driver.sessionFile ?? this.sessionFile;
        this.state(this.agent.terminal ? "stopped" : "failed", error); this.desired = "stopped"; void this.checkpoint("stopped").catch(error => this.record("error", errorText(error))); ++this.roomEpoch;
        if (this.agent.terminal && this.client.room) void this.client.leaveRoom().catch(() => {});
      },
      tool: (name, args) => this.tool(name, args),
    };
    const entry = this.config.entry ?? resolve(process.argv[1]!);
    const sessions = join(this.directory, "sessions");
    const driver: ManagedHarness = this.agent.harness === "codex"
      ? new ManagedCodex(this.config.codex ?? { command: process.env.CODEX_BIN ?? "codex" }, this.workspace, sessions, host, entry, this.agent.terminal)
      : this.agent.harness === "claude"
      ? this.agent.terminal ? new ManagedClaudeNative(this.config.claude ?? { command: "claude" }, this.workspace, sessions, host, entry) : new ManagedClaude(this.config.claude ?? { command: "claude" }, this.workspace, sessions, host, entry)
      : this.agent.terminal ? new ManagedTerminal(this.config.omp, this.workspace, sessions, host, entry)
      : new ManagedOmp(this.config.omp, this.workspace, sessions, host);
    this.driver = driver;
    try { await driver.start({ model: this.agent.model, effort: this.agent.effort, resume: this.sessionFile }); }
    catch (error) { await driver.stop().catch(() => {}); if (!this.closed && !this.stopRequested) this.state("failed", error); throw error; }
    this.sessionFile = driver.sessionFile;
    await this.checkpoint();
    if (!this.closed && !this.stopRequested && this.agent.state === "starting") this.state("idle");
    await this.publishState();
  }
  private async changeRoom(room: string): Promise<void> {
    ++this.roomEpoch;
    if (room) { const joined = await this.client.joinRoom(room); this.desiredRoom = joined.name; }
    else { if (this.client.room) await this.client.leaveRoom(); this.desiredRoom = ""; }
    this.agent.room = this.desiredRoom;
    this.record("state", this.desiredRoom ? `Joined room ${this.desiredRoom}` : "Left room");
    await this.checkpoint();
    await this.publishState();
  }
  private async action(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (this.closed) throw new Error("Runner is closed.");
    switch (method) {
      case "prompt": {
        if (!this.driver || !["idle", "busy"].includes(this.agent.state)) throw new Error("Resume the agent before sending instructions.");
        const text = params.text; if (typeof text !== "string" || !text.trim() || text.length > 16000) throw new Error("Invalid instructions.");
        if (!this.agent.terminal) this.record("user", text); await this.driver.prompt(this.recoveryInput(text)); return { accepted: true };
      }
      case "interrupt": if (!this.driver) throw new Error("Agent is not running."); await this.driver.interrupt(); return { interrupted: true };
      case "room": if (typeof params.room !== "string" || params.room.length > 100) throw new Error("Invalid room."); await this.changeRoom(params.room); return { room: this.agent.room };
      case "stop": {
        this.desired = this.agent.archived ? "archived" : "stopped";
        // A storage failure must never prevent a requested stop from reaching the harness.
        await this.checkpoint(this.desired).catch(error => this.record("error", errorText(error)));
        if (this.agent.state === "stopped") return { stopped: true };
        this.state("stopped"); ++this.roomEpoch;
        if (this.driver) { this.sessionFile = this.driver.sessionFile ?? this.sessionFile; await this.driver.stop(); this.driver = undefined; }
        if (this.client.room) await this.client.leaveRoom();
        await this.checkpoint(this.desired); await this.publishState(); return { stopped: true };
      }
      case "resume": {
        if (!["stopped", "failed"].includes(this.agent.state) || !this.workspaceReady) throw new Error("This agent cannot be resumed.");
        if (this.driver) await this.driver.stop();
        this.stopRequested = false; this.desired = "running"; this.agent.archived = false; await this.store?.desired(this.agent.id, "running");
        await this.startHarness(); if (this.desiredRoom) await this.changeRoom(this.desiredRoom); return { resumed: true };
      }
      case "archive": {
        this.desired = "archived"; this.agent.archived = true;
        await this.action("stop", {}); await this.checkpoint("archived");
        setTimeout(() => { void this.close(); }, 100); return { archived: true, workspaceRetained: true };
      }
      case "dispose": {
        if (this.agent.state !== "stopped" && this.agent.state !== "failed") throw new Error("Stop the agent before removing its runner.");
        // Preserve checkout/history. Reclaiming disk is a separate, explicit workspace operation.
        this.desired = "archived"; this.agent.archived = true; await this.checkpoint("archived");
        setTimeout(() => { void this.close(); }, 100); return { removed: true, workspaceRetained: true };
      }
      default: throw new Error("Unknown runner operation.");
    }
  }
  close(): Promise<void> { return this.closing ??= this.shutdown(); }
  private async shutdown(): Promise<void> {
    if (this.closed) return; this.closed = true; if (this.timer) clearInterval(this.timer);
    ++this.roomEpoch; if (this.preparing) terminateTree(this.preparing);
    try { await this.driver?.stop(); await this.checkpoint(); }
    finally {
      await this.client.close();
      try { if (this.claimed) await this.store?.release(this.agent.id, this.lease); } finally { await this.store?.close(); }
    }
  }
}

/** Private CLI entry: bootstrap travels through stdin, never command arguments or disk. */
export async function runAgentRunner(): Promise<void> {
  let input = "";
  for await (const chunk of process.stdin) { input += chunk.toString(); if (Buffer.byteLength(input) > 64 * 1024) throw new Error("Runner bootstrap is too large."); }
  let runner: AgentRunner | undefined;
  try {
    runner = await AgentRunner.create(JSON.parse(input));
    process.once("SIGINT", () => { void runner?.close(); }); process.once("SIGTERM", () => { void runner?.close(); });
    await runner.start(); process.send?.({ type: "runner.ready" });
  } catch (error) {
    process.send?.({ type: "runner.error", error: errorText(error) });
    await runner?.close(); throw error;
  }
}
