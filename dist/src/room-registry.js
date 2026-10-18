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
    status(key) { return this.sessions.get(key)?.status() ?? { state: this.pending.has(key) ? "connecting" : "off" }; }
    get(key) {
        const session = this.sessions.get(key);
        if (!session)
            throw new Error("Messaging is off for this session. Activate first.");
        return session;
    }
    async activate(key, profile, name) {
        if (this.closing || this.sessions.has(key) || this.pending.has(key))
            throw new Error("This session is already active/connecting or shutting down.");
        const pending = (async () => {
            const session = await this.create(key, profile, name);
            try {
                if (this.closing)
                    throw new Error("Activation cancelled.");
                await session.enable();
                if (this.closing)
                    throw new Error("Activation cancelled.");
                this.sessions.set(key, session);
                return session;
            }
            catch (error) {
                await session.disable();
                throw error;
            }
        })();
        this.pending.set(key, pending);
        try {
            return await pending;
        }
        finally {
            this.pending.delete(key);
        }
    }
    async deactivate(key) {
        await this.pending.get(key)?.catch(() => { });
        const session = this.sessions.get(key);
        this.sessions.delete(key);
        await session?.disable();
    }
    async close() {
        this.closing = true;
        await Promise.allSettled(this.pending.values());
        await Promise.allSettled([...this.sessions.values()].map((session) => session.disable()));
        this.sessions.clear();
    }
}
//# sourceMappingURL=room-registry.js.map