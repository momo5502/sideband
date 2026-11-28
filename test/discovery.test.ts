import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { PluginPresence, presenceKey, presenceDirectory, readPluginPresence, PRESENCE_TTL_MS } from "../src/plugin-presence.js";
import { RoomServer } from "../src/room-server.js";
import { RoomClient } from "../src/room-client.js";
import { Worker } from "../src/worker.js";
import { CodexMembership } from "../src/codex-membership.js";
import { RoomProfiles } from "../src/room-profiles.js";
import { browserPage, until } from "./browser-fixture.js";
import { testTimeout } from "./waits.js";
import { BrowserRoomClient } from "../src/browser-protocol.js";
import NodeWebSocket from "ws";
import sideband, { type OmpApi, type OmpContext } from "../src/omp-extension.js";
import piSideband from "../src/pi-extension.js";
import * as zod from "zod/v4";
import type { AgentStore } from "../src/persistence.js";

test("plugin presence projects private metadata, checks birth/heartbeat and removes closed sessions", { timeout: testTimeout(30000) }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "sideband-presence-")), plugin = new PluginPresence("pi", directory);
  try {
    const privateSession = join(directory, "private-session-file.jsonl");
    plugin.replace([{ session: privateSession, workspace: join(directory, "private-parent", "project"), name: "manual" }]); await plugin.idle();
    let rows = await readPluginPresence(directory); assert.equal(rows.length, 1); assert.equal(rows[0]!.workspace, "project"); assert.equal(rows[0]!.key, presenceKey("pi", privateSession));
    const file = join(directory, (await readdir(directory)).find(name => name.endsWith(".json"))!), text = await readFile(file, "utf8"), frame = JSON.parse(text);
    assert.doesNotMatch(text, /private-parent|private-session-file|password|commandLine/);
    assert.deepEqual(await readPluginPresence(directory, async () => "reused-pid"), [], "a live PID with a different birth stamp is not this plugin");
    await writeFile(file, JSON.stringify({ ...frame, at: Date.now() - PRESENCE_TTL_MS - 1 })); assert.deepEqual(await readPluginPresence(directory), []);
    await writeFile(file, JSON.stringify({ ...frame, sessions: [{ ...frame.sessions[0], commandLine: "must not export" }, frame.sessions[0]] })); rows = await readPluginPresence(directory); assert.equal(rows.length, 1, "invalid rows do not suppress good rows");
    plugin.replace([{ session: "next", workspace: "/different/project" }]); await plugin.idle(); assert.notEqual((await readPluginPresence(directory))[0]!.key, frame.sessions[0].key);
    await plugin.close(); assert.deepEqual(await readPluginPresence(directory), []); assert.deepEqual(await readdir(directory), []);
  } finally { await plugin.close(); await rm(directory, { recursive: true, force: true }); }
});

test("discovered agents are authenticated, transient, deduplicated across workers and view-only in the browser", { timeout: testTimeout(30000) }, async () => {
  const server = await RoomServer.start({ host: "127.0.0.1", port: 0, statusPort: 0 }), profile = { server: `127.0.0.1:${server.port}`, password: server.password };
  const first = new RoomClient(profile), second = new RoomClient(profile), peer = new RoomClient(profile, "peer"); let page: Awaited<ReturnType<typeof browserPage>> | undefined;
  const origin = `http://127.0.0.1:${server.statusPort}`, web = new BrowserRoomClient(`ws://127.0.0.1:${server.statusPort}/browser-ws`, server.password, "controller", undefined, url => new NodeWebSocket(url, { origin }) as unknown as WebSocket);
  const row = { key: presenceKey("claude", "session"), harness: "claude", name: "Claude", pid: process.pid, workspace: "project", createdAt: Date.now() };
  try {
    await first.connect(); await second.connect(); await peer.connect();
    await assert.rejects(peer.request("control.discovered", { sessions: [row] }), /registered worker/);
    for (const [client, name] of [[first, "first"], [second, "second"]] as const) {
      const registered = await client.request<any>("control.worker", { machine: { id: randomUUID(), name, platform: "test", harnesses: [] } }); assert.equal(registered.capabilities.discovery, true);
      await client.request("control.discovered", { sessions: [row] });
    }
    await assert.rejects(first.request("control.discovered", { sessions: [{ ...row, workspace: "/private/path" }] }), /Invalid discovered/);
    await web.connect(); await assert.rejects(web.request("control.discovered", { sessions: [row] }), /registered worker/);
    page = await browserPage(server); await page.login(); await page.agents();
    await until(() => page!.doc.querySelectorAll("#agent-list [data-agent-id]").length === 1);
    const button = page.get<HTMLButtonElement>("#agent-list [data-agent-id]"), id = button.dataset.agentId!; assert.match(button.textContent!, /External/);
    page.click(button); await until(() => !!page!.doc.querySelector("#external-agent"));
    assert.equal(page.doc.querySelector("#agent-prompt"), null); assert.equal(page.doc.querySelector('[aria-label="Agent actions"]'), null); assert.equal(page.doc.querySelector('[role="alert"]'), null);
    for (const action of ["prompt", "interrupt", "stop", "resume", "room", "dispose", "archive"]) {
      await assert.rejects(web.request("control.action", { agentId: id, action, ...(action === "prompt" ? { text: "must not deliver" } : {}), ...(action === "room" ? { room: "must not join" } : {}) }), /view-only/);
    }
    assert.deepEqual((await web.request<any>("control.watch", { agentId: id })).events, []);
    await page.agents(); await first.request("control.discovered", { sessions: [] }); await until(() => page!.get("#agent-list").textContent?.includes("second") === true);
    assert.equal(page.get<HTMLButtonElement>("#agent-list [data-agent-id]").dataset.agentId, id, "session IDs do not depend on which local worker reported them");
    await second.close(); await until(() => page!.doc.querySelectorAll("#agent-list [data-agent-id]").length === 0);
    assert.deepEqual(await peer.listRooms(), [], "discovery never joins a room");
  } finally { web.disconnect(); await page?.close(); await Promise.all([first.close(), second.close(), peer.close()]); await server.close(); }
});

