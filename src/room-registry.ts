import type { ConnectionProfile } from "./room-protocol.js";
import { RoomSession } from "./room-session.js";

export type Harness = "codex" | "claude";
export function callerKey(harness: Harness, meta?: Record<string, unknown>): string {
  if (harness === "claude") return "claude-process";
  const id = meta?.threadId;
  if (typeof id !== "string" || !id.trim()) throw new Error("Codex did not supply _meta.threadId; cannot safely bind the calling session. Upgrade Codex.");
  return id;
}
export class RoomRegistry {
  private readonly sessions = new Map<string, RoomSession>();
  private readonly pending = new Map<string, Promise<RoomSession>>();
  private closing = false;
  constructor(private readonly create: (key: string, profile: ConnectionProfile, name?: string) => Promise<RoomSession>) {}
  status(key: string): object { return this.sessions.get(key)?.status() ?? { state: this.pending.has(key) ? "connecting" : "off" }; }
  get(key: string): RoomSession {
    const session = this.sessions.get(key); if (!session) throw new Error("Messaging is off for this session. Activate first."); return session;
  }
  async activate(key: string, profile: ConnectionProfile, name?: string): Promise<RoomSession> {
    if (this.closing || this.sessions.has(key) || this.pending.has(key)) throw new Error("This session is already active/connecting or shutting down.");
    const pending = (async () => {
      const session = await this.create(key, profile, name);
      try {
        if (this.closing) throw new Error("Activation cancelled.");
        await session.enable();
        if (this.closing) throw new Error("Activation cancelled.");
        this.sessions.set(key, session); return session;
      } catch (error) { await session.disable(); throw error; }
    })();
    this.pending.set(key, pending);
    try { return await pending; } finally { this.pending.delete(key); }
  }
  async deactivate(key: string): Promise<void> {
    await this.pending.get(key)?.catch(() => {});
    const session = this.sessions.get(key); this.sessions.delete(key); await session?.disable();
  }
  async close(): Promise<void> {
    this.closing = true; await Promise.allSettled(this.pending.values());
    await Promise.allSettled([...this.sessions.values()].map((session) => session.disable())); this.sessions.clear();
  }
}
