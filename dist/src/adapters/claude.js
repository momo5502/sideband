import { formatDelivery } from "../protocol.js";
export class ClaudeAdapter {
    server;
    constructor(server) {
        this.server = server;
    }
    async prepare() {
        // MCP initialization alone cannot prove that the host enabled native channels.
        // Registration is a host startup setting, not something a model-supplied flag can verify.
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