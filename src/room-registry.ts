import { agentName, type ConnectionProfile } from "./room-protocol.js";
import { RoomSession } from "./room-session.js";

export type Harness = "codex" | "claude";
export function callerKey(harness: Harness, meta?: Record<string, unknown>): string {
  if (harness === "claude") return "claude-process";
  const id = meta?.threadId;
  if (typeof id !== "string" || !id.trim()) throw new Error("Codex did not supply _meta.threadId; cannot safely bind the calling session. Upgrade Codex.");
  return id;
}
export class RoomRegistry {
  private readonly sessions = new Map<string, { session: RoomSession; profile: string }>();
  private readonly pending = new Map<string, Promise<{ session: RoomSession; profile: string }>>();
  private closing = false;
  constructor(private readonly create: (key: string, profile: ConnectionProfile, name?: string) => Promise<RoomSession>) {}
  status(key: string): object { return this.sessions.get(key)?.session.status() ?? { state: this.pending.has(key) ? "connecting" : "off" }; }
  get(key: string): RoomSession {
    const entry = this.sessions.get(key); if (!entry) throw new Error("Messaging is off for this session. Join a room first."); return entry.session;
  }
  async connect(key: string, load: () => Promise<{ name: string; profile: ConnectionProfile }>, profile?: string, name?: string): Promise<RoomSession> {
    if (this.closing) throw new Error("Messaging is shutting down.");
    const requestedName = name === undefined ? undefined : agentName(name);
    let entry = this.sessions.get(key);
    if (!entry) {
      let pending = this.pending.get(key);
      if (!pending) {
        pending = (async () => {
          const selected = await load();
          if (this.closing) throw new Error("Connection cancelled.");
          const session = await this.create(key, selected.profile, requestedName);
          try {
            if (this.closing) throw new Error("Connection cancelled.");
            await session.enable();
            if (this.closing) throw new Error("Connection cancelled.");
            const connected = { session, profile: selected.name };
            this.sessions.set(key, connected); return connected;
          } catch (error) { await session.disable(); throw error; }
        })();
        this.pending.set(key, pending);
      }
      try { entry = await pending; }
      finally { if (this.pending.get(key) === pending) this.pending.delete(key); }
    }
    if (profile !== undefined && profile !== entry.profile) throw new Error("Already connected to a different profile. Disconnect with sideband_deactivate before changing servers.");
    if (name !== undefined && requestedName !== entry.session.client.identity.name) throw new Error("Already connected with a different name. Disconnect with sideband_deactivate before changing identity.");
    return entry.session;
  }
  async deactivate(key: string): Promise<void> {
    await this.pending.get(key)?.catch(() => {});
    const entry = this.sessions.get(key); this.sessions.delete(key); await entry?.session.disable();
  }
  async close(): Promise<void> {
    this.closing = true; await Promise.allSettled(this.pending.values());
    await Promise.allSettled([...this.sessions.values()].map(({ session }) => session.disable())); this.sessions.clear();
  }
}
