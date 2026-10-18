import test from "node:test";
import assert from "node:assert/strict";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { ClaudeAdapter } from "../src/adapters/claude.js";

test("Claude native channel notification contains only the compact message envelope", async () => {
  const notifications: unknown[] = [];
  const adapter = new ClaudeAdapter({ notification: async (message: unknown) => { notifications.push(message); } } as unknown as Server);
  await adapter.prepare();
  await adapter.deliver({ messageId: "message-id", channelId: "channel-id", sender: { id: "logical-id", name: "reviewer" },
    senderAccountId: "shared-account", text: "Inspect this", recipient: "me", createdAt: 1000,
    attachments: [{ id: "attachment", name: "result.txt", url: "https://cdn.discordapp.com/result.txt", size: 10 }] });
  const notification = notifications[0] as { method: string; params: { content: string } };
  assert.equal(notification.method, "notifications/claude/channel");
  assert.deepEqual(notification.params, { content: '<sideband sender="reviewer">\nInspect this\n</sideband>' });
});
