import { agentName } from "./room-protocol.js";
export function callerKey(harness, meta) {
    if (harness === "claude")
        return "claude-process";
    const id = meta?.threadId;
    if (typeof id !== "string" || !id.trim())
        throw new Error("Codex did not supply _meta.threadId; cannot safely bind the calling session. Upgrade Codex.");
    return id;
}
export class RoomRegistry {
    create;
    sessions = new Map();
    pending = new Map();
    closing = false;
    constructor(create) {
        this.create = create;
    }
    status(key) { return this.sessions.get(key)?.session.status() ?? { state: this.pending.has(key) ? "connecting" : "off" }; }
    get(key) {
        const entry = this.sessions.get(key);
        if (!entry)
            throw new Error("Messaging is off for this session. Join a room first.");
        return entry.session;
    }
    async connect(key, load, profile, name) {
        if (this.closing)
            throw new Error("Messaging is shutting down.");
        const requestedName = name === undefined ? undefined : agentName(name);
        let entry = this.sessions.get(key);
        if (!entry) {
            let pending = this.pending.get(key);
            if (!pending) {
                pending = (async () => {
                    const selected = await load();
                    if (this.closing)
                        throw new Error("Connection cancelled.");
                    const session = await this.create(key, selected.profile, requestedName);
                    try {
                        if (this.closing)
                            throw new Error("Connection cancelled.");
                        await session.enable();
                        if (this.closing)
                            throw new Error("Connection cancelled.");
                        const connected = { session, profile: selected.name };
                        this.sessions.set(key, connected);
                        return connected;
                    }
                    catch (error) {
                        await session.disable();
                        throw error;
                    }
                })();
                this.pending.set(key, pending);
            }
            try {
                entry = await pending;
            }
            finally {
                if (this.pending.get(key) === pending)
                    this.pending.delete(key);
            }
        }
        if (profile !== undefined && profile !== entry.profile)
            throw new Error("Already connected to a different profile. Disconnect with sideband_deactivate before changing servers.");
        if (name !== undefined && requestedName !== entry.session.client.identity.name)
            throw new Error("Already connected with a different name. Disconnect with sideband_deactivate before changing identity.");
        return entry.session;
    }
    async deactivate(key) {
        await this.pending.get(key)?.catch(() => { });
        const entry = this.sessions.get(key);
        this.sessions.delete(key);
        await entry?.session.disable();
    }
    async close() {
        this.closing = true;
        await Promise.allSettled(this.pending.values());
        await Promise.allSettled([...this.sessions.values()].map(({ session }) => session.disable()));
        this.sessions.clear();
    }
}
//# sourceMappingURL=room-registry.js.map