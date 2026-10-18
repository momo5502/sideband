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
                content: message.text,
                meta: {
                    chat_id: message.channelId, message_id: message.messageId,
                    user: message.sender.name ?? message.sender.id, user_id: message.senderAccountId,
                    agent_id: message.sender.id, ts: new Date(message.createdAt).toISOString(),
                    verified: String(message.verified === true),
                    ...(message.recipient ? { recipient_id: message.recipient } : {}),
                    ...(message.attachments.length ? { attachments: JSON.stringify(message.attachments) } : {}),
                },
            },
        });
    }
    async close() { }
}
//# sourceMappingURL=claude.js.map