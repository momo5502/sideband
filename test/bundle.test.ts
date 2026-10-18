import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, copyFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { NotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { RoomServer } from "../src/room-server.js";
import { RoomClient } from "../src/room-client.js";

test("standalone plugin runs without node_modules and uses native Claude credentials without exposing them", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sideband-bundle-"));
  const entry = join(directory, "sideband.cjs");
  await copyFile(resolve("dist/sideband.cjs"), entry);
  const server = await RoomServer.start({ host: "127.0.0.1", port: 0 });
  const profile = { server: `127.0.0.1:${server.port}`, password: server.password };
  const sender = new RoomClient(profile, "peer");
  const client = new Client({ name: "bundle-check", version: "1" });
  const env = { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
    NODE_PATH: "", SIDEBAND_STATE_DIR: join(directory, "state"), SIDEBAND_CLAUDE_SERVER: profile.server, SIDEBAND_CLAUDE_PASSWORD: profile.password };
  let timer: NodeJS.Timeout | undefined;
  try {
    const help = spawnSync(process.execPath, [entry, "--help"], { cwd: directory, env, encoding: "utf8", windowsHide: true });
    assert.equal(help.status, 0, help.stderr); assert.match(help.stdout, /sideband login IP:port/);
    assert.match(help.stdout, /sideband \[chat\]/);
    const chat = spawnSync(process.execPath, [entry, "chat"], { cwd: directory, env, encoding: "utf8", windowsHide: true });
    assert.equal(chat.status, 1); assert.match(chat.stderr, /interactive terminal/);
    const rejected = spawnSync(process.execPath, [entry, "login", profile.server], { cwd: directory, env, encoding: "utf8", windowsHide: true });
    assert.equal(rejected.status, 1); assert.match(rejected.stderr, /interactive terminal/);
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [entry, "mcp", "--harness", "claude"], cwd: directory, env }));
    const call = (name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args });
    assert.deepEqual((await call("sideband_status")).content, [{ type: "text", text: '{"state":"off"}' }]);
    const names = await call("sideband_profiles");
    assert.deepEqual(names.content, [{ type: "text", text: '{"profiles":["claude"]}' }]);
    assert.ok(!JSON.stringify(names).includes(server.password));
    await sender.connect(); const room = await sender.createRoom("standalone");
    assert.equal((await call("sideband_activate", { profile: "claude", claude_channel_enabled: true })).isError, undefined);
    assert.equal((await call("sideband_join_room", { room: room.id })).isError, undefined);
    const arrived = new Promise<unknown>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error("Missing standalone notification")), 4000);
      client.setNotificationHandler(NotificationSchema.extend({ method: z.literal("notifications/claude/channel") }), notification => resolve(notification.params));
    });
    await sender.send("Bundled client works");
    assert.deepEqual(await arrived, { content: '<sideband sender="peer">\nBundled client works\n</sideband>' });
  } finally {
    if (timer) clearTimeout(timer);
    await client.close(); await sender.close(); await server.close(); await rm(directory, { recursive: true, force: true });
  }
});