test("a local worker finds plugin sessions without room membership and discovery is off the connection path", { timeout: testTimeout(30000) }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "sideband-discovery-worker-")), plugin = new PluginPresence("omp", presenceDirectory, async () => ({ accepted: true }));
  const server = await RoomServer.start({ host: "127.0.0.1", port: 0, statusPort: 0 });
  const worker = new Worker({ profile: { server: `127.0.0.1:${server.port}`, password: server.password }, root: directory, entry: resolve("dist/src/cli.js") });
  const request = worker.client.request.bind(worker.client); let reports = 0, fail = false, found = false;
  worker.client.request = async (method, params) => {
    if (method === "control.worker") { const result = await request<any>(method, params); delete result.capabilities.discoveryControl; return result; }
    if (method === "control.discovered") {
      reports++; assert.ok((params as any).sessions.every((row: any) => !("interactive" in row)), "an older server is never sent control capabilities");
      found ||= (params as any).sessions.some((row: any) => row.key === presenceKey("omp", "manual-omp")); if (fail) throw new Error("Optional discovery failed");
    }
    return request(method, params) as never;
  };
  try {
    plugin.replace([{ session: "manual-omp", workspace: directory }]); await plugin.idle(); await worker.start(); assert.equal(worker.client.state, "on");
    await until(() => reports > 0); assert.equal(found, true, "worker reports the locally discovered session");
    const scheduler = worker as unknown as { discover(): void; discovering?: Promise<void>; store: AgentStore }; await scheduler.discovering;
    const id = randomUUID(), registry = scheduler.store.registry;
    await registry.change(() => registry.put("agent", id, { agent: { id, harness: "omp", name: "saved", machineId: worker.machine.id, machineName: worker.machine.name, state: "stopped", online: false, room: "", createdAt: Date.now() }, session: "manual-omp", workspaceReady: false, privateKey: "synthetic", desired: "archived", updatedAt: Date.now() }));
    found = false; scheduler.discover(); await scheduler.discovering; assert.equal(found, true, "an archived record cannot hide a session reopened by hand");
    await registry.change(() => registry.put("lease", id, { owner: "synthetic", pid: process.pid, started: "", at: Date.now() }));
    found = false; scheduler.discover(); await scheduler.discovering; assert.equal(found, false, "a live managed controller suppresses its duplicate");
    fail = true; scheduler.discover(); await scheduler.discovering;
    assert.equal(worker.client.state, "on");
  } finally { await plugin.close(); await worker.close(); await server.close(); await rm(directory, { recursive: true, force: true }); }
});

test("manual OMP and PI publish before joining, replace sessions and retire old extension runtimes", { timeout: testTimeout(30000) }, async () => {
  for (const harness of ["omp", "pi"] as const) {
    let session = `${harness}-first`;
    const make = () => {
      const handlers = new Map<string, Function[]>();
      const api = { zod, registerTool() {}, registerCommand() {}, on: (name: string, fn: Function) => handlers.set(name, [...(handlers.get(name) ?? []), fn]), sendMessage() {} };
      const ctx: OmpContext = { mode: "tui", hasUI: true, cwd: "/private/project", sessionManager: { getSessionId: () => session, getSessionFile: () => `/private/${session}.jsonl` }, ui: { input: async () => undefined, select: async () => undefined, notify() {} } };
      if (harness === "omp") sideband(api as OmpApi); else piSideband(api);
      return { emit: async (event: string) => { for (const handler of handlers.get(event) ?? []) await handler({}, ctx); } };
    };
    let host = make(); const child = make();
    try {
      await host.emit("session_start"); await child.emit("session_start");
      await until(async () => (await readPluginPresence()).some(row => row.key === presenceKey(harness, `/private/${session}.jsonl`)));
      assert.equal((await readPluginPresence()).filter(row => row.harness === harness).length, 1, "same-process subagent factories do not publish twice");
      await child.emit("session_shutdown");
      if (harness === "omp") { session = "omp-switched"; await host.emit("session_switch"); }
      else { await host.emit("session_shutdown"); session = "pi-reloaded"; host = make(); await host.emit("session_start"); }
      await until(async () => { const rows = (await readPluginPresence()).filter(row => row.harness === harness); return rows.length === 1 && rows[0]!.key === presenceKey(harness, `/private/${session}.jsonl`); });
      await host.emit("session_shutdown"); assert.equal((await readPluginPresence()).filter(row => row.harness === harness).length, 0);
    } finally { await child.emit("session_shutdown"); await host.emit("session_shutdown"); }
  }
});

test("Codex reports exact loaded sessions before any room join and removes unloaded sessions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sideband-discovery-codex-")); let loaded = ["one", "two"], observed: { id: string }[] = [], unavailable = false;
  const membership = await CodexMembership.open(new RoomProfiles(directory), { loaded: async () => { if (unavailable) throw new Error("offline"); return loaded; }, presence: rows => { observed = rows; }, adapter: async () => { throw new Error("Discovery must never prepare a room adapter"); } });
  try {
    await membership.reconcile(); assert.deepEqual(observed.map(row => row.id), ["one", "two"]); assert.deepEqual(membership.tools.status("one"), { state: "off" });
    loaded = ["two"]; await membership.reconcile(); assert.deepEqual(observed.map(row => row.id), ["two"]);
    unavailable = true; await membership.reconcile(); assert.deepEqual(observed, []);
  } finally { await membership.close(); await rm(directory, { recursive: true, force: true }); }
});

test("external PI and OMP sessions accept web instructions and return live output through the owning worker", { timeout: testTimeout(45000) }, async () => {
  for (const harness of ["pi", "omp"] as const) {
    const directory = await mkdtemp(join(tmpdir(), "sideband-external-web-"));
    const server = await RoomServer.start({ host: "127.0.0.1", port: 0, statusPort: 0 });
    const worker = new Worker({ profile: { server: `127.0.0.1:${server.port}`, password: server.password }, root: directory, entry: resolve("dist/src/cli.js") });
    const handlers = new Map<string, Function[]>(), instructions: string[] = [];
    let reject = false, lateFailure: ((error: Error) => void) | undefined;
    const ctx: OmpContext = { mode: "tui", hasUI: true, cwd: directory, sessionManager: { getSessionId: () => `external-${harness}` }, ui: { input: async () => undefined, select: async () => undefined, notify() {} } };
    const emit = async (name: string, event: object = {}) => { for (const handler of handlers.get(name) ?? []) await handler(event, ctx); };
    const api = { zod, registerTool() {}, registerCommand() {}, on: (name: string, handler: Function) => handlers.set(name, [...(handlers.get(name) ?? []), handler]), sendMessage() {}, async sendUserMessage(text: string, options: any) {
      if (reject) throw new Error("Harness refused these instructions");
      assert.equal(options.deliverAs, "steer"); instructions.push(text);
      if (text.endsWith("Hold the turn")) return new Promise<void>((_resolve, reject) => { lateFailure = reject; });
      await emit("message_start"); await emit("message_update", { assistantMessageEvent: { type: "text_delta", delta: `${harness} replied` } });
      await emit("tool_execution_start", { toolName: "read", args: { path: "hello" } }); await emit("agent_end");
      const failure = { content: [{ type: "text", text: "Readable rg failure" }], structuredContent: { output: "Readable rg failure", exit_code: 2 }, isError: true };
      await emit("tool_execution_end", { isError: true, result: { content: [{ type: "text", text: JSON.stringify(failure) }] } });
    } };
    if (harness === "pi") piSideband(api); else sideband(api as OmpApi);
    let page: Awaited<ReturnType<typeof browserPage>> | undefined;
    try {
      await emit("session_start"); await until(async () => (await readPluginPresence()).some(row => row.key === presenceKey(harness, `external-${harness}`) && row.interactive));
      await worker.start(); page = await browserPage(server); await page.login(); await page.agents();
      await until(() => !!page!.doc.querySelector("#agent-list [data-agent-id]")); page.click("#agent-list [data-agent-id]");
      await until(() => !!page!.doc.querySelector<HTMLTextAreaElement>("#agent-prompt") && !page!.get<HTMLTextAreaElement>("#agent-prompt").disabled);
      const ready = () => !page!.get<HTMLButtonElement>("#agent-prompt-send").disabled;
      assert.ok(page.doc.querySelector('[aria-label="Agent actions"]'));
      page.click('[aria-label="Agent actions"]'); await until(() => !!page!.doc.querySelector('[role="menuitem"]')); page.click(page.button("Rename agent", "menuitem"));
      await until(() => !!page!.doc.querySelector("#rename-name")); page.fill("#rename-name", `renamed-${harness}`); page.click("#rename-apply");
      await until(() => page!.doc.querySelector("#agent-title")?.textContent === `renamed-${harness}` && !page!.doc.querySelector("#rename-dialog"));
      assert.equal(instructions.length, 0, "renaming must not inject a model prompt");

      page.fill("#agent-prompt", "Hello from the web"); page.submit("#agent-instructions");
      await until(() => instructions.length === 1 && ready() && page!.get("#agent-output").textContent?.includes(`${harness} replied`) === true);
      assert.equal(instructions[0], "Hello from the web");
      assert.equal(page.get<HTMLTextAreaElement>("#agent-prompt").value, "");
      assert.ok(page.get("#agent-output").textContent?.includes("read"));
      await until(() => page!.doc.querySelector(".output-error")?.textContent === "Readable rg failure");
      assert.doesNotMatch(page.get("#agent-output").textContent!, /structuredContent|exit_code|\[Sideband web instructions\]/);
      page.fill("#agent-prompt", "Hold the turn"); page.submit("#agent-instructions");
      await until(() => !!lateFailure && ready() && page!.get<HTMLTextAreaElement>("#agent-prompt").value === "", "The held instruction was not acknowledged by the composer.");
      page.fill("#agent-prompt", "Steer while running"); page.submit("#agent-instructions");
      await until(() => instructions.length === 3 && ready() && page!.get<HTMLTextAreaElement>("#agent-prompt").value === "", "The composer did not accept steering during the held turn.");
      lateFailure!(new Error("Late model failure"));
      await emit("extension_error", { error: "Async extension failure" });
      await until(() => page!.get("#agent-output").textContent?.includes("Late model failure") === true && page!.get("#agent-output").textContent?.includes("Async extension failure") === true);
      reject = true; page.fill("#agent-prompt", "Keep this draft"); page.submit("#agent-instructions");
      await until(() => page!.doc.querySelector('[role="alert"]')?.textContent?.includes("Harness refused") === true);
      assert.equal(page.get<HTMLTextAreaElement>("#agent-prompt").value, "Keep this draft"); assert.equal(instructions.length, 3);
      assert.deepEqual(await worker.client.listRooms(), [], "external instructions do not join rooms");
    } finally { await page?.close(); await emit("session_shutdown"); await worker.close(); await server.close(); await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
  }
});

test("Claude MCP publishes presence at plugin startup with no saved login or tool calls", { timeout: testTimeout(30000) }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "sideband-discovery-claude-")), registry = join(directory, "presence");
  const child = spawn(process.execPath, [resolve("dist/src/cli.js"), "mcp", "--harness", "claude"], { cwd: directory, windowsHide: true, env: { ...process.env, SIDEBAND_STATE_DIR: directory, SIDEBAND_PRESENCE_DIR: registry, SIDEBAND_CLAUDE_SERVER: "", SIDEBAND_CLAUDE_PASSWORD: "" }, stdio: ["pipe", "pipe", "pipe"] });
  child.stdout.resume(); child.stderr.resume(); const exited = new Promise<void>(r => child.once("exit", () => r()));
  try {
    let rows: Awaited<ReturnType<typeof readPluginPresence>> = [];
    await until(async () => { rows = await readPluginPresence(registry); return rows.length > 0; });
    assert.equal(rows.length, 1); assert.equal(rows[0]!.harness, "claude"); assert.equal(rows[0]!.pid, child.pid);
    child.stdin.end(); await exited; assert.deepEqual(await readPluginPresence(registry), []);
  } finally { if (child.exitCode === null && child.signalCode === null) { child.kill(); await exited; } await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
});
