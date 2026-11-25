import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PluginPresence, readPluginPresence, presenceKey } from "../src/plugin-presence.js";
import { requestPlugin, type PluginEndpoint } from "../src/plugin-control.js";
import { testTimeout } from "./waits.js";

test("plugin commands require a private token and an exact current session; public discovery never exposes credentials", { timeout: testTimeout(30000) }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "sideband-plugin-control-")); let calls = 0;
  const plugin = new PluginPresence("pi", dir, async (session, command) => { calls++; return { session, action: command.action }; });
  try {
    plugin.replace([{ session: "first" }]); await plugin.idle();
    const endpoints = new Map<string, PluginEndpoint>(), rows = await readPluginPresence(dir, undefined, undefined, endpoints), key = rows[0]!.key;
    assert.equal(rows[0]!.interactive, true); const endpoint = endpoints.get(key)!;
    assert.doesNotMatch(JSON.stringify(rows), new RegExp(endpoint.token));
    const frame = JSON.parse(await readFile(join(dir, (await readdir(dir)).find(name => name.endsWith(".json"))!), "utf8"));
    assert.equal(frame.sessions[0].interactive, undefined, "old workers still understand the public rows");
    await assert.rejects(requestPlugin({ ...endpoint, token: "x".repeat(43) }, { key, action: "prompt", text: "must not deliver" }), /Unauthenticated/); assert.equal(calls, 0);
    await assert.rejects(requestPlugin(endpoint, { key: "0".repeat(64), action: "prompt", text: "wrong session" }), /changed or closed/); assert.equal(calls, 0);
    assert.deepEqual(await requestPlugin(endpoint, { key, action: "prompt", text: "hello" }), { session: "first", action: "prompt" }); assert.equal(calls, 1);
    plugin.replace([{ session: "second" }]); await plugin.idle();
    await assert.rejects(requestPlugin(endpoint, { key, action: "prompt", text: "stale" }), /changed or closed/); assert.equal(calls, 1);
    assert.deepEqual(await requestPlugin(endpoint, { key: presenceKey("pi", "second"), action: "logs" }), { session: "second", action: "logs" });
    await plugin.close(); await assert.rejects(requestPlugin(endpoint, { key, action: "prompt", text: "closed" }), /reachable|connection lost/i);
  } finally { await plugin.close(); await rm(dir, { recursive: true, force: true }); }
});
