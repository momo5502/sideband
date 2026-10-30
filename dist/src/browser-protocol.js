import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
const encode = (value) => new TextEncoder().encode(value);
export const base64 = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
export const unbase64 = (value) => Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0));
export const randomId = () => base64(crypto.getRandomValues(new Uint8Array(24)));
const prefix = Uint8Array.from([0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00]);
export function browserIdentity(key, name) {
    const der = new Uint8Array(44);
    der.set(prefix);
    der.set(ed25519.getPublicKey(key), 12);
    return { id: `agent-${base64(sha256(der))}`, ...(name ? { name } : {}), publicKey: base64(der) };
}
const proof = (m) => JSON.stringify(["sideband.message", 1, m.id, m.roomId, m.sender.id, m.sender.name ?? null, m.text]);
export function browserVerify(message) {
    try {
        const der = unbase64(message.sender.publicKey);
        return der.length === 44 && prefix.every((byte, i) => byte === der[i]) &&
            message.sender.id === `agent-${base64(sha256(der))}` && Number.isFinite(message.createdAt) &&
            typeof message.id === "string" && typeof message.roomId === "string" && typeof message.text === "string" && encode(message.text).length <= 8192 &&
            ed25519.verify(unbase64(message.signature), encode(proof(message)), der.slice(12), { zip215: false });
    }
    catch {
        return false;
    }
}
export class BrowserRoomClient {
    endpoint;
    password;
    key;
    makeSocket;
    identity;
    room = null;
    onMessage = () => { };
    onPresence = () => { };
    onClose = () => { };
    onError = () => { };
    socket;
    authenticated = false;
    pending = new Map();
    constructor(endpoint, password, name, key = crypto.getRandomValues(new Uint8Array(32)), makeSocket = (url) => new WebSocket(url)) {
        this.endpoint = endpoint;
        this.password = password;
        this.key = key;
        this.makeSocket = makeSocket;
        if (!/^sb1\.[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}$/.test(password))
            throw new Error("Copy the complete sb1. password from the server.");
        if (name && !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(name))
            throw new Error("Names use letters, digits, underscores and hyphens (up to 64 characters).");
        this.identity = browserIdentity(key, name || undefined);
    }
    async connect() {
        if (this.socket)
            throw new Error("Already connected.");
        const socket = this.makeSocket(this.endpoint);
        this.socket = socket;
        socket.addEventListener("message", event => {
            try {
                const packet = JSON.parse(String(event.data));
                if (packet.v !== 1)
                    throw new Error("Unsupported server protocol.");
                const pending = this.pending.get(packet.id);
                if (pending) {
                    clearTimeout(pending.timer);
                    this.pending.delete(packet.id);
                    if (packet.error)
                        pending.reject(Object.assign(new Error(packet.error.message), { code: packet.error.code }));
                    else
                        pending.resolve(packet.result);
                }
                else if (this.authenticated && packet.event === "message") {
                    if (!browserVerify(packet.data))
                        throw new Error("Rejected a message with an invalid signature.");
                    if (packet.data.roomId === this.room?.id && packet.data.sender.id !== this.identity.id)
                        this.onMessage(packet.data);
                }
                else if (this.authenticated && packet.event === "presence" && packet.data.roomId === this.room?.id && packet.data.participant.id !== this.identity.id) {
                    this.onPresence(packet.data);
                }
            }
            catch (error) {
                this.onError(error instanceof Error ? error : new Error("Invalid server message."));
            }
        });
        socket.addEventListener("close", () => {
            if (this.socket !== socket)
                return;
            this.socket = undefined;
            this.authenticated = false;
            for (const item of this.pending.values()) {
                clearTimeout(item.timer);
                item.reject(new Error("Connection lost. Check history before resending."));
            }
            this.pending.clear();
            this.onClose();
        });
        try {
            await new Promise((resolve, reject) => {
                const timer = setTimeout(() => { socket.close(); reject(new Error("Connection timed out.")); }, 10000);
                const done = (error) => { clearTimeout(timer); error ? reject(error) : resolve(); };
                socket.addEventListener("open", () => done(), { once: true });
                socket.addEventListener("error", () => done(new Error("Cannot connect to this server.")), { once: true });
                socket.addEventListener("close", () => done(new Error("Connection closed.")), { once: true });
            });
            const [, fingerprint, secret] = this.password.split(".");
            const hello = await this.request("hello", { publicKey: this.identity.publicKey, ...(this.identity.name ? { name: this.identity.name } : {}) });
            if (hello.fingerprint !== fingerprint)
                throw new Error("The saved password belongs to a different server certificate. Enter this server's current password.");
            if (!/^[A-Za-z0-9_-]{43}$/.test(hello.challenge))
                throw new Error("Invalid server challenge.");
            const signature = base64(ed25519.sign(encode(JSON.stringify(["sideband.login", 1, hello.challenge, fingerprint, this.identity.id, this.identity.name ?? null])), this.key));
            const login = await this.request("authenticate", { secret, signature });
            if (login.identity.id !== this.identity.id || login.identity.publicKey !== this.identity.publicKey || login.identity.name !== this.identity.name)
                throw new Error("Invalid server identity response.");
            this.authenticated = true;
            this.room = login.room;
        }
        catch (error) {
            socket.close();
            throw error;
        }
    }
    request(method, params = {}) {
        if (this.socket?.readyState !== 1)
            return Promise.reject(new Error("Disconnected."));
        const id = randomId();
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => { this.pending.delete(id); reject(new Error("Request timed out. Check history before resending.")); }, 7000);
            this.pending.set(id, { resolve, reject, timer });
            this.socket.send(JSON.stringify({ v: 1, id, method, params }));
        });
    }
    rooms() { return this.request("rooms"); }
    async join(room) {
        const joined = await this.request("join", { room });
        this.room = joined;
        return joined;
    }
    async leave() { await this.request("leave"); this.room = null; }
    async history() {
        const messages = await this.request("history");
        if (!Array.isArray(messages) || !messages.every(message => message.roomId === this.room?.id && browserVerify(message)))
            throw new Error("Invalid history signatures.");
        return messages;
    }
    async send(text) {
        if (!this.room)
            throw new Error("Join a room first.");
        if (!text.trim() || encode(text).length > 8192)
            throw new Error("Message must be nonempty and at most 8192 UTF-8 bytes.");
        const unsigned = { id: randomId(), roomId: this.room.id, sender: this.identity, text };
        const message = { ...unsigned, signature: base64(ed25519.sign(encode(proof(unsigned)), this.key)), createdAt: Date.now() };
        await this.request("send", { id: message.id, text, signature: message.signature });
        return message;
    }
    disconnect() {
        if (this.socket?.readyState === 1)
            this.socket.send(JSON.stringify({ v: 1, id: randomId(), method: "logout", params: {} }));
        this.socket?.close();
        this.room = null;
    }
}
//# sourceMappingURL=browser-protocol.js.map