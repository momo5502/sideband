import test from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { NotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { RoomProfiles } from "../src/room-profiles.js";
import { LocalSetup } from "../src/local-setup.js";
import { RoomServer } from "../src/room-server.js";
import { RoomClient } from "../src/room-client.js";

test("local setup form saves credentials outside chat, with one-use links and origin checks", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sideband-setup-"));
  const store = new RoomProfiles(directory); const setup = new LocalSetup(store);
  const server = await RoomServer.start({ host: "127.0.0.1", port: 0 });
  try {
    const { url } = await setup.start("work", `127.0.0.1:${server.port}`);
    const page = await fetch(url); assert.equal(page.status, 200);
    assert.match(await page.text(), /type="password"/);
    assert.match(page.headers.get("content-security-policy")!, /frame-ancestors 'none'/);
    const body = new URLSearchParams({ server: `127.0.0.1:${server.port}`, password: server.password });
    const bad = await fetch(url, { method: "POST", headers: { Origin: "https://evil.example" }, body }); assert.equal(bad.status, 403);
    assert.deepEqual(await store.names(), []);
    const good = await fetch(url, { method: "POST", headers: { Origin: new URL(url).origin }, body }); assert.equal(good.status, 200);
    assert.deepEqual(await store.names(), ["work"]); assert.equal((await store.load("work")).password, server.password);
    assert.equal((await fetch(url)).status, 404);
    await assert.rejects(store.save("../escape", { server: "localhost", password: server.password }), /Invalid/);
  } finally { await setup.close(); await server.close(); await rm(directory, { recursive: true, force: true }); }
});
function mcp(harness: string, directory: string) {
  const transport = new StdioClientTransport({
    command: process.execPath, args: [resolve("dist/src/cli.js"), "mcp", "--harness", harness], stderr: "pipe",
    env: { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
      SIDEBAND_STATE_DIR: directory, CODEX_BIN: "not-a-real-codex-command" },
  });
  return { transport, client: new Client({ name: "test", version: "1" }) };
}
for (const harness of ["codex", "claude"]) {
  test(`actual ${harness} MCP stdio handshake is default-off and rejects sender/credential injection`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "sideband-mcp-")); const { transport, client } = mcp(harness, directory);
    let stderr = ""; transport.stderr?.on("data", (data) => { stderr += data; });
    try {
      await client.connect(transport);
      const listed = await client.listTools(); assert.equal(listed.tools.length, 12);
      assert.ok(listed.tools.every((tool) => !("password" in (tool.inputSchema.properties ?? {}))));
      assert.equal(client.getServerCapabilities()?.experimental?.["claude/channel"] !== undefined, harness === "claude");
      const call = (name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args, _meta: { threadId: "thread-one" } });
      assert.deepEqual((await call("sideband_status")).content, [{ type: "text", text: '{"state":"off"}' }]);
      assert.deepEqual((await call("sideband_profiles")).content, [{ type: "text", text: '{"profiles":[]}' }]);
      assert.equal((await call("sideband_send", { text: "hello" })).isError, true);
      assert.equal((await call("sideband_send", { text: "hello", sender: "alice" })).isError, true);
      assert.equal((await call("sideband_activate", { profile: "work", password: "do-not-use" })).isError, true);
      if (harness === "codex") assert.equal((await client.callTool({ name: "sideband_status", arguments: {} })).isError, true);
      assert.equal(stderr, "", "off-state must not spawn the invalid Codex helper");
    } finally { await client.close(); await rm(directory, { recursive: true, force: true }); }
  });
}
test("end-to-end TLS broadcast reaches an MCP native channel notification with no history polling", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sideband-push-"));
  const server = await RoomServer.start({ host: "127.0.0.1", port: 0 });
  const profile = { server: `127.0.0.1:${server.port}`, password: server.password };
  await new RoomProfiles(directory).save("local", profile);
  const { transport, client } = mcp("claude", directory);
  const sender = new RoomClient(profile, "sender");
  const visitor = new RoomClient(profile, "visitor");
  const notifications: any[] = [];
  let timer: NodeJS.Timeout | undefined;
  try {
    client.setNotificationHandler(NotificationSchema.extend({ method: z.literal("notifications/claude/channel") }), (notification) => { notifications.push(notification); });
    await client.connect(transport); await sender.connect(); const room = await sender.createRoom("mcp-push");
    const call = (name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args });
    assert.equal((await call("sideband_activate", { profile: "local", name: "receiver", claude_channel_enabled: true })).isError, undefined);
    assert.equal((await call("sideband_join_room", { room: room.id })).isError, undefined);
    const arrived = new Promise<void>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error("No pushed MCP notification")), 4000);
      const interval = setInterval(() => { if (notifications.length) { clearInterval(interval); resolve(); } }, 10);
      interval.unref();
    });
    await sender.send("Pushed from a real WebSocket peer");
    await arrived;
    assert.equal(notifications.length, 1);
    assert.deepEqual(notifications[0].params, { content: '<sideband sender="sender">\nPushed from a real WebSocket peer\n</sideband>' });
    await visitor.connect(); await visitor.joinRoom(room.id); await visitor.close();
    const deadline = Date.now() + 4000;
    while (notifications.length < 3 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.deepEqual(notifications.slice(1).map(notification => notification.params), [
      { content: '<sideband event="joined" participant="visitor" />' },
      { content: '<sideband event="left" participant="visitor" />' },
    ]);
    await call("sideband_deactivate");
    assert.equal((await sender.members()).length, 1);
  } finally {
    if (timer) clearTimeout(timer);
    await client.close(); await visitor.close(); await sender.close(); await server.close(); await rm(directory, { recursive: true, force: true });
  }
});
