import { createServer, type Server as HttpsServer } from "node:https";
import { createHash, randomBytes, randomUUID, timingSafeEqual, X509Certificate } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import type { Duplex } from "node:stream";
import type { TLSSocket } from "node:tls";
import { createServer as createHttpServer, type Server as HttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { statusPage, type PublicStatus } from "./status-page.js";
import { webPage } from "./web-page.js";
import { browserScript } from "./browser-bundle.js";
import { createServerIdentity, loadServerIdentity, saveServerIdentity, type ServerIdentity } from "./server-identity.js";
import {
  VERSION, MAX_TEXT_BYTES, RoomError, agentName, fields, identityFor, loginProof, messageProof, text, validSignature,
  type AgentIdentity, type Room, type SignedMessage, type PresenceKind,
} from "./room-protocol.js";

type Member = { identity: AgentIdentity; roomId?: string; socket?: WebSocket; expiry?: NodeJS.Timeout };
type RoomState = { id: string; name: string; members: Set<string>; history: SignedMessage[] };
type Connection = { alive: boolean; challenge: string; candidate?: AgentIdentity; member?: Member; authTimer: NodeJS.Timeout; tokens: number; lastRefill: number };
export type RoomServerOptions = { host?: string; port?: number; statusPort?: number; graceMs?: number; heartbeatMs?: number; authTimeoutMs?: number; maxClients?: number;
  credentialsFile?: string; rotatePassword?: boolean };

/** Rooms and messages are ephemeral. The CLI supplies a file to persist the server identity. */
export class RoomServer {
  readonly password: string;
  readonly fingerprint: string;
  private readonly secret: Buffer;
  private readonly http: HttpsServer;
  private readonly plainHttp?: HttpServer;
  private readonly ws: WebSocketServer;
  private readonly members = new Map<string, Member>();
  private readonly names = new Map<string, string>();
  private readonly rooms = new Map<string, RoomState>();
  private readonly connections = new Map<WebSocket, Connection>();
  private readonly tcpSockets = new Set<Duplex>();
  private heartbeat?: NodeJS.Timeout;
  private stopping = false;
  private constructor(identity: ServerIdentity, private readonly options: RoomServerOptions) {
    this.fingerprint = createHash("sha256").update(new X509Certificate(identity.certificate).raw).digest("base64url");
    this.secret = createHash("sha256").update(identity.secret).digest();
    // The one copyable password includes the certificate pin. No domain/CA setup or TOFU is needed.
    this.password = `sb1.${this.fingerprint}.${identity.secret}`;
    this.http = createServer({ key: identity.privateKey, cert: identity.certificate, minVersion: "TLSv1.2" }, (req, res) => this.httpRequest(req, res));
    if (options.statusPort !== undefined) {
      this.plainHttp = createHttpServer((req, res) => this.httpRequest(req, res));
      this.plainHttp.on("upgrade", (req, socket, head) => this.upgrade(req, socket, head, false));
    }
    for (const listener of [this.http, this.plainHttp]) if (listener) {
      listener.headersTimeout = 10_000;
      listener.requestTimeout = 10_000;
      listener.maxConnections = (options.maxClients ?? 1024) * 2;
      listener.on("connection", socket => { this.tcpSockets.add(socket); socket.once("close", () => this.tcpSockets.delete(socket)); });
    }
    this.ws = new WebSocketServer({ noServer: true, maxPayload: 32 * 1024, perMessageDeflate: false });
    this.http.on("upgrade", (req, socket, head) => this.upgrade(req, socket, head, true));
  }
  private upgrade(req: IncomingMessage, socket: Duplex, head: Buffer, encrypted: boolean): void {
    // Browser chat is a separate, same-origin endpoint. Native agents still require pinned TLS.
    const browser = req.url === "/browser-ws" && req.headers.origin === `${encrypted ? "https" : "http"}://${req.headers.host}`;
    const native = encrypted && req.url === "/ws" && !req.headers.origin;
    if ((!browser && !native) || this.stopping || this.connections.size >= (this.options.maxClients ?? 1024)) {
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n"); return;
    }
    this.ws.handleUpgrade(req, socket, head, client => this.accept(client));
  }
  static async start(options: RoomServerOptions = {}): Promise<RoomServer> {
    if (options.rotatePassword && !options.credentialsFile) throw new Error("Password rotation requires a credentials file.");
    const existing = options.credentialsFile && !options.rotatePassword ? await loadServerIdentity(options.credentialsFile) : undefined;
    const identity = existing ?? await createServerIdentity();
    const server = new RoomServer(identity, options);
    try {
      for (const [listener, port] of [[server.http, options.port ?? 8765], [server.plainHttp, options.statusPort]] as const) if (listener) {
        await new Promise<void>((resolve, reject) => {
          listener.once("error", reject);
          listener.listen(port, options.host ?? "0.0.0.0", () => { listener.off("error", reject); resolve(); });
        });
      }
    } catch (error) { await server.close(); throw error; }
    // Bind first: a failed second startup must not rotate the credentials of a running server.
    if (options.credentialsFile && !existing) {
      try { await saveServerIdentity(options.credentialsFile, identity, !!options.rotatePassword); }
      catch (error) { await server.close(); throw error; }
    }
    server.heartbeat = setInterval(() => {
      for (const [socket, connection] of server.connections) {
        if (!connection.alive) { socket.terminate(); continue; }
        connection.alive = false; socket.ping();
      }
    }, options.heartbeatMs ?? 15_000);
    server.heartbeat.unref();
    return server;
  }
  get port(): number { const address = this.http.address(); if (!address || typeof address === "string") throw new Error("Server is not listening."); return address.port; }
  get statusPort(): number | undefined { const address = this.plainHttp?.address(); return address && typeof address !== "string" ? address.port : undefined; }
  private publicStatus(): PublicStatus {
    let connectedParticipants = 0;
    for (const member of this.members.values()) if (member.socket?.readyState === WebSocket.OPEN) connectedParticipants++;
    return { rooms: this.rooms.size, connectedParticipants };
  }
  private httpRequest(req: IncomingMessage, res: ServerResponse): void {
    const headers: Record<string, string> = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'" };
    let path: string;
    try { path = new URL(req.url ?? "/", "https://sideband.invalid").pathname; }
    catch { res.writeHead(400, { ...headers, "Content-Type": "text/plain; charset=utf-8" }); res.end("Bad request.\n"); return; }
    const chat = path === "/chat" || path === "/chat.js";
    const known = path === "/" || path === "/status.json" || chat;
    if (chat) {
      // Spell out the same-origin WebSocket URL for browsers that don't map CSP 'self' to ws/wss.
      const host = req.headers.host ?? "";
      const socketSource = /^(?:[a-zA-Z0-9_.-]+|\[[a-fA-F0-9:]+\])(?::[0-9]+)?$/.test(host) ? ` ${ (req.socket as TLSSocket).encrypted ? "wss" : "ws" }://${host}` : "";
      headers["Content-Security-Policy"] = `default-src 'none'; style-src 'unsafe-inline'; script-src 'self'; connect-src 'self'${socketSource}; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`;
    }
    const methodAllowed = req.method === "GET" || req.method === "HEAD";
    let code = 200; let body: string; let contentType = "text/plain; charset=utf-8";
    if (!known) { code = 404; body = "Not found.\n"; }
    else if (!methodAllowed) { code = 405; headers.Allow = "GET, HEAD"; body = "Method not allowed.\n"; }
    else if (path === "/chat") { contentType = "text/html; charset=utf-8"; body = webPage(); }
    else if (path === "/chat.js") { contentType = "text/javascript; charset=utf-8"; body = browserScript; }
    else if (path === "/status.json") { contentType = "application/json; charset=utf-8"; body = `${JSON.stringify(this.publicStatus())}\n`; }
    else { contentType = "text/html; charset=utf-8"; body = statusPage(this.publicStatus()); }
    res.writeHead(code, { ...headers, "Content-Type": contentType, "Content-Length": String(Buffer.byteLength(body)) });
    res.end(req.method === "HEAD" ? undefined : body);
  }
  private send(socket: WebSocket, packet: object): void {
    if (socket.readyState !== WebSocket.OPEN) return;
    if (socket.bufferedAmount > 1024 * 1024) { socket.terminate(); return; }
    socket.send(JSON.stringify({ v: VERSION, ...packet }));
  }
  private accept(socket: WebSocket): void {
    const connection: Connection = {
      alive: true, challenge: randomBytes(32).toString("base64url"), tokens: 200, lastRefill: Date.now(),
      authTimer: setTimeout(() => socket.close(1008, "Authentication required"), this.options.authTimeoutMs ?? 5000),
    };
    connection.authTimer.unref();
    this.connections.set(socket, connection);
    socket.on("pong", () => { connection.alive = true; });
    socket.on("error", () => {});
    socket.on("close", () => {
      clearTimeout(connection.authTimer);
      this.connections.delete(socket);
      const member = connection.member;
      if (!member || member.socket !== socket) return;
      member.socket = undefined;
      if (this.stopping) return;
      this.presence(member, "disconnected");
      member.expiry = setTimeout(() => this.remove(member), this.options.graceMs ?? 15_000);
      member.expiry.unref();
    });
    socket.on("message", (raw, binary) => {
      let id: string | undefined;
      try {
        if (binary) throw new RoomError("INVALID_REQUEST", "Text JSON requests only.");
        const request = fields(JSON.parse(raw.toString()), ["v", "id", "method", "params"]);
        id = text(request.id, "request ID", 64);
        if (request.v !== VERSION) throw new RoomError("VERSION", "Unsupported protocol version.");
        const now = Date.now();
        connection.tokens = Math.min(200, connection.tokens + (now - connection.lastRefill) / 20);
        connection.lastRefill = now;
        if (connection.tokens < 1) throw new RoomError("RATE_LIMIT", "Too many requests; slow down.");
        connection.tokens--;
        const method = text(request.method, "method", 32);
        const result = this.request(socket, connection, method, request.params ?? {});
        this.send(socket, { id, result });
        if (method === "logout") socket.close(1000, "Logged out");
      } catch (error) {
        const code = error instanceof RoomError ? error.code : "INVALID_REQUEST";
        const message = error instanceof RoomError ? error.message : "Invalid request.";
        this.send(socket, { ...(id ? { id } : {}), error: { code, message } });
        if (!connection.member) socket.close(1008, "Authentication failed");
      }
    });
  }
  private request(socket: WebSocket, connection: Connection, method: string, params: unknown): unknown {
    if (method === "hello") {
      if (connection.member || connection.candidate) throw new RoomError("AUTH_STATE", "Handshake already started.");
      const args = fields(params, ["publicKey", "name"]);
      connection.candidate = identityFor(text(args.publicKey, "public key", 100), agentName(args.name));
      return { challenge: connection.challenge, fingerprint: this.fingerprint };
    }
    if (method === "authenticate") {
      const args = fields(params, ["secret", "signature"]);
      const candidate = connection.candidate;
      const digest = createHash("sha256").update(typeof args.secret === "string" ? args.secret : "").digest();
      if (connection.member || !candidate || !timingSafeEqual(digest, this.secret) || !validSignature(candidate.publicKey, loginProof(connection.challenge, this.fingerprint, candidate), args.signature)) {
        throw new RoomError("AUTH_FAILED", "Password or identity proof is invalid.");
      }
      const reserved = candidate.name ? this.names.get(candidate.name.toLowerCase()) : undefined;
      if (reserved && reserved !== candidate.id) throw new RoomError("NAME_IN_USE", "That agent name is already registered. Choose another name.");
      let member = this.members.get(candidate.id);
      const resumed = !!member;
      if (member && member.identity.name !== candidate.name) throw new RoomError("IDENTITY_NAME", "An active identity cannot change its name.");
      if (!member) {
        if (this.members.size >= (this.options.maxClients ?? 1024)) throw new RoomError("CAPACITY", "Server client capacity reached.");
        member = { identity: candidate };
        this.members.set(candidate.id, member);
        if (candidate.name) this.names.set(candidate.name.toLowerCase(), candidate.id);
      }
      if (member.expiry) clearTimeout(member.expiry);
      const prior = member.socket;
      member.socket = socket; connection.member = member;
      prior?.close(4001, "Reconnected elsewhere");
      clearTimeout(connection.authTimer);
      if (resumed && !prior) this.presence(member, "reconnected");
      return { identity: member.identity, room: member.roomId ? this.summary(this.rooms.get(member.roomId)!) : null, resumed };
    }
    const member = connection.member;
    if (!member || member.socket !== socket) throw new RoomError("AUTH_REQUIRED", "Authenticate first.");
    switch (method) {
      case "rooms": fields(params, []); return [...this.rooms.values()].map((room) => this.summary(room));
      case "create": {
        const args = fields(params, ["name"]);
        const name = text(args.name, "room name", 100).trim();
        if (!name || /[\x00-\x1f\x7f]/.test(name)) throw new RoomError("INVALID_ARGUMENT", "Invalid room name.");
        if ([...this.rooms.values()].some((room) => room.name.toLowerCase() === name.toLowerCase())) throw new RoomError("ROOM_EXISTS", "Room name is in use; join it explicitly.");
        const room: RoomState = { id: randomUUID(), name, members: new Set(), history: [] };
        this.rooms.set(room.id, room); this.join(member, room); return this.summary(room);
      }
      case "join": {
        const args = fields(params, ["room"]); const target = text(args.room, "room", 100);
        const room = this.rooms.get(target) ?? [...this.rooms.values()].find((room) => room.name.toLowerCase() === target.toLowerCase());
        if (!room) throw new RoomError("ROOM_NOT_FOUND", "Room does not exist.");
        this.join(member, room); return this.summary(room);
      }
      case "leave": fields(params, []); this.leave(member); return { left: true };
      case "logout": fields(params, []); this.remove(member); connection.member = undefined; return { loggedOut: true };
      case "members": fields(params, []); return [...this.currentRoom(member).members].map((id) => ({ ...this.members.get(id)!.identity, connected: !!this.members.get(id)!.socket }));
      case "history": {
        const args = fields(params, ["limit"]); const limit = args.limit ?? 50;
        if (!Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > 50) throw new RoomError("INVALID_ARGUMENT", "History limit must be 1-50.");
        return this.currentRoom(member).history.slice(-(limit as number));
      }
      case "send": {
        const args = fields(params, ["id", "text", "signature"]);
        const room = this.currentRoom(member);
        const id = text(args.id, "message ID", 64);
        const body = text(args.text, "message", MAX_TEXT_BYTES);
        if (!body.trim() || Buffer.byteLength(body) > MAX_TEXT_BYTES) throw new RoomError("INVALID_ARGUMENT", "Message must be nonempty and at most 8192 UTF-8 bytes.");
        const message: SignedMessage = { id, roomId: room.id, sender: member.identity, text: body, signature: text(args.signature, "signature", 100), createdAt: Date.now() };
        if (!validSignature(member.identity.publicKey, messageProof(message), message.signature)) throw new RoomError("INVALID_SIGNATURE", "Message signature is invalid.");
        const prior = room.history.find((item) => item.id === id);
        if (prior) {
          if (prior.sender.id === member.identity.id && prior.signature === message.signature) return { messageId: id };
          throw new RoomError("MESSAGE_ID", "Message ID is already in use.");
        }
        room.history.push(message); if (room.history.length > 50) room.history.shift();
        for (const peerId of room.members) {
          if (peerId === member.identity.id) continue;
          const peer = this.members.get(peerId)!;
          if (peer.socket) this.send(peer.socket, { event: "message", data: message });
        }
        return { messageId: id };
      }
      default: throw new RoomError("UNKNOWN_METHOD", "Unknown method.");
    }
  }
  private summary(room: RoomState): Room { return { id: room.id, name: room.name, members: room.members.size }; }
  private currentRoom(member: Member): RoomState {
    const room = member.roomId ? this.rooms.get(member.roomId) : undefined;
    if (!room) throw new RoomError("NO_ROOM", "Create or join a room first.");
    return room;
  }
  private join(member: Member, room: RoomState): void {
    if (member.roomId === room.id) return;
    this.leave(member); member.roomId = room.id; room.members.add(member.identity.id);
    this.presence(member, "joined");
  }
  private presence(member: Member, kind: PresenceKind): void {
    const room = member.roomId ? this.rooms.get(member.roomId) : undefined;
    if (!room || this.stopping) return;
    const data = { id: randomUUID(), roomId: room.id, kind, participant: member.identity, createdAt: Date.now() };
    for (const id of room.members) {
      if (id === member.identity.id) continue;
      const peer = this.members.get(id);
      if (peer?.socket) this.send(peer.socket, { event: "presence", data });
    }
  }
  private leave(member: Member): void {
    if (!member.roomId) return;
    // A crashed peer was already announced on disconnect; expiry is not a second departure.
    if (member.socket) this.presence(member, "left");
    const room = this.rooms.get(member.roomId); room?.members.delete(member.identity.id);
    if (room?.members.size === 0) this.rooms.delete(room.id);
    member.roomId = undefined;
  }
  private remove(member: Member): void {
    if (member.expiry) clearTimeout(member.expiry);
    this.leave(member); this.members.delete(member.identity.id);
    if (member.identity.name) this.names.delete(member.identity.name.toLowerCase());
  }
  async close(): Promise<void> {
    this.stopping = true; if (this.heartbeat) clearInterval(this.heartbeat);
    for (const member of this.members.values()) if (member.expiry) clearTimeout(member.expiry);
    for (const socket of this.connections.keys()) socket.terminate();
    // Also close incomplete TLS/HTTP handshakes; shutdown must not wait on unauthenticated clients.
    for (const socket of this.tcpSockets) socket.destroy();
    await new Promise<void>((resolve) => this.ws.close(() => resolve()));
    await new Promise<void>((resolve) => this.http.close(() => resolve()));
    if (this.plainHttp) await new Promise<void>(resolve => this.plainHttp!.close(() => resolve()));
    this.members.clear(); this.names.clear(); this.rooms.clear();
  }
}
