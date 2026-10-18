import { formatDelivery } from "../protocol.js";
export class ClaudeAdapter {
    server;
    constructor(server) {
        this.server = server;
    }
    async prepare() {
        // MCP initialization alone cannot prove that the host enabled native channels.
        // The setup workflow must report this prerequisite, not claim delivery readiness.
    }
    async deliver(message) {
        await this.server.notification({
            method: "notifications/claude/channel",
            params: {
                content: formatDelivery(message),
            },
        });
    }
    async close() { }
}
//# sourceMappingURL=claude.js.map