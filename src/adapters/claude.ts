import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { Delivery } from "../protocol.js";
import type { DeliveryAdapter } from "./codex.js";

export class ClaudeAdapter implements DeliveryAdapter {
  constructor(private readonly server: Server) {}
  async prepare(): Promise<void> {
    // MCP initialization alone cannot prove that the host enabled native channels.
    // The setup workflow must report this prerequisite, not claim delivery readiness.
  }
  async deliver(message: Delivery): Promise<void> {
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
  async close(): Promise<void> {}
}
