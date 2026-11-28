import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { Registry, LeaseLost, leaseIsLive, processStamp, type Lease } from "./persistence.js";
import { RoomTools, roomArguments, toolError, type ToolResult } from "./room-tools.js";
import { RoomProfiles } from "./room-profiles.js";
import { RoomSession } from "./room-session.js";
import { AgentKeys, parsePassword, type ConnectionProfile } from "./room-protocol.js";
import { CodexAdapter, type DeliveryAdapter } from "./adapters/codex.js";
import { CodexRpc } from "./rpc.js";
import type { RpcConnection } from "./rpc.js";

type Membership = { name: string; profile: string; server: string; fingerprint: string; privateKey: string; room?: string; roomId?: string };
type Options = { loaded?(): Promise<string[]>; adapter?(thread: string): Promise<DeliveryAdapter>; report?(message: string): void; presence?(threads: { id: string; cwd?: string; name?: string; identityId?: string }[]): void };

/** Durable opt-in per exact host-provided thread ID. No workspace fallback or thread/resume. */
export class CodexMembership {
  readonly tools: RoomTools;
  private readonly owner = randomUUID();
  private readonly owned = new Set<string>();
  private readonly queues = new Map<string, Promise<unknown>>();
  private stamp?: Promise<string | undefined>;
  private timer?: NodeJS.Timeout;
  private sweep?: Promise<void>;
  private monitor?: RpcConnection;
  private closing = false;
  private errors = new Map<string, string>();
  private monitorError = "";
  private beating?: Promise<void>;
  private metadata?: Promise<void>;
  private loaded = new Set<string>();
  private workspaces = new Map<string, string>();
  private constructor(private readonly db: Registry, private readonly profiles: RoomProfiles, private readonly options: Options) {
    this.tools = new RoomTools(async (key, profile, name) => {
      await this.claim(key);
      const saved = db.get<Membership>("membership", key);
      const same = saved && saved.name === name && saved.server === profile.server && saved.fingerprint === parsePassword(profile.password).fingerprint;
      const adapter = await (options.adapter?.(key) ?? CodexRpc.connect().then(rpc => new CodexAdapter(rpc, key)));
      try {
        const session = new RoomSession(profile, adapter, name, new AgentKeys(name, same ? saved.privateKey : undefined));
        const changed = () => { void this.serial(key, () => this.saveNames(key)).catch(error => options.report?.(`Sideband room metadata: ${error.message}`)); };
        session.client.onPresence(event => { if (event.kind === "renamed") changed(); });
        session.client.onEvent(event => { if (event === "identity.changed") changed(); });
        return session;
      }
      catch (error) { await adapter.close(); throw error; }
    }, profiles);
  }
  static async open(profiles = new RoomProfiles(), options: Options = {}): Promise<CodexMembership> {
    return new CodexMembership(await Registry.open(join(profiles.directory, "codex-memberships.sqlite"), "codex"), profiles, options);
  }
  start(): void {
    const tick = () => { void this.heartbeatOwned().catch(() => {}); void this.reconcile().catch(() => {}); };
    tick(); this.timer = setInterval(tick, 10000); this.timer.unref();
  }
  private heartbeatOwned(): Promise<void> {
    if (this.closing || !this.owned.size) return Promise.resolve(); if (this.beating) return this.beating;
    this.beating = this.db.change(() => {
      for (const key of this.owned) { const lease = this.db.get<Lease>("lease", key); if (lease?.owner === this.owner) this.db.put("lease", key, { ...lease, at: Date.now() }); }
    }).finally(() => { this.beating = undefined; }); return this.beating;
  }
  private serial<T>(key: string, task: () => Promise<T>): Promise<T> {
    const pending = (this.queues.get(key) ?? Promise.resolve()).catch(() => {}).then(task);
    this.queues.set(key, pending); void pending.finally(() => { if (this.queues.get(key) === pending) this.queues.delete(key); }).catch(() => {}); return pending;
  }
  private async claim(key: string): Promise<void> {
    if (this.closing) throw new Error("Sideband is shutting down.");
    if (this.owned.has(key)) { await this.heartbeat(key); return; }
    const previous = this.db.get<Lease>("lease", key), alive = await leaseIsLive(previous), started = await (this.stamp ??= processStamp(process.pid));
    await this.db.change(() => {
      if (this.closing) throw new Error("Sideband is shutting down.");
      if (alive || JSON.stringify(previous) !== JSON.stringify(this.db.get<Lease>("lease", key))) throw new Error("Another Sideband process owns this Codex thread. Wait for it to reconnect.");
      this.db.put("lease", key, { owner: this.owner, pid: process.pid, started: started ?? "", at: Date.now() }); this.owned.add(key);
    });
  }
  private async heartbeat(key: string): Promise<void> {
    await this.db.change(() => {
      const lease = this.db.get<Lease>("lease", key); if (lease?.owner !== this.owner) throw new LeaseLost();
      this.db.put("lease", key, { ...lease, at: Date.now() });
    });
  }
  private async release(key: string): Promise<void> {
    await this.tools.disconnect(key); await this.db.change(() => { if (this.db.get<Lease>("lease", key)?.owner === this.owner) this.db.remove("lease", key); }); this.owned.delete(key);
  }
  private async saveNames(key: string): Promise<void> {
    const connection = this.tools.connection(key); if (!connection || this.closing) return;
    const client = connection.session.client;
    await this.db.change(() => {
      const saved = this.db.get<Membership>("membership", key);
      if (saved) this.db.put("membership", key, { ...saved, name: client.identity.name, ...(client.room ? { room: client.room.name, roomId: client.room.id } : {}) });
    }); this.reportPresence();
  }
  private async restore(key: string): Promise<void> {
    const saved = this.db.get<Membership>("membership", key); if (!saved?.room || this.tools.connection(key)) return;
    const profile = await this.profiles.load(saved.profile);
    if (profile.server !== saved.server || parsePassword(profile.password).fingerprint !== saved.fingerprint) throw new Error("Saved Sideband server identity changed. Join explicitly to choose the new server.");
    const result = await this.tools.call(key, "sideband_rooms", { profile: saved.profile, name: saved.name });
    if (result.isError) throw new Error(result.content[0]?.text ?? "Room recovery failed.");
    await this.tools.connection(key)!.session.client.joinRoom(saved.roomId ?? saved.room, saved.room);
    await this.saveNames(key);
  }
  call(key: string, name: string, input: unknown): Promise<ToolResult> {
    return this.serial(key, async () => {
      try {
        if (this.closing) throw new Error("Sideband is shutting down.");
        const args = roomArguments(name, input);
        if (name === "sideband_deactivate" || name === "sideband_leave_room") {
          // Persist explicit stop intent before any network operation; process exit is different.
          await this.claim(key);
          await this.db.change(() => {
            if (name === "sideband_deactivate") this.db.remove("membership", key);
            else { const saved = this.db.get<Membership>("membership", key); if (saved) { delete saved.room; delete saved.roomId; this.db.put("membership", key, saved); } }
          });
        } else if (!["sideband_join_room", "sideband_profiles", "sideband_setup"].includes(name)) await this.restore(key);
        const result = await this.tools.call(key, name, args);
        const connected = this.tools.connection(key);
        if (!result.isError && connected && ["sideband_join_room", "sideband_rooms"].includes(name)) {
          const profile = await this.profiles.load(connected.profile), client = connected.session.client;
          await this.heartbeat(key);
          await this.db.change(() => this.db.put("membership", key, { name: client.identity.name, profile: connected.profile, server: profile.server, fingerprint: parsePassword(profile.password).fingerprint,
            privateKey: client.keys.exportPrivateKey(), ...(client.room ? { room: client.room.name, roomId: client.room.id } : {}) }));
        }
        if (!result.isError && name === "sideband_deactivate") await this.release(key);
        return result;
      } catch (error) { return toolError(error); }
    });
  }
  reconcile(): Promise<void> {
    if (this.closing) return Promise.resolve(); if (this.sweep) return this.sweep;
    this.sweep = (async () => {
      const recovering = this.db.all<Membership>("membership").some(([, row]) => row.room) || this.owned.size > 0;
      if (!this.options.presence && !recovering) return;
      let loaded: Set<string>;
      try { loaded = new Set(await this.loadedThreads()); this.monitorError = ""; }
      catch (error) {
        this.loaded.clear();
        this.options.presence?.([]);
        const message = error instanceof Error ? error.message : "Cannot inspect loaded Codex threads.";
        if (!this.closing && message !== this.monitorError) { this.monitorError = message; this.options.report?.(recovering ? `Sideband room recovery: ${message}` : "Sideband session discovery: Could not inspect loaded Codex sessions."); }
        await this.heartbeatOwned().catch(() => {});
        return;
      }
      if (this.options.presence) {
        this.loaded = new Set([...loaded].slice(0, 128));
        for (const id of this.workspaces.keys()) if (!this.loaded.has(id)) this.workspaces.delete(id);
        this.reportPresence();
        this.refreshMetadata();
      }
      const keys = new Set([...this.owned, ...this.db.all<Membership>("membership").filter(([, row]) => row.room).map(([id]) => id)]);
      await Promise.allSettled([...keys].map(key => this.serial(key, async () => {
        if (this.closing) return;
        try {
          if (!loaded.has(key)) { if (this.owned.has(key)) await this.release(key); return; }
          if (this.owned.has(key)) {
            await this.heartbeat(key);
            const connected = this.tools.connection(key);
            if (connected) try { await connected.session.adapter.prepare(); } catch { await this.tools.disconnect(key); }
          }
          await this.restore(key); this.errors.delete(key);
        } catch (error) {
          if (error instanceof LeaseLost) { await this.tools.disconnect(key); this.owned.delete(key); }
          const message = error instanceof Error ? error.message : "Recovery failed.";
          if (this.errors.get(key) !== message) { this.errors.set(key, message); this.options.report?.(`Sideband room recovery: ${message}`); }
        }
      })));
    })().finally(() => { this.sweep = undefined; }); return this.sweep;
  }
  private reportPresence(): void {
    if (!this.closing) this.options.presence?.([...this.loaded].map(id => ({ id, cwd: this.workspaces.get(id), name: this.tools.connection(id)?.session.client.identity.name, identityId: this.tools.connection(id)?.session.client.identity.id })));
  }
  private refreshMetadata(): void {
    const monitor = this.monitor;
    if (!monitor || this.metadata || this.closing) return;
    this.metadata = (async () => {
      const ids = [...this.loaded].filter(id => !this.workspaces.has(id));
      // Optional metadata cannot hold up room recovery or lease renewal.
      for (let offset = 0; offset < ids.length && !this.closing; offset += 4) await Promise.all(ids.slice(offset, offset + 4).map(async id => {
        try {
          const value = await monitor.request<{ thread: { cwd?: string } }>("thread/read", { threadId: id, includeTurns: false });
          if (this.loaded.has(id) && typeof value.thread?.cwd === "string") this.workspaces.set(id, value.thread.cwd);
        } catch { /* It may have unloaded. Only the latest loaded list is authoritative. */ }
      }));
      this.reportPresence();
    })().catch(() => {}).finally(() => { this.metadata = undefined; });
  }
  private async loadedThreads(): Promise<string[]> {
    if (this.options.loaded) return this.options.loaded();
    try { this.monitor ??= await CodexRpc.connect(); return (await this.monitor.request<{ data: string[] }>("thread/loaded/list")).data; }
    catch (error) { await this.monitor?.close(); this.monitor = undefined; throw error; }
  }
  private async closeMonitor(): Promise<void> { const monitor = this.monitor; this.monitor = undefined; await monitor?.close(); }
  async close(): Promise<void> {
    this.closing = true; if (this.timer) clearInterval(this.timer);
    await this.closeMonitor();
    await this.sweep?.catch(() => {}); await this.metadata; await this.beating?.catch(() => {}); await Promise.allSettled(this.queues.values()); await this.tools.close();
    for (const key of [...this.owned]) await this.release(key);
    await this.closeMonitor(); await this.db.close();
  }
}
