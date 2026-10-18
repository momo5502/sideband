import test from "node:test";
import assert from "node:assert/strict";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { ClaudeAdapter } from "../src/adapters/claude.js";

test("Claude native channel notification keeps account, agent and channel IDs distinct", async () => {
  const notifications: unknown[] = [];
  const adapter = new ClaudeAdapter({ notification: async (message: unknown) => { notifications.push(message); } } as unknown as Server);
  await adapter.prepare();
  await adapter.deliver({ messageId: "message-id", channelId: "channel-id", sender: { id: "logical-id", name: "reviewer" },
    senderAccountId: "shared-account", text: "Inspect this", recipient: "me", createdAt: 1000,
    attachments: [{ id: "attachment", name: "result.txt", url: "https://cdn.discordapp.com/result.txt", size: 10 }] });
  const notification = notifications[0] as { method: string; params: { content: string; meta: Record<string, string> } };
  assert.equal(notification.method, "notifications/claude/channel");
  assert.equal(notification.params.content, "Inspect this");
  assert.equal(notification.params.meta.chat_id, "channel-id");
  assert.equal(notification.params.meta.user_id, "shared-account");
  assert.equal(notification.params.meta.agent_id, "logical-id");
  assert.equal(notification.params.meta.recipient_id, "me");
  assert.ok(Object.values(notification.params.meta).every((value) => typeof value === "string"));
  assert.equal(JSON.parse(notification.params.meta.attachments!)[0].id, "attachment");
});
