import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { formatDelivery, type Delivery } from "../protocol.js";
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
        content: formatDelivery(message),
      },
    });
  }
  async close(): Promise<void> {}
}
