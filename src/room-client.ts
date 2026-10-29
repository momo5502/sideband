import { createHash, randomUUID } from "node:crypto";
import type { TLSSocket } from "node:tls";
import { Agent as HttpsAgent } from "node:https";
import WebSocket from "ws";
import { roomProxyAgent, roomProxyUrl } from "./room-proxy.js";
import { AgentKeys, RoomError, VERSION, loginProof, messageProof, parsePassword, serverUrl, verifyMessage,
  validPresence, type PresenceEvent, type ConnectionProfile, type Login, type Room, type SignedMessage, type AgentIdentity } from "./room-protocol.js";

export class RoomClient {
  readonly keys: AgentKeys;
  room: Room | null = null;
  state: "off" | "connecting" | "on" | "reconnecting" | "disconnected" = "off";
  lastError?: string;
  private socket?: WebSocket;
  private reconnectTimer?: NodeJS.Timeout;
  private watchdog?: NodeJS.Timeout;
  private wanted = false;
  private attempts = 0;
  private generation = 0;
  private desiredRoom: Room | null = null;
  private leaveRequested = false;
  private readonly pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private readonly listeners = new Set<(message: SignedMessage) => void>();
  private readonly presenceListeners = new Set<(event: PresenceEvent) => void>();
  private readonly seen = new Set<string>();
  private readonly endpoint: string;
  constructor(private readonly profile: ConnectionProfile, name?: string, private readonly options: { reconnectMs?: number; heartbeatTimeoutMs?: number; onError?: (error: Error) => void; proxyEnv?: NodeJS.ProcessEnv } = {}) {
    this.endpoint = serverUrl(profile.server); parsePassword(profile.password); this.keys = new AgentKeys(name);
  }
  get identity(): AgentIdentity { return this.keys.identity; }
  onMessage(listener: (message: SignedMessage) => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  onPresence(listener: (event: PresenceEvent) => void): () => void { this.presenceListeners.add(listener); return () => { this.presenceListeners.delete(listener); }; }
  private remember(key: string): boolean {
    if (this.seen.has(key)) return false;
    this.seen.add(key);
    if (this.seen.size > 10_000) this.seen.delete(this.seen.values().next().value!);
    return true;
  }
  private error(error: unknown): void {
    const normalized = error instanceof Error ? error : new Error("Connection failed.");
    this.lastError = normalized.message; this.options.onError?.(normalized);
  }
  async connect(): Promise<void> {
    if (this.wanted) throw new Error("Already connected or connecting.");
    this.wanted = true; this.state = "connecting";
    const generation = ++this.generation;
    try { await this.open(generation); }
    catch (error) { if (generation === this.generation) { this.wanted = false; this.state = "off"; this.socket?.terminate(); } throw error; }
  }
  private async open(generation: number): Promise<void> {
    const { secret, fingerprint } = parsePassword(this.profile.password);
    const proxy = roomProxyUrl(this.endpoint, this.options.proxyEnv);
    const connection = new AbortController();
    const agent = proxy ? roomProxyAgent(proxy, connection.signal) : new HttpsAgent({ keepAlive: false });
    let fatal: Error | undefined;
    agent.on("proxyConnect", (response: { statusCode: number }) => {
      if (response.statusCode === 200) return;
      fatal = response.statusCode === 407
        ? new RoomError("PROXY_AUTH", "HTTP proxy authentication failed (407). Check the proxy credentials outside agent chat.")
        : new RoomError("PROXY_CONNECT", `HTTP proxy refused CONNECT (${response.statusCode}). Check whether it allows access to the Sideband server port.`);
    });
    const socket = new WebSocket(this.endpoint, {
      // This isn't unverified TLS: the exact SHA-256 certificate pin is verified below,
      // before any password, public identity or message is sent.
      rejectUnauthorized: false, handshakeTimeout: proxy ? 10_000 : 5000, maxPayload: 1024 * 1024, perMessageDeflate: false, followRedirects: false,
      // Explicitly bypass Node's global proxy agent when NO_PROXY (or no proxy) selects direct access.
      agent,
    });
    this.socket = socket;
    let pinned = false;
    let authenticated = false;
    let ready = false;
    const assertCurrent = () => {
      if (generation !== this.generation || !this.wanted || this.socket !== socket || socket.readyState !== WebSocket.OPEN) throw new Error("Connection cancelled.");
    };
    const resetWatchdog = () => {
      if (this.socket !== socket || generation !== this.generation || !this.wanted) return;
      if (this.watchdog) clearTimeout(this.watchdog);
      this.watchdog = setTimeout(() => socket.terminate(), this.options.heartbeatTimeoutMs ?? 45_000); this.watchdog.unref();
    };
    socket.on("upgrade", (response) => {
      const raw = (response.socket as TLSSocket).getPeerCertificate().raw;
      pinned = !!raw && createHash("sha256").update(raw).digest("base64url") === fingerprint;
      if (!pinned) { fatal = new RoomError("SERVER_IDENTITY", "Server certificate does not match the password. Credentials may have been rotated, or the address is wrong. Reconfigure; do not bypass verification."); socket.terminate(); }
    });
    socket.on("message", (raw) => {
      if (this.socket !== socket) return;
      try {
        const packet = JSON.parse(raw.toString());
        if (packet.v !== VERSION) throw new Error("Unsupported server protocol.");
        if (typeof packet.id === "string") {
          const pending = this.pending.get(packet.id);
          if (!pending) return;
          clearTimeout(pending.timer); this.pending.delete(packet.id);
          if (packet.error) pending.reject(new RoomError(packet.error.code, packet.error.message)); else pending.resolve(packet.result);
          return;
        }
        if (generation !== this.generation || !this.wanted) return;
        if (packet.event === "message") {
          if (!authenticated || !verifyMessage(packet.data)) throw new Error("Rejected a message with invalid identity/signature.");
          const message: SignedMessage = packet.data;
          if (message.roomId !== this.room?.id || message.sender.id === this.identity.id || !this.remember(`${message.roomId}:${message.id}`)) return;
          for (const listener of this.listeners) listener(message);
        }
        if (packet.event === "presence") {
          if (!authenticated || !validPresence(packet.data)) throw new Error("Rejected an invalid presence event.");
          const event: PresenceEvent = packet.data;
          if (event.roomId !== this.room?.id || event.participant.id === this.identity.id || !this.remember(`presence:${event.roomId}:${event.id}`)) return;
          for (const listener of this.presenceListeners) listener(event);
        }
      } catch (error) { this.error(error); }
    });
    socket.on("ping", resetWatchdog);
    socket.on("error", () => {});
    socket.on("close", () => {
      connection.abort(); agent.destroy();
      // A failed attempt can finish closing after its replacement has started.
      if (this.socket !== socket) return;
      if (this.watchdog) clearTimeout(this.watchdog);
      for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error("Connection lost; request acceptance is unknown. Check history before resending.")); }
      this.pending.clear();
      this.socket = undefined;
      // open()'s caller retries failed authentication/restoration, not this close handler.
      if (!ready || generation !== this.generation || !this.wanted) return;
      this.state = "reconnecting"; this.scheduleReconnect();
    });
    try {
      await new Promise<void>((resolve, reject) => {
        socket.once("open", () => pinned ? resolve() : reject(fatal ?? new Error("Server pin was not verified.")));
        socket.once("error", () => reject(fatal ?? new Error(proxy
          ? "Cannot connect through the configured HTTP proxy. Check proxy connectivity, TLS trust, and CONNECT access to the Sideband server port."
          : "Cannot connect to the room server.")));
        socket.once("close", () => reject(fatal ?? new Error("Room server closed the connection.")));
      });
      assertCurrent();
      const { challenge } = await this.request<{ challenge: string }>("hello", { publicKey: this.identity.publicKey, ...(this.identity.name ? { name: this.identity.name } : {}) });
      if (typeof challenge !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(challenge)) throw new Error("Invalid identity challenge.");
      assertCurrent();
      const login = await this.request<Login>("authenticate", { secret, signature: this.keys.sign(loginProof(challenge, fingerprint, this.identity)) });
      if (login.identity.id !== this.identity.id || login.identity.publicKey !== this.identity.publicKey || login.identity.name !== this.identity.name) throw new Error("Server returned an inconsistent agent identity.");
      assertCurrent(); authenticated = true; this.room = login.room;
      if (!this.leaveRequested && !this.room && this.desiredRoom) {
        const restored = await this.restoreRoom(this.desiredRoom, assertCurrent);
        assertCurrent(); this.room = restored;
      }
      if (this.leaveRequested) {
        // Honor both a lost leave request and a leave issued while restoration was in flight.
        if (this.room) { assertCurrent(); await this.request("leave"); assertCurrent(); }
        this.room = null;
      }
      assertCurrent();
      this.desiredRoom = this.room;
      ready = true; this.state = "on"; this.attempts = 0; this.lastError = undefined; resetWatchdog();
    } catch (error) {
      socket.terminate();
      throw fatal ?? error;
    }
  }
  private async restoreRoom(room: Room, assertCurrent: () => void): Promise<Room | null> {
    const join = async (target: string): Promise<Room | null> => { assertCurrent(); if (this.leaveRequested) return null; return this.request<Room>("join", { room: target }); };
    try { return await join(room.id); }
    catch (error) { if (!(error instanceof RoomError) || error.code !== "ROOM_NOT_FOUND") throw error; }
    try { return await join(room.name); }
    catch (error) { if (!(error instanceof RoomError) || error.code !== "ROOM_NOT_FOUND") throw error; }
    // The last disconnected participant may have expired, or the server restarted.
    assertCurrent();
    if (this.leaveRequested) return null;
    try { return await this.request<Room>("create", { name: room.name }); }
    catch (error) {
      if (!(error instanceof RoomError) || error.code !== "ROOM_EXISTS") throw error;
      return join(room.name); // Another reconnecting participant recreated it first.
    }
  }
  private scheduleReconnect(): void {
    const delay = this.options.reconnectMs ?? Math.min(10_000, 250 * 2 ** Math.min(this.attempts++, 6));
    const generation = ++this.generation;
    this.reconnectTimer = setTimeout(async () => {
      if (!this.wanted || generation !== this.generation) return;
      try { await this.open(generation); }
      catch (error) {
        if (generation !== this.generation || !this.wanted) return;
        this.error(error);
        if (generation !== this.generation || !this.wanted) return;
        if (error instanceof RoomError && ["SERVER_IDENTITY", "AUTH_FAILED", "NAME_IN_USE", "PROXY_CONFIG", "PROXY_AUTH"].includes(error.code)) {
          this.wanted = false; this.state = "disconnected"; this.room = null; return;
        }
        if (this.wanted) this.scheduleReconnect();
      }
    }, delay);
    this.reconnectTimer.unref();
  }
  request<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error("Room server is disconnected."));
    const id = randomUUID();
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error("Request timed out; acceptance is unknown. Check history before resending.")); }, 5000);
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject, timer });
      socket.send(JSON.stringify({ v: VERSION, id, method, params }), (error) => {
        if (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
      });
    });
  }
  private requireOn(): void { if (this.state !== "on") throw new Error("Messaging is not connected."); }
  async listRooms(): Promise<Room[]> { this.requireOn(); return this.request("rooms"); }
  async createRoom(name: string): Promise<Room> { this.requireOn(); const room = await this.request<Room>("create", { name }); this.room = this.desiredRoom = room; this.leaveRequested = false; return room; }
  async joinRoom(room: string): Promise<Room> { this.requireOn(); const joined = await this.request<Room>("join", { room }); this.room = this.desiredRoom = joined; this.leaveRequested = false; return joined; }
  async leaveRoom(): Promise<void> {
    if (this.state !== "reconnecting") this.requireOn();
    this.leaveRequested = true; this.desiredRoom = null;
    if (this.state !== "reconnecting") await this.request("leave");
    this.room = null;
  }
  async members(): Promise<AgentIdentity[]> { this.requireOn(); return this.request("members"); }
  async history(limit = 50): Promise<SignedMessage[]> {
    this.requireOn(); const messages = await this.request<SignedMessage[]>("history", { limit });
    if (!Array.isArray(messages) || !messages.every((message) => message.roomId === this.room?.id && verifyMessage(message))) throw new Error("History contains invalid identities or signatures.");
    return messages;
  }
  async send(text: string): Promise<{ messageId: string }> {
    this.requireOn(); if (!this.room) throw new Error("Create or join a room first.");
    const message = { id: randomUUID(), roomId: this.room.id, sender: this.identity, text };
    return this.request("send", { id: message.id, text, signature: this.keys.sign(messageProof(message)) });
  }
  /** Used by transport tests and useful when diagnosing recovery; never polls the inbox. */
  dropConnection(): void { this.socket?.terminate(); }
  async close(): Promise<void> {
    this.wanted = false; ++this.generation;
    this.desiredRoom = null; this.leaveRequested = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.watchdog) clearTimeout(this.watchdog);
    if (this.state === "on") await this.request("logout").catch(() => {});
    this.state = "off"; this.room = null; this.socket?.terminate();
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error("Messaging disabled.")); }
    this.pending.clear();
  }
}
