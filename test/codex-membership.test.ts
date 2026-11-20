import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { CodexMembership } from "../src/codex-membership.js";
import { RoomProfiles } from "../src/room-profiles.js";
import { RoomClient } from "../src/room-client.js";
import { RoomServer } from "../src/room-server.js";
import { testTimeout } from "./waits.js";
import type { ToolResult } from "../src/room-tools.js";

const value = (result: ToolResult): any => { assert.ok(!result.isError, result.content[0]?.text); return JSON.parse(result.content[0]!.text); };
const until = async (check: () => boolean | Promise<boolean>) => { const end = Date.now() + testTimeout(10000); while (!await check()) { if (Date.now() > end) throw new Error("Membership did not settle."); await new Promise(r => setTimeout(r, 10)); } };

test("MCP replacement restores only exact loaded opted-in threads and their verified identities", { timeout: testTimeout(30000) }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "sideband-membership-")), server = await RoomServer.start({ host: "127.0.0.1", port: 0 });
  const profile = { server: `127.0.0.1:${server.port}`, password: server.password }, profiles = new RoomProfiles(directory), sender = new RoomClient(profile, "human");
  let loaded = ["one", "two"], epoch = 0; const deliveries: { key: string; text: string }[] = [];
  const options = { loaded: async () => loaded, adapter: async (key: string) => { const connectedEpoch = epoch; return { prepare: async () => { if (connectedEpoch !== epoch || !loaded.includes(key)) throw new Error("Not loaded"); }, close: async () => {}, deliver: async (d: { text: string }) => { deliveries.push({ key, text: d.text }); } }; } };
  let first: CodexMembership | undefined, next: CodexMembership | undefined, duplicate: CodexMembership | undefined;
  try {
    await profiles.save("local", profile); await sender.connect(); await sender.joinRoom("work");
    first = await CodexMembership.open(profiles, options);
    value(await first.call("one", "sideband_join_room", { name: "main", room: "work" }));
    value(await first.call("two", "sideband_join_room", { name: "other", room: "another" }));
    const id = value(await first.call("one", "sideband_status", {})).identity.id;
    await first.close(); first = undefined;
    loaded = ["unrelated"]; next = await CodexMembership.open(profiles, options); await next.reconcile();
    assert.deepEqual((await sender.members()).map(m => m.name), ["human"], "never guesses the sole loaded thread or starts a saved one");
    loaded = ["one"]; await Promise.all([next.reconcile(), next.reconcile()]);
    assert.equal(value(await next.call("one", "sideband_status", {})).identity.id, id);
    assert.deepEqual((await sender.members()).map(m => m.name).sort(), ["human", "main"]);
    await sender.send("after replacement"); await until(() => deliveries.some(d => d.key === "one" && d.text === "after replacement"));
    assert.ok(!deliveries.some(d => d.key === "two" && d.text === "after replacement"));
    epoch++; await next.reconcile(); assert.equal(value(await next.call("one", "sideband_status", {})).identity.id, id, "a dead daemon adapter is replaced even when MCP survives");
    duplicate = await CodexMembership.open(profiles, options); await duplicate.reconcile();
    assert.equal((await duplicate.call("one", "sideband_send", { text: "duplicate" })).isError, true, "only one MCP process owns the thread");
    assert.equal((await next.call("one", "sideband_deactivate", { invalid: true })).isError, true);
    await next.reconcile(); assert.equal(value(await next.call("one", "sideband_status", {})).identity.id, id, "invalid calls cannot delete recovery intent");
    value(await next.call("one", "sideband_leave_room", {})); await next.close(); next = await CodexMembership.open(profiles, options); await next.reconcile();
    assert.deepEqual(value(await next.call("one", "sideband_status", {})), { state: "off" }, "explicit leave persists across replacement");
    value(await next.call("one", "sideband_join_room", { name: "main", room: "work" }));
    assert.equal(value(await next.call("one", "sideband_status", {})).identity.id, id, "leaving retains the chosen identity for a later explicit join");
    value(await next.call("one", "sideband_deactivate", {})); await next.close(); next = await CodexMembership.open(profiles, options); await next.reconcile();
    assert.deepEqual(value(await next.call("one", "sideband_status", {})), { state: "off" });
    value(await next.call("one", "sideband_join_room", { name: "main", room: "work" }));
    assert.notEqual(value(await next.call("one", "sideband_status", {})).identity.id, id, "explicit deactivate retires the saved identity");
  } finally { await duplicate?.close(); await next?.close(); await first?.close(); await sender.close(); await server.close(); assert.ok(directory.startsWith(join(tmpdir(), "sideband-membership-"))); await rm(directory, { recursive: true, force: true }); }
});

test("a crashed MCP owner is reclaimed without changing its identity; changed server identity requires explicit join", { timeout: testTimeout(30000) }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "sideband-membership-crash-")), server = await RoomServer.start({ host: "127.0.0.1", port: 0 });
  const profiles = new RoomProfiles(directory), profile = { server: `127.0.0.1:${server.port}`, password: server.password };
  await profiles.save("local", profile);
  const child = spawn(process.execPath, ["--input-type=module", "-e", `
    import {CodexMembership} from ${JSON.stringify(pathToFileURL(resolve("dist/src/codex-membership.js")).href)};
    import {RoomProfiles} from ${JSON.stringify(pathToFileURL(resolve("dist/src/room-profiles.js")).href)};
    const owner = await CodexMembership.open(new RoomProfiles(process.argv[1]), {adapter:async()=>({prepare:async()=>{},close:async()=>{},deliver:async()=>{}})});
    const result=await owner.call('crashed','sideband_join_room',{name:'main',room:'work'});
    if(result.isError)throw Error(result.content[0].text);
    console.log(JSON.stringify(owner.tools.status('crashed')));setInterval(()=>{},60000);
  `, directory], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let output = "", errors = "", manager: CodexMembership | undefined; child.stdout.on("data", b => output += b); child.stderr.on("data", b => errors += b);
  const exited = new Promise(resolve => child.once("exit", resolve));
  try {
    await until(() => !!output.trim() || child.exitCode !== null); assert.ok(output.trim(), errors);
    const id = JSON.parse(output.trim()).identity.id; child.kill(); await exited;
    const options = { loaded: async () => ["crashed"], adapter: async () => ({ prepare: async () => {}, close: async () => {}, deliver: async () => {} }) };
    manager = await CodexMembership.open(profiles, options); await manager.reconcile();
    assert.equal(value(await manager.call("crashed", "sideband_status", {})).identity.id, id);
    await manager.close(); manager = undefined;
    await profiles.save("local", { ...profile, password: `sb1.${"a".repeat(43)}.${"b".repeat(43)}` });
    manager = await CodexMembership.open(profiles, options); await manager.reconcile();
    const result = await manager.call("crashed", "sideband_status", {}); assert.equal(result.isError, true); assert.match(result.content[0]!.text, /identity changed/);
  } finally { if (child.exitCode === null && child.signalCode === null) child.kill(); await exited; await manager?.close(); await server.close(); assert.ok(directory.startsWith(join(tmpdir(), "sideband-membership-crash-"))); await rm(directory, { recursive: true, force: true }); }
});
