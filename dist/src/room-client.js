import { createHash, randomUUID } from "node:crypto";
import WebSocket from "ws";
import { AgentKeys, RoomError, VERSION, loginProof, messageProof, parsePassword, serverUrl, verifyMessage, validPresence } from "./room-protocol.js";
export class RoomClient {
    profile;
    options;
    keys;
    room = null;
    state = "off";
    lastError;
    socket;
    reconnectTimer;
    watchdog;
    wanted = false;
    attempts = 0;
    generation = 0;
    pending = new Map();
    listeners = new Set();
    presenceListeners = new Set();
    seen = new Set();
    endpoint;
    constructor(profile, name, options = {}) {
        this.profile = profile;
        this.options = options;
        this.endpoint = serverUrl(profile.server);
        parsePassword(profile.password);
        this.keys = new AgentKeys(name);
    }
    get identity() { return this.keys.identity; }
    onMessage(listener) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
    onPresence(listener) { this.presenceListeners.add(listener); return () => { this.presenceListeners.delete(listener); }; }
    remember(key) {
        if (this.seen.has(key))
            return false;
        this.seen.add(key);
        if (this.seen.size > 10_000)
            this.seen.delete(this.seen.values().next().value);
        return true;
    }
    error(error) {
        const normalized = error instanceof Error ? error : new Error("Connection failed.");
        this.lastError = normalized.message;
        this.options.onError?.(normalized);
    }
    async connect() {
        if (this.wanted)
            throw new Error("Already connected or connecting.");
        this.wanted = true;
        this.state = "connecting";
        try {
            await this.open(++this.generation);
        }
        catch (error) {
            this.wanted = false;
            this.state = "off";
            this.socket?.terminate();
            throw error;
        }
    }
    async open(generation) {
        const { secret, fingerprint } = parsePassword(this.profile.password);
        const socket = new WebSocket(this.endpoint, {
            // This isn't unverified TLS: the exact SHA-256 certificate pin is verified below,
            // before any password, public identity or message is sent.
            rejectUnauthorized: false, handshakeTimeout: 5000, maxPayload: 1024 * 1024, perMessageDeflate: false, followRedirects: false,
        });
        this.socket = socket;
        let pinned = false;
        let authenticated = false;
        let fatal;
        const resetWatchdog = () => {
            if (this.watchdog)
                clearTimeout(this.watchdog);
            this.watchdog = setTimeout(() => socket.terminate(), 45_000);
            this.watchdog.unref();
        };
        socket.on("upgrade", (response) => {
            const raw = response.socket.getPeerCertificate().raw;
            pinned = !!raw && createHash("sha256").update(raw).digest("base64url") === fingerprint;
            if (!pinned) {
                fatal = new RoomError("SERVER_IDENTITY", "Server certificate does not match the password. The server may have restarted, or the address is wrong. Reconfigure; do not bypass verification.");
                socket.terminate();
            }
        });
        socket.on("message", (raw) => {
            try {
                const packet = JSON.parse(raw.toString());
                if (packet.v !== VERSION)
                    throw new Error("Unsupported server protocol.");
                if (typeof packet.id === "string") {
                    const pending = this.pending.get(packet.id);
                    if (!pending)
                        return;
                    clearTimeout(pending.timer);
                    this.pending.delete(packet.id);
                    if (packet.error)
                        pending.reject(new RoomError(packet.error.code, packet.error.message));
                    else
                        pending.resolve(packet.result);
                    return;
                }
                if (packet.event === "message") {
                    if (!authenticated || !verifyMessage(packet.data))
                        throw new Error("Rejected a message with invalid identity/signature.");
                    const message = packet.data;
                    if (message.roomId !== this.room?.id || message.sender.id === this.identity.id || !this.remember(`${message.roomId}:${message.id}`))
                        return;
                    for (const listener of this.listeners)
                        listener(message);
                }
                if (packet.event === "presence") {
                    if (!authenticated || !validPresence(packet.data))
                        throw new Error("Rejected an invalid presence event.");
                    const event = packet.data;
                    if (event.roomId !== this.room?.id || event.participant.id === this.identity.id || !this.remember(`presence:${event.roomId}:${event.id}`))
                        return;
                    for (const listener of this.presenceListeners)
                        listener(event);
                }
            }
            catch (error) {
                this.error(error);
            }
        });
        socket.on("ping", resetWatchdog);
        socket.on("error", () => { });
        socket.on("close", () => {
            if (this.watchdog)
                clearTimeout(this.watchdog);
            for (const pending of this.pending.values()) {
                clearTimeout(pending.timer);
                pending.reject(new Error("Connection lost; request acceptance is unknown. Check history before resending."));
            }
            this.pending.clear();
            if (!authenticated || generation !== this.generation || !this.wanted)
                return;
            this.state = "reconnecting";
            this.scheduleReconnect();
        });
        try {
            await new Promise((resolve, reject) => {
                socket.once("open", () => pinned ? resolve() : reject(fatal ?? new Error("Server pin was not verified.")));
                socket.once("error", () => reject(fatal ?? new Error("Cannot connect to the room server.")));
                socket.once("close", () => reject(fatal ?? new Error("Room server closed the connection.")));
            });
            if (generation !== this.generation || !this.wanted)
                throw new Error("Connection cancelled.");
            const { challenge } = await this.request("hello", { publicKey: this.identity.publicKey, ...(this.identity.name ? { name: this.identity.name } : {}) });
            if (typeof challenge !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(challenge))
                throw new Error("Invalid identity challenge.");
            const login = await this.request("authenticate", { secret, signature: this.keys.sign(loginProof(challenge, fingerprint, this.identity)) });
            if (login.identity.id !== this.identity.id || login.identity.publicKey !== this.identity.publicKey || login.identity.name !== this.identity.name)
                throw new Error("Server returned an inconsistent agent identity.");
            if (!login.resumed && this.room)
                this.error(new Error("Previous room membership expired. Create or join a room again."));
            this.room = login.room;
            authenticated = true;
            this.state = "on";
            this.attempts = 0;
            resetWatchdog();
        }
        catch (error) {
            socket.terminate();
            throw fatal ?? error;
        }
    }
    scheduleReconnect() {
        const delay = this.options.reconnectMs ?? Math.min(10_000, 250 * 2 ** Math.min(this.attempts++, 6));
        const generation = ++this.generation;
        this.reconnectTimer = setTimeout(async () => {
            if (!this.wanted || generation !== this.generation)
                return;
            try {
                await this.open(generation);
            }
            catch (error) {
                this.error(error);
                if (error instanceof RoomError && ["SERVER_IDENTITY", "AUTH_FAILED", "NAME_IN_USE"].includes(error.code)) {
                    this.wanted = false;
                    this.state = "disconnected";
                    this.room = null;
                    return;
                }
                if (this.wanted)
                    this.scheduleReconnect();
            }
        }, delay);
        this.reconnectTimer.unref();
    }
    request(method, params = {}) {
        const socket = this.socket;
        if (!socket || socket.readyState !== WebSocket.OPEN)
            return Promise.reject(new Error("Room server is disconnected."));
        const id = randomUUID();
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => { this.pending.delete(id); reject(new Error("Request timed out; acceptance is unknown. Check history before resending.")); }, 5000);
            this.pending.set(id, { resolve: (value) => resolve(value), reject, timer });
            socket.send(JSON.stringify({ v: VERSION, id, method, params }), (error) => {
                if (error) {
                    clearTimeout(timer);
                    this.pending.delete(id);
                    reject(error);
                }
            });
        });
    }
    requireOn() { if (this.state !== "on")
        throw new Error("Messaging is not connected."); }
    async listRooms() { this.requireOn(); return this.request("rooms"); }
    async createRoom(name) { this.requireOn(); const room = await this.request("create", { name }); this.room = room; return room; }
    async joinRoom(room) { this.requireOn(); const joined = await this.request("join", { room }); this.room = joined; return joined; }
    async leaveRoom() { this.requireOn(); await this.request("leave"); this.room = null; }
    async members() { this.requireOn(); return this.request("members"); }
    async history(limit = 50) {
        this.requireOn();
        const messages = await this.request("history", { limit });
        if (!Array.isArray(messages) || !messages.every((message) => message.roomId === this.room?.id && verifyMessage(message)))
            throw new Error("History contains invalid identities or signatures.");
        return messages;
    }
    async send(text) {
        this.requireOn();
        if (!this.room)
            throw new Error("Create or join a room first.");
        const message = { id: randomUUID(), roomId: this.room.id, sender: this.identity, text };
        return this.request("send", { id: message.id, text, signature: this.keys.sign(messageProof(message)) });
    }
    /** Used by transport tests and useful when diagnosing recovery; never polls the inbox. */
    dropConnection() { this.socket?.terminate(); }
    async close() {
        this.wanted = false;
        ++this.generation;
        if (this.reconnectTimer)
            clearTimeout(this.reconnectTimer);
        if (this.watchdog)
            clearTimeout(this.watchdog);
        if (this.state === "on")
            await this.request("logout").catch(() => { });
        this.state = "off";
        this.room = null;
        this.socket?.terminate();
        for (const pending of this.pending.values()) {
            clearTimeout(pending.timer);
            pending.reject(new Error("Messaging disabled."));
        }
        this.pending.clear();
    }
}
//# sourceMappingURL=room-client.js.map