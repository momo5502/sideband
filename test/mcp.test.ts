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
      SIDEBAND_STATE_DIR: directory, SIDEBAND_CLAUDE_SERVER: "", SIDEBAND_CLAUDE_PASSWORD: "", CODEX_BIN: "not-a-real-codex-command" },
  });
  return { transport, client: new Client({ name: "test", version: "1" }) };
}
test("direct MCP joins connect once, create missing rooms, reuse identity and need no Claude confirmation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sideband-direct-join-"));
  const server = await RoomServer.start({ host: "127.0.0.1", port: 0 });
  const profile = { server: `127.0.0.1:${server.port}`, password: server.password };
  await new RoomProfiles(directory).save("only-server", profile);
  const { transport, client } = mcp("claude", directory);
  const observer = new RoomClient(profile);
  const read = (result: any) => { assert.equal(result.isError, undefined, JSON.stringify(result.content)); return JSON.parse(result.content[0].text); };
  try {
    await client.connect(transport); await observer.connect();
    const call = (name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args });
    assert.deepEqual(read(await call("sideband_status")), { state: "off" });
    assert.deepEqual(await observer.listRooms(), []);
    for (const name of [undefined, "", "   "]) {
      const rejected = await call("sideband_join_room", { room: "New-Room", ...(name === undefined ? {} : { name }) });
      assert.equal(rejected.isError, true); assert.match(JSON.stringify(rejected.content), /Ask the user to choose one/);
      assert.deepEqual(read(await call("sideband_status")), { state: "off" });
    }
    const browsing = await call("sideband_rooms");
    assert.equal(browsing.isError, true); assert.match(JSON.stringify(browsing.content), /Ask the user to choose one/);
    assert.deepEqual(read(await call("sideband_status")), { state: "off" });
    const joined = (await Promise.all([
      call("sideband_join_room", { room: "New-Room", name: "worker" }),
      call("sideband_join_room", { room: "new-room", name: "worker" }),
    ])).map(read);
    assert.equal(joined[0].id, joined[1].id);
    assert.equal((await observer.listRooms())[0]!.members, 1, "concurrent joins use one connection/identity");
    const first = read(await call("sideband_status"));
    assert.equal(first.identity.name, "worker"); assert.equal(first.state, "on");
    assert.equal(read(await call("sideband_rooms"))[0].id, joined[0].id);
    assert.equal((await call("sideband_join_room", { room: "other", profile: "different", name: "worker" })).isError, true);
    assert.equal((await call("sideband_join_room", { room: "other", name: "different" })).isError, true);
    const unnamed = await call("sideband_join_room", { room: "other" });
    assert.equal(unnamed.isError, true); assert.match(JSON.stringify(unnamed.content), /Ask the user to choose one/);
    assert.equal(read(await call("sideband_status")).room.id, joined[0].id);
    const switched = read(await call("sideband_join_room", { room: "another-room", name: "worker" }));
    assert.notEqual(switched.id, joined[0].id); assert.deepEqual(read(await call("sideband_history")), []);
    assert.equal(read(await call("sideband_status")).identity.id, first.identity.id);
    assert.deepEqual((await observer.listRooms()).map(room => room.name), ["another-room"]);
    read(await call("sideband_leave_room")); assert.equal(read(await call("sideband_status")).state, "on");
    assert.deepEqual(await observer.listRooms(), []);
    read(await call("sideband_join_room", { room: "again", name: "worker" }));
    assert.equal(read(await call("sideband_status")).identity.id, first.identity.id);
    read(await call("sideband_deactivate"));
    read(await call("sideband_join_room", { room: "again", name: "worker" }));
    assert.notEqual(read(await call("sideband_status")).identity.id, first.identity.id);
  } finally { await client.close(); await observer.close(); await server.close(); await rm(directory, { recursive: true, force: true }); }
});

test("multiple saved servers require selection in the connecting call, without a separate activation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sideband-select-server-"));
  const first = await RoomServer.start({ host: "127.0.0.1", port: 0, statusPort: 0 });
  const second = await RoomServer.start({ host: "127.0.0.1", port: 0, statusPort: 0 });
  const profiles = new RoomProfiles(directory);
  await profiles.save("first", { server: `127.0.0.1:${first.port}`, password: first.password });
  await profiles.save("second", { server: `127.0.0.1:${second.port}`, password: second.password });
  const { transport, client } = mcp("claude", directory);
  const read = (result: any) => { assert.equal(result.isError, undefined, JSON.stringify(result.content)); return JSON.parse(result.content[0].text); };
  try {
    await client.connect(transport);
    const call = (name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args });
    const ambiguous = await call("sideband_join_room", { room: "work", name: "worker" });
    assert.equal(ambiguous.isError, true); assert.match(JSON.stringify(ambiguous.content), /Multiple saved servers: first, second/);
    assert.deepEqual(read(await call("sideband_status")), { state: "off" });
    assert.deepEqual(read(await call("sideband_rooms", { profile: "second", name: "worker" })), []);
    const identity = read(await call("sideband_status")).identity;
    assert.equal(identity.name, "worker"); assert.match(identity.id, /^agent-/);
    const room = read(await call("sideband_join_room", { room: "work", name: "worker" }));
    assert.equal(read(await call("sideband_status")).identity.id, identity.id);
    assert.deepEqual(await (await fetch(`http://127.0.0.1:${first.statusPort}/status.json`)).json(), { rooms: 0, connectedParticipants: 0 });
    assert.deepEqual(await (await fetch(`http://127.0.0.1:${second.statusPort}/status.json`)).json(), { rooms: 1, connectedParticipants: 1 });
    assert.equal((await call("sideband_join_room", { room: "work", profile: "first", name: "worker" })).isError, true);
    read(await call("sideband_deactivate"));
    const other = read(await call("sideband_join_room", { room: "work", profile: "first", name: "worker" }));
    assert.notEqual(other.id, room.id);
  } finally { await client.close(); await first.close(); await second.close(); await rm(directory, { recursive: true, force: true }); }
});
for (const harness of ["codex", "claude"]) {
  test(`actual ${harness} MCP stdio handshake is default-off and rejects sender/credential injection`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "sideband-mcp-")); const { transport, client } = mcp(harness, directory);
    let stderr = ""; transport.stderr?.on("data", (data) => { stderr += data; });
    try {
      await client.connect(transport);
      const listed = await client.listTools(); assert.equal(listed.tools.length, 10);
      assert.ok(!listed.tools.some(tool => ["sideband_activate", "sideband_create_room"].includes(tool.name)));
      assert.ok(listed.tools.every(tool => !("claude_channel_enabled" in (tool.inputSchema.properties ?? {}))));
      assert.ok(listed.tools.every((tool) => !("password" in (tool.inputSchema.properties ?? {}))));
      assert.ok(listed.tools.find(tool => tool.name === "sideband_join_room")!.inputSchema.required!.includes("name"));
      assert.equal(client.getServerCapabilities()?.experimental?.["claude/channel"] !== undefined, harness === "claude");
      const call = (name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args, _meta: { threadId: "thread-one" } });
      assert.deepEqual((await call("sideband_status")).content, [{ type: "text", text: '{"state":"off"}' }]);
      assert.deepEqual((await call("sideband_profiles")).content, [{ type: "text", text: '{"profiles":[]}' }]);
      assert.equal((await call("sideband_send", { text: "hello" })).isError, true);
      assert.equal((await call("sideband_send", { text: "hello", sender: "alice" })).isError, true);
      assert.equal((await call("sideband_join_room", { room: "work", password: "do-not-use" })).isError, true);
      const missing = await call("sideband_join_room", { room: "work" });
      assert.equal(missing.isError, true); assert.match(JSON.stringify(missing.content), /Ask the user to choose one/);
      const unconfigured = await call("sideband_join_room", { room: "work", name: "chosen" });
      assert.equal(unconfigured.isError, true); assert.match(JSON.stringify(unconfigured.content), /No saved server/);
      await new RoomProfiles(directory).save("fixture", { server: "127.0.0.1:1", password: `sb1.${"a".repeat(43)}.${"b".repeat(43)}` });
      const anonymousBrowse = await call("sideband_rooms");
      assert.equal(anonymousBrowse.isError, true); assert.match(JSON.stringify(anonymousBrowse.content), /Ask the user to choose one/);
      assert.deepEqual((await call("sideband_status")).content, [{ type: "text", text: '{"state":"off"}' }]);
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
    await client.connect(transport); await sender.connect(); const room = await sender.joinRoom("mcp-push");
    const call = (name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args });
    assert.equal((await call("sideband_join_room", { room: room.id, name: "receiver" })).isError, undefined);
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
