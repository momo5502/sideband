import { createHash, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";
export const VERSION = 1;
export const MAX_TEXT_BYTES = 8192;
export class RoomError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.code = code;
        this.name = "RoomError";
    }
}
export function object(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        throw new RoomError("INVALID_ARGUMENT", "Expected an object.");
    return value;
}
export function fields(value, allowed) {
    const result = object(value);
    if (Object.keys(result).some((key) => !allowed.includes(key)))
        throw new RoomError("INVALID_ARGUMENT", "Unexpected field.");
    return result;
}
export function text(value, label, max = 128) {
    if (typeof value !== "string" || value.length === 0 || value.length > max)
        throw new RoomError("INVALID_ARGUMENT", `Invalid ${label}.`);
    return value;
}
export function agentName(value) {
    if (value === undefined || value === "")
        return undefined;
    const name = text(value, "agent name", 64);
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(name))
        throw new RoomError("INVALID_ARGUMENT", "Agent names use letters, digits, underscores and hyphens.");
    return name;
}
export function publicKey(encoded) {
    if (!/^[A-Za-z0-9_-]{59}$/.test(encoded))
        throw new RoomError("INVALID_KEY", "Expected an Ed25519 public key.");
    const key = createPublicKey({ key: Buffer.from(encoded, "base64url"), type: "spki", format: "der" });
    if (key.asymmetricKeyType !== "ed25519")
        throw new RoomError("INVALID_KEY", "Expected an Ed25519 public key.");
    return key;
}
export function identityFor(encoded, name) {
    const canonical = publicKey(encoded).export({ type: "spki", format: "der" });
    return { id: `agent-${createHash("sha256").update(canonical).digest("base64url")}`, ...(name ? { name } : {}), publicKey: encoded };
}
export class AgentKeys {
    identity;
    privateKey;
    constructor(name) {
        const keys = generateKeyPairSync("ed25519");
        this.privateKey = keys.privateKey;
        this.identity = identityFor(keys.publicKey.export({ type: "spki", format: "der" }).toString("base64url"), agentName(name));
    }
    sign(data) { return sign(null, Buffer.from(data), this.privateKey).toString("base64url"); }
}
export function validSignature(key, data, signature) {
    try {
        return typeof signature === "string" && /^[A-Za-z0-9_-]{86}$/.test(signature) && verify(null, Buffer.from(data), publicKey(key), Buffer.from(signature, "base64url"));
    }
    catch {
        return false;
    }
}
export function loginProof(challenge, fingerprint, identity) {
    return JSON.stringify(["sideband.login", VERSION, challenge, fingerprint, identity.id, identity.name ?? null]);
}
export function messageProof(message) {
    return JSON.stringify(["sideband.message", VERSION, message.id, message.roomId, message.sender.id, message.sender.name ?? null, message.text]);
}
export function verifyMessage(value) {
    try {
        const message = object(value);
        const sender = object(message.sender);
        const identity = identityFor(text(sender.publicKey, "public key", 100), agentName(sender.name));
        if (identity.id !== sender.id || !Number.isFinite(message.createdAt))
            return false;
        text(message.id, "message ID", 64);
        text(message.roomId, "room ID", 64);
        if (typeof message.text !== "string" || Buffer.byteLength(message.text) > MAX_TEXT_BYTES)
            return false;
        return validSignature(identity.publicKey, messageProof(message), message.signature);
    }
    catch {
        return false;
    }
}
export function parsePassword(value) {
    const match = /^sb1\.([A-Za-z0-9_-]{43})\.([A-Za-z0-9_-]{43})$/.exec(value.trim());
    if (!match)
        throw new Error("Invalid server password. Copy the entire sb1.… string printed by the server.");
    return { fingerprint: match[1], secret: match[2] };
}
export function serverUrl(value) {
    const url = new URL(value.includes("://") ? value : `wss://${value}`);
    if (url.protocol !== "wss:" || !url.hostname || url.username || url.password || url.search || url.hash || !["/", "/ws"].includes(url.pathname)) {
        throw new Error("Use an IP:port or wss://host:port address, without credentials or query parameters.");
    }
    url.pathname = "/ws";
    return url.href;
}
//# sourceMappingURL=room-protocol.js.map