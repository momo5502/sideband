import { createServer } from "node:https";
import { createHash, randomBytes, randomUUID, timingSafeEqual, X509Certificate } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import { createServerIdentity, loadServerIdentity, saveServerIdentity } from "./server-identity.js";
import { VERSION, MAX_TEXT_BYTES, RoomError, agentName, fields, identityFor, loginProof, messageProof, text, validSignature, } from "./room-protocol.js";
/** Rooms and messages are ephemeral. The CLI supplies a file to persist the server identity. */
export class RoomServer {
    options;
    password;
    fingerprint;
    secret;
    http;
    ws;
    members = new Map();
    names = new Map();
    rooms = new Map();
    connections = new Map();
    tcpSockets = new Set();
    heartbeat;
    stopping = false;
    constructor(identity, options) {
        this.options = options;
        this.fingerprint = createHash("sha256").update(new X509Certificate(identity.certificate).raw).digest("base64url");
        this.secret = createHash("sha256").update(identity.secret).digest();
        // The one copyable password includes the certificate pin. No domain/CA setup or TOFU is needed.
        this.password = `sb1.${this.fingerprint}.${identity.secret}`;
        this.http = createServer({ key: identity.privateKey, cert: identity.certificate, minVersion: "TLSv1.2" }, (_req, res) => {
            res.writeHead(404, { "Content-Type": "text/plain", "Cache-Control": "no-store" });
            res.end("Sideband server. Connect using the agent client.\n");
        });
        this.http.headersTimeout = 10_000;
        this.http.requestTimeout = 10_000;
        this.http.maxConnections = (options.maxClients ?? 1024) * 2;
        this.http.on("connection", (socket) => { this.tcpSockets.add(socket); socket.once("close", () => this.tcpSockets.delete(socket)); });
        this.ws = new WebSocketServer({ noServer: true, maxPayload: 32 * 1024, perMessageDeflate: false });
        this.http.on("upgrade", (req, socket, head) => {
            // Browser access is deliberately not a v1 feature. Reject cross-origin WebSocket use.
            if (req.url !== "/ws" || req.headers.origin || this.stopping || this.connections.size >= (options.maxClients ?? 1024)) {
                socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
                return;
            }
            this.ws.handleUpgrade(req, socket, head, (client) => this.accept(client));
        });
    }
    static async start(options = {}) {
        if (options.rotatePassword && !options.credentialsFile)
            throw new Error("Password rotation requires a credentials file.");
        const existing = options.credentialsFile && !options.rotatePassword ? await loadServerIdentity(options.credentialsFile) : undefined;
        const identity = existing ?? await createServerIdentity();
        const server = new RoomServer(identity, options);
        await new Promise((resolve, reject) => {
            server.http.once("error", reject);
            server.http.listen(options.port ?? 8765, options.host ?? "0.0.0.0", () => { server.http.off("error", reject); resolve(); });
        });
        // Bind first: a failed second startup must not rotate the credentials of a running server.
        if (options.credentialsFile && !existing) {
            try {
                await saveServerIdentity(options.credentialsFile, identity, !!options.rotatePassword);
            }
            catch (error) {
                await server.close();
                throw error;
            }
        }
        server.heartbeat = setInterval(() => {
            for (const [socket, connection] of server.connections) {
                if (!connection.alive) {
                    socket.terminate();
                    continue;
                }
                connection.alive = false;
                socket.ping();
            }
        }, options.heartbeatMs ?? 15_000);
        server.heartbeat.unref();
        return server;
    }
    get port() { const address = this.http.address(); if (!address || typeof address === "string")
        throw new Error("Server is not listening."); return address.port; }
    send(socket, packet) {
        if (socket.readyState !== WebSocket.OPEN)
            return;
        if (socket.bufferedAmount > 1024 * 1024) {
            socket.terminate();
            return;
        }
        socket.send(JSON.stringify({ v: VERSION, ...packet }));
    }
    accept(socket) {
        const connection = {
            alive: true, challenge: randomBytes(32).toString("base64url"), tokens: 200, lastRefill: Date.now(),
            authTimer: setTimeout(() => socket.close(1008, "Authentication required"), this.options.authTimeoutMs ?? 5000),
        };
        connection.authTimer.unref();
        this.connections.set(socket, connection);
        socket.on("pong", () => { connection.alive = true; });
        socket.on("error", () => { });
        socket.on("close", () => {
            clearTimeout(connection.authTimer);
            this.connections.delete(socket);
            const member = connection.member;
            if (!member || member.socket !== socket)
                return;
            member.socket = undefined;
            if (this.stopping)
                return;
            this.presence(member, "disconnected");
            member.expiry = setTimeout(() => this.remove(member), this.options.graceMs ?? 15_000);
            member.expiry.unref();
        });
        socket.on("message", (raw, binary) => {
            let id;
            try {
                if (binary)
                    throw new RoomError("INVALID_REQUEST", "Text JSON requests only.");
                const request = fields(JSON.parse(raw.toString()), ["v", "id", "method", "params"]);
                id = text(request.id, "request ID", 64);
                if (request.v !== VERSION)
                    throw new RoomError("VERSION", "Unsupported protocol version.");
                const now = Date.now();
                connection.tokens = Math.min(200, connection.tokens + (now - connection.lastRefill) / 20);
                connection.lastRefill = now;
                if (connection.tokens < 1)
                    throw new RoomError("RATE_LIMIT", "Too many requests; slow down.");
                connection.tokens--;
                const method = text(request.method, "method", 32);
                const result = this.request(socket, connection, method, request.params ?? {});
                this.send(socket, { id, result });
                if (method === "logout")
                    socket.close(1000, "Logged out");
            }
            catch (error) {
                const code = error instanceof RoomError ? error.code : "INVALID_REQUEST";
                const message = error instanceof RoomError ? error.message : "Invalid request.";
                this.send(socket, { ...(id ? { id } : {}), error: { code, message } });
                if (!connection.member)
                    socket.close(1008, "Authentication failed");
            }
        });
    }
    request(socket, connection, method, params) {
        if (method === "hello") {
            if (connection.member || connection.candidate)
                throw new RoomError("AUTH_STATE", "Handshake already started.");
            const args = fields(params, ["publicKey", "name"]);
            connection.candidate = identityFor(text(args.publicKey, "public key", 100), agentName(args.name));
            return { challenge: connection.challenge };
        }
        if (method === "authenticate") {
            const args = fields(params, ["secret", "signature"]);
            const candidate = connection.candidate;
            const digest = createHash("sha256").update(typeof args.secret === "string" ? args.secret : "").digest();
            if (connection.member || !candidate || !timingSafeEqual(digest, this.secret) || !validSignature(candidate.publicKey, loginProof(connection.challenge, this.fingerprint, candidate), args.signature)) {
                throw new RoomError("AUTH_FAILED", "Password or identity proof is invalid.");
            }
            const reserved = candidate.name ? this.names.get(candidate.name.toLowerCase()) : undefined;
            if (reserved && reserved !== candidate.id)
                throw new RoomError("NAME_IN_USE", "That agent name is already registered. Choose another name.");
            let member = this.members.get(candidate.id);
            const resumed = !!member;
            if (member && member.identity.name !== candidate.name)
                throw new RoomError("IDENTITY_NAME", "An active identity cannot change its name.");
            if (!member) {
                if (this.members.size >= (this.options.maxClients ?? 1024))
                    throw new RoomError("CAPACITY", "Server client capacity reached.");
                member = { identity: candidate };
                this.members.set(candidate.id, member);
                if (candidate.name)
                    this.names.set(candidate.name.toLowerCase(), candidate.id);
            }
            if (member.expiry)
                clearTimeout(member.expiry);
            const prior = member.socket;
            member.socket = socket;
            connection.member = member;
            prior?.close(4001, "Reconnected elsewhere");
            clearTimeout(connection.authTimer);
            if (resumed && !prior)
                this.presence(member, "reconnected");
            return { identity: member.identity, room: member.roomId ? this.summary(this.rooms.get(member.roomId)) : null, resumed };
        }
        const member = connection.member;
        if (!member || member.socket !== socket)
            throw new RoomError("AUTH_REQUIRED", "Authenticate first.");
        switch (method) {
            case "rooms":
                fields(params, []);
                return [...this.rooms.values()].map((room) => this.summary(room));
            case "create": {
                const args = fields(params, ["name"]);
                const name = text(args.name, "room name", 100).trim();
                if (!name || /[\x00-\x1f\x7f]/.test(name))
                    throw new RoomError("INVALID_ARGUMENT", "Invalid room name.");
                if ([...this.rooms.values()].some((room) => room.name.toLowerCase() === name.toLowerCase()))
                    throw new RoomError("ROOM_EXISTS", "Room name is in use; join it explicitly.");
                const room = { id: randomUUID(), name, members: new Set(), history: [] };
                this.rooms.set(room.id, room);
                this.join(member, room);
                return this.summary(room);
            }
            case "join": {
                const args = fields(params, ["room"]);
                const target = text(args.room, "room", 100);
                const room = this.rooms.get(target) ?? [...this.rooms.values()].find((room) => room.name.toLowerCase() === target.toLowerCase());
                if (!room)
                    throw new RoomError("ROOM_NOT_FOUND", "Room does not exist.");
                this.join(member, room);
                return this.summary(room);
            }
            case "leave":
                fields(params, []);
                this.leave(member);
                return { left: true };
            case "logout":
                fields(params, []);
                this.remove(member);
                connection.member = undefined;
                return { loggedOut: true };
            case "members":
                fields(params, []);
                return [...this.currentRoom(member).members].map((id) => ({ ...this.members.get(id).identity, connected: !!this.members.get(id).socket }));
            case "history": {
                const args = fields(params, ["limit"]);
                const limit = args.limit ?? 50;
                if (!Number.isInteger(limit) || limit < 1 || limit > 50)
                    throw new RoomError("INVALID_ARGUMENT", "History limit must be 1-50.");
                return this.currentRoom(member).history.slice(-limit);
            }
            case "send": {
                const args = fields(params, ["id", "text", "signature"]);
                const room = this.currentRoom(member);
                const id = text(args.id, "message ID", 64);
                const body = text(args.text, "message", MAX_TEXT_BYTES);
                if (!body.trim() || Buffer.byteLength(body) > MAX_TEXT_BYTES)
                    throw new RoomError("INVALID_ARGUMENT", "Message must be nonempty and at most 8192 UTF-8 bytes.");
                const message = { id, roomId: room.id, sender: member.identity, text: body, signature: text(args.signature, "signature", 100), createdAt: Date.now() };
                if (!validSignature(member.identity.publicKey, messageProof(message), message.signature))
                    throw new RoomError("INVALID_SIGNATURE", "Message signature is invalid.");
                const prior = room.history.find((item) => item.id === id);
                if (prior) {
                    if (prior.sender.id === member.identity.id && prior.signature === message.signature)
                        return { messageId: id };
                    throw new RoomError("MESSAGE_ID", "Message ID is already in use.");
                }
                room.history.push(message);
                if (room.history.length > 50)
                    room.history.shift();
                for (const peerId of room.members) {
                    if (peerId === member.identity.id)
                        continue;
                    const peer = this.members.get(peerId);
                    if (peer.socket)
                        this.send(peer.socket, { event: "message", data: message });
                }
                return { messageId: id };
            }
            default: throw new RoomError("UNKNOWN_METHOD", "Unknown method.");
        }
    }
    summary(room) { return { id: room.id, name: room.name, members: room.members.size }; }
    currentRoom(member) {
        const room = member.roomId ? this.rooms.get(member.roomId) : undefined;
        if (!room)
            throw new RoomError("NO_ROOM", "Create or join a room first.");
        return room;
    }
    join(member, room) {
        if (member.roomId === room.id)
            return;
        this.leave(member);
        member.roomId = room.id;
        room.members.add(member.identity.id);
        this.presence(member, "joined");
    }
    presence(member, kind) {
        const room = member.roomId ? this.rooms.get(member.roomId) : undefined;
        if (!room || this.stopping)
            return;
        const data = { id: randomUUID(), roomId: room.id, kind, participant: member.identity, createdAt: Date.now() };
        for (const id of room.members) {
            if (id === member.identity.id)
                continue;
            const peer = this.members.get(id);
            if (peer?.socket)
                this.send(peer.socket, { event: "presence", data });
        }
    }
    leave(member) {
        if (!member.roomId)
            return;
        // A crashed peer was already announced on disconnect; expiry is not a second departure.
        if (member.socket)
            this.presence(member, "left");
        const room = this.rooms.get(member.roomId);
        room?.members.delete(member.identity.id);
        if (room?.members.size === 0)
            this.rooms.delete(room.id);
        member.roomId = undefined;
    }
    remove(member) {
        if (member.expiry)
            clearTimeout(member.expiry);
        this.leave(member);
        this.members.delete(member.identity.id);
        if (member.identity.name)
            this.names.delete(member.identity.name.toLowerCase());
    }
    async close() {
        this.stopping = true;
        if (this.heartbeat)
            clearInterval(this.heartbeat);
        for (const member of this.members.values())
            if (member.expiry)
                clearTimeout(member.expiry);
        for (const socket of this.connections.keys())
            socket.terminate();
        // Also close incomplete TLS/HTTP handshakes; shutdown must not wait on unauthenticated clients.
        for (const socket of this.tcpSockets)
            socket.destroy();
        await new Promise((resolve) => this.ws.close(() => resolve()));
        await new Promise((resolve) => this.http.close(() => resolve()));
        this.members.clear();
        this.names.clear();
        this.rooms.clear();
    }
}
//# sourceMappingURL=room-server.js.map