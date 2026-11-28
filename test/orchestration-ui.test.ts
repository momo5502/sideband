import { testTimeout } from "./waits.js";
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { RoomServer } from "../src/room-server.js";
import { RoomClient } from "../src/room-client.js";
import { boundedOutput, mentionsUsername } from "../src/browser-workspace.js";
import type { ManagedAgent, ControlCommand, OutputEvent } from "../src/orchestration-protocol.js";
import { browserPage, until } from "./browser-fixture.js";

for (const mobile of [false, true]) test(`${mobile ? "mobile" : "desktop"} existing-folder picker browses the selected machine and gates old workers`, { timeout: testTimeout(30000) }, async () => {
  const server = await RoomServer.start({ host: "127.0.0.1", port: 0, statusPort: 0 }), profile = { server: `127.0.0.1:${server.port}`, password: server.password };
  const worker = new RoomClient(profile), legacy = new RoomClient(profile), runner = new RoomClient(profile, "project"), machineId = randomUUID(), legacyId = randomUUID(), commands: ControlCommand[] = [];
  let page: Awaited<ReturnType<typeof browserPage>> | undefined;
  worker.onEvent((event, command: ControlCommand) => {
    if (event !== "control.command") return; commands.push(command);
    void worker.request("control.reply", { id: command.id, ...(command.method === "launch" ? { error: "Captured folder launch" } : { result: { path: command.params.path ?? "/remote", parent: command.params.path ? "/remote" : "/", roots: ["/"], entries: command.params.path ? [] : [{ name: "project", path: "/remote/project" }] } }) });
  });
  try {
    await worker.connect(); await worker.request("control.worker", { machine: { id: machineId, name: "current", platform: "test", harnesses: ["omp"] } }); await worker.request("control.features", { folders: true });
    await legacy.connect(); await legacy.request("control.worker", { machine: { id: legacyId, name: "old worker", platform: "test", harnesses: ["omp"] } });
    await runner.connect(); await runner.request("control.runner", { agent: { id: randomUUID(), name: "project", harness: "omp", machineId, machineName: "current", room: "", state: "idle", createdAt: Date.now() } });
    await assert.rejects(worker.request("control.folders", { machineId }), /authenticated web panel/);
    page = await browserPage(server, { mobile }); const p = page; await p.login(); await p.navigation(); p.click("#new-agent"); await until(() => !!p.doc.querySelector("#new-agent-dialog"));
    await until(() => [...p.get<HTMLSelectElement>("#agent-machine").options].some(option => option.value === machineId)); p.fill("#agent-machine", machineId);
    p.fill("#agent-repository", "https://example.org/old.git"); p.fill("#agent-workspace", "folder"); await until(() => !!p.doc.querySelector("#agent-folder"));
    await until(() => !p.get<HTMLButtonElement>("#browse-folders").disabled); p.click("#browse-folders"); await until(() => p.doc.querySelector("#folder-current")?.textContent === "/remote");
    p.click('[data-folder="/remote/project"]'); await until(() => p.doc.querySelector("#folder-current")?.textContent === "/remote/project");
    p.click("#folder-use"); await until(() => p.get<HTMLInputElement>("#agent-folder").value === "/remote/project");
    assert.equal(p.get<HTMLInputElement>("#agent-name").value, "project-2", "folder-based suggested names avoid existing agents");
    assert.equal(p.get<HTMLSelectElement>("#launch-ref").disabled, true);
    p.fill("#agent-name", "existing"); p.submit("#agent-launch-form"); await until(() => commands.some(command => command.method === "launch"));
    const spec = commands.find(command => command.method === "launch")!.params.spec as Record<string, unknown>;
    assert.equal(spec.folder, "/remote/project"); assert.equal(spec.repository, undefined); assert.equal(spec.ref, undefined);
    await until(() => !!p.doc.querySelector("#launch-error")); p.fill("#agent-machine", legacyId); await until(() => p.get<HTMLInputElement>("#agent-folder").value === "");
    assert.equal(p.get<HTMLButtonElement>("#browse-folders").disabled, true); assert.equal(p.get<HTMLButtonElement>("#agent-launch").disabled, true); assert.match(p.get("#new-agent-dialog").textContent!, /Update this worker/);
    p.click(p.button("Cancel")); assert.deepEqual(p.errors, []);
  } finally { await page?.close(); await worker.close(); await legacy.close(); await runner.close(); await server.close(); }
});

test("model picker follows machine and harness, supports custom IDs, refresh and model-specific efforts", { timeout: testTimeout(30000) }, async () => {
  const server = await RoomServer.start({ host: "127.0.0.1", port: 0, statusPort: 0 }), profile = { server: `127.0.0.1:${server.port}`, password: server.password };
  const worker = new RoomClient(profile), machineId = randomUUID(), commands: ControlCommand[] = [];
  let page: Awaited<ReturnType<typeof browserPage>> | undefined, serial = 1;
  const publish = (harness: string, models: object[]) => worker.request("control.models", { harness, catalog: { at: serial++, models } });
  worker.onEvent((event, command: ControlCommand) => {
    if (event !== "control.command") return; commands.push(command);
    void (async () => {
      if (command.method === "models") await publish(String(command.params.harness), [{ id: "new-model", label: "Refreshed", efforts: ["high"] }]);
      await worker.request("control.reply", { id: command.id, ...(command.method === "launch" ? { error: "Test captured launch" } : { result: {} }) });
    })();
  });
  try {
    await worker.connect(); const registration = await worker.request<{ capabilities: { models: boolean } }>("control.worker", { machine: { id: machineId, name: "models", platform: "test", harnesses: ["omp", "codex", "claude"] } });
    assert.equal(registration.capabilities.models, true);
    await publish("omp", [{ id: "provider/reasoning", label: "Reasoning", efforts: ["low", "high"], defaultEffort: "high" }, { id: "provider/plain", label: "Plain", efforts: [] }]);
    await publish("codex", [{ id: "codex-test", label: "Codex test", efforts: ["high", "ultra"] }]);
    page = await browserPage(server); const p = page; await p.login(); p.click("#new-agent"); await until(() => p.doc.querySelectorAll("#launch-models option").length === 2);
    p.fill("#launch-model", "provider/reasoning"); await until(() => p.get<HTMLSelectElement>("#launch-effort").options.length === 3);
    assert.deepEqual([...p.get<HTMLSelectElement>("#launch-effort").options].map(o => o.value), ["", "low", "high"]);
    p.fill("#launch-effort", "high"); p.fill("#launch-model", "provider/plain"); await until(() => p.get<HTMLSelectElement>("#launch-effort").disabled);
    assert.equal(p.get<HTMLSelectElement>("#launch-effort").value, "");
    p.click('#agent-harness [value="codex"]'); await until(() => p.doc.querySelector("#launch-models option")?.getAttribute("value") === "codex-test");
    assert.equal(p.get<HTMLInputElement>("#launch-model").value, "", "switching harness clears a stale model selection");
    p.fill("#launch-model", "codex-test"); await until(() => [...p.get<HTMLSelectElement>("#launch-effort").options].some(o => o.value === "ultra"));
    p.click("#refresh-models"); await until(() => p.doc.querySelector("#launch-models option")?.getAttribute("value") === "new-model");
    assert.equal(commands.at(-1)?.method, "models"); assert.equal(commands.at(-1)?.params.harness, "codex");
    p.fill("#launch-model", "custom-provider/model"); p.fill("#launch-effort", "high"); p.fill("#agent-name", "custom"); p.submit("#agent-launch-form");
    await until(() => commands.some(command => command.method === "launch")); const launch = commands.find(command => command.method === "launch")!;
    assert.equal((launch.params.spec as any).model, "custom-provider/model"); assert.equal((launch.params.spec as any).effort, "high");
    await until(() => !!p.doc.querySelector("#launch-error")); p.click(p.button("Cancel"));
    assert.deepEqual(p.errors, []);
  } finally { await page?.close(); await worker.close(); await server.close(); }
});

for (const mobile of [false, true]) test(`${mobile ? "mobile" : "desktop"} saved sessions: archived list, offline resume and reversible archive`, { timeout: testTimeout(30000) }, async () => {
  const server = await RoomServer.start({ host: "127.0.0.1", port: 0, statusPort: 0 }), profile = { server: `127.0.0.1:${server.port}`, password: server.password };
  const worker = new RoomClient(profile), runner = new RoomClient(profile, "saved"), machineId = randomUUID();
  const agent: ManagedAgent = { id: randomUUID(), name: "saved", harness: "omp", machineId, machineName: "machine", state: "stopped", online: false, createdAt: Date.now(), room: "", persistent: true, archived: true, canResume: true };
  let page: Awaited<ReturnType<typeof browserPage>> | undefined; const errors: unknown[] = []; let refuse = true;
  worker.onEvent((event, command: ControlCommand) => {
    if (event !== "control.command") return;
    void (async () => {
      assert.equal(command.method, "resume");
      if (refuse) { refuse = false; await worker.request("control.reply", { id: command.id, error: "Fixture resume failed" }); return; }
      agent.archived = false; agent.state = "idle"; await runner.connect(); await runner.request("control.runner", { agent });
      await worker.request("control.reply", { id: command.id, result: { resumed: true } });
    })().catch(error => errors.push(error));
  });
  runner.onEvent((event, command: ControlCommand) => {
    if (event !== "control.command") return;
    void (async () => {
      await runner.request("control.reply", { id: command.id, result: command.method === "logs" ? { events: [], first: 1, next: 1 } : {} });
      if (command.method === "archive") await runner.close();
    })().catch(error => errors.push(error));
  });
  try {
    await worker.connect(); await worker.request("control.worker", { machine: { id: machineId, name: "machine", platform: "test", harnesses: ["omp"] } }); await worker.request("control.inventory", { agents: [agent] });
    page = await browserPage(server, { mobile }); const p = page; await p.login(); await p.agents();
    await until(() => !!p.doc.querySelector("#archived-agents")); assert.equal(p.doc.querySelectorAll("#agent-list [data-agent-id]").length, 0);
    p.click("#archived-agents summary"); p.click(`#archived-agents [data-agent-id="${agent.id}"]`);
    await until(() => !!p.doc.querySelector("#agent-resume") && !p.doc.querySelector("#navigation-dialog")); assert.equal(p.get<HTMLButtonElement>("#agent-resume").disabled, false);
    p.click("#agent-resume"); await until(() => p.doc.body.textContent!.includes("Fixture resume failed"));
    await until(() => !p.get<HTMLButtonElement>("#agent-resume").disabled); assert.equal(p.get('.badge-state').getAttribute("data-state"), "archived");
    p.click("#agent-resume"); await until(() => !!p.doc.querySelector("#agent-prompt") && !p.get<HTMLTextAreaElement>("#agent-prompt").disabled);
    p.click('button[aria-label="Agent actions"]'); await until(() => !!p.doc.querySelector('[role="menuitem"]')); p.click(p.button("Archive agent\u2026", "menuitem"));
    await until(() => !!p.doc.querySelector("#agent-action-dialog")); assert.match(p.get("#agent-action-dialog").textContent!, /resume it later/); p.submit("#agent-room-form");
    await until(() => !p.doc.querySelector("#agent-action-dialog") && p.doc.querySelector("#workspace-title")?.textContent === "Workspace"); await p.agents();
    await until(() => !!p.doc.querySelector("#archived-agents")); assert.equal(p.doc.querySelectorAll("#agent-list [data-agent-id]").length, 0);
    assert.deepEqual(errors, []); assert.deepEqual(p.errors, []);
  } finally { await page?.close(); await runner.close(); await worker.close(); await server.close(); }
});

test("native Claude setup is explicit, survives an error and blocks launch while trust is being recorded", { timeout: testTimeout(30000) }, async () => {
  const server = await RoomServer.start({ host: "127.0.0.1", port: 0, statusPort: 0 });
  const worker = new RoomClient({ server: `127.0.0.1:${server.port}`, password: server.password }), machineId = randomUUID(), commands: ControlCommand[] = [];
  let page: Awaited<ReturnType<typeof browserPage>> | undefined;
  worker.onEvent((event, command) => { if (event === "control.command") commands.push(command); });
  try {
    await worker.connect(); await worker.request("control.worker", { machine: { id: machineId, name: "claude-machine", platform: "win32", terminal: "window", harnesses: ["claude"] } });
    page = await browserPage(server); const p = page; await p.login(); await p.navigation(); p.click("#new-agent");
    await until(() => p.doc.querySelector<HTMLSelectElement>("#agent-machine")?.value === machineId && p.button("Claude", "radio").getAttribute("data-state") === "checked" && !p.get<HTMLInputElement>("#agent-terminal").disabled);
    assert.equal(p.doc.querySelector("[data-claude-trust]"), null, "background mode needs no trust setup");
    p.click("#agent-terminal"); await until(() => !!p.doc.querySelector("[data-claude-trust]"));
    assert.equal(commands.length, 0, "opening native setup must not change trust");
    p.fill("#agent-name", "native-test"); p.click(p.button("Trust Claude workspaces"));
    await until(() => commands.length === 1); assert.equal(commands[0]!.method, "claude-trust"); assert.deepEqual(commands[0]!.params, {});
    assert.equal(p.get<HTMLButtonElement>("#agent-launch").disabled, true);
    await worker.request("control.reply", { id: commands[0]!.id, error: "Run Claude once on this machine, then retry recording trust." });
    await until(() => p.get("[data-claude-trust]").textContent!.includes("Run Claude once"));
    p.click(p.button("Trust Claude workspaces")); await until(() => commands.length === 2);
    await worker.request("control.reply", { id: commands[1]!.id, result: { root: "C:/sideband/workspaces" } });
    await until(() => !!p.doc.querySelector("[data-claude-trust] [role=status]"));
    assert.equal(p.get<HTMLButtonElement>("#agent-launch").disabled, false); assert.equal(p.get<HTMLInputElement>("#agent-name").value, "native-test");
    assert.equal(commands.length, 2, "trust is a separate action, not a form submission"); assert.deepEqual(p.errors, []);
  } finally { await page?.close(); await worker.close(); await server.close(); }
});

test("streamed output merges snapshots without duplicates and remains bounded by count and UTF-8 bytes", () => {
  const event = (seq: number, text = "message"): OutputEvent => ({ seq, at: seq, kind: "assistant", text });
  const input = Array.from({ length: 1200 }, (_, i) => event(i + 1));
  assert.equal(boundedOutput([], input).length, 1000);
  const result = boundedOutput([event(4), event(5)], [event(1), event(2), event(3), event(4)]);
  assert.deepEqual(result.map(value => value.seq), [1, 2, 3, 4, 5]);
  const large = boundedOutput([], Array.from({ length: 1000 }, (_, i) => event(i + 1, "😀".repeat(1000))));
  assert.ok(large.length < 1000); assert.ok(Buffer.byteLength(large.map(value => JSON.stringify(value)).join("")) <= 2 * 1024 * 1024);
  assert.equal(mentionsUsername("Hey @MOMO!", "momo"), true); assert.equal(mentionsUsername("momo@example.com, @momoz @momo-other", "momo"), false);
});

for (const mobile of [false, true]) test(`${mobile ? "mobile" : "desktop"} workspace: focused launch, agent conversation, private instructions, menus and offline forgetting`, { timeout: testTimeout(30000) }, async () => {
  const server = await RoomServer.start({ host: "127.0.0.1", port: 0, statusPort: 0 });
  const profile = { server: `127.0.0.1:${server.port}`, password: server.password };
  const worker = new RoomClient(profile), migratedWorker = new RoomClient(profile), unavailable = new RoomClient(profile), offline = new RoomClient(profile), runner = new RoomClient(profile, "tools"), peer = new RoomClient(profile, "peer");
  const machineId = randomUUID(), commands: ControlCommand[] = [], transportErrors: unknown[] = [];
  let agent: ManagedAgent | undefined, page: Awaited<ReturnType<typeof browserPage>> | undefined, launchError = "Repository access failed. Check the machine’s Git credentials.";
  const publish = (events: OutputEvent[] = []) => runner.request("control.publish", { agent, events });
  worker.onEvent((event, command: ControlCommand) => {
    if (event !== "control.command") return;
    void (async () => {
      if (launchError) { const error = launchError; launchError = ""; await worker.request("control.reply", { id: command.id, error }); return; }
      const spec = command.params.spec as ManagedAgent;
      agent = { ...spec, id: command.params.id as string, machineId, machineName: "workstation", state: "preparing", online: true, canResume: false, createdAt: Date.now(), room: spec.room ?? "" };
      await runner.request("control.runner", { agent }); if (agent.room) await runner.joinRoom(agent.room);
      await worker.request("control.reply", { id: command.id, result: { id: agent.id } });
    })().catch(error => transportErrors.push(error));
  });
  runner.onEvent((event, command: ControlCommand) => {
    if (event !== "control.command") return;
    void (async () => {
      commands.push(command); let result: unknown = {};
      if (command.method === "logs") result = { first: 5, next: 7, events: [{ seq: 5, at: Date.now(), kind: "assistant", text: "<script>window.hacked=true</script>\nSecond line" }, { seq: 6, at: Date.now(), kind: "thinking", text: "Quiet thinking" }] };
      if (command.method === "stop") agent!.state = "stopped";
      if (command.method === "resume") agent!.state = "idle";
      if (command.method === "room") agent!.room = command.params.room as string;
      await publish(); await runner.request("control.reply", { id: command.id, result });
    })().catch(error => transportErrors.push(error));
  });
  try {
    await worker.connect(); await unavailable.connect(); await offline.connect(); await runner.connect(); await peer.connect(); const room = await peer.joinRoom("orchestrator");
    await worker.request("control.worker", { machine: { id: machineId, name: "workstation", platform: "test", harnesses: ["omp"] } });
    await unavailable.request("control.worker", { machine: { id: randomUUID(), name: "no-omp", platform: "test", harnesses: [] } });
    await offline.request("control.worker", { machine: { id: randomUUID(), name: "offline-machine", platform: "test", harnesses: ["omp"] } }); await offline.close();
    page = await browserPage(server, { mobile }); const p = page; await p.login(); await p.view(room.id, room.name); await p.navigation();
    p.click("#new-agent"); await until(() => !!p.doc.querySelector("#new-agent-dialog"));
    assert.equal(p.get<HTMLSelectElement>("#launch-room").value, "orchestrator"); assert.equal(p.get<HTMLSelectElement>("#agent-machine").value, machineId);
    assert.equal(p.doc.querySelectorAll("#agent-harness [role=radio]").length, 4); assert.equal(p.doc.querySelectorAll("#agent-harness [role=radio]:disabled").length, 3);
    const options = [...p.get<HTMLSelectElement>("#agent-machine").options]; assert.ok(options.find(option => option.textContent?.includes("offline-machine"))?.disabled); assert.equal(options.find(option => option.textContent?.includes("no-omp"))?.disabled, false, "machine choice is independent of the current harness");
    assert.equal(p.get<HTMLDetailsElement>(".advanced-section").open, false);
    p.fill("#agent-repository", "https://example.org/_tools.git"); await until(() => p.get<HTMLInputElement>("#agent-name").value === "tools");
    p.fill("#launch-prompt", "Initial task"); p.submit("#agent-launch-form"); await until(() => !!p.doc.querySelector("#launch-error"));
    assert.match(p.get("#launch-error").textContent!, /Repository access/); assert.equal(p.get<HTMLInputElement>("#agent-repository").value, "https://example.org/_tools.git");
    p.submit("#agent-launch-form"); await until(() => p.doc.querySelector("#agent-title")?.textContent === "tools" && !p.doc.querySelector("#new-agent-dialog"));
    assert.equal(p.doc.title, "tools — Sideband"); assert.equal(p.doc.querySelector('.pane-error[role="alert"]'), null); assert.equal(p.get<HTMLTextAreaElement>("#agent-prompt").disabled, true); assert.match(p.get<HTMLTextAreaElement>("#agent-prompt").placeholder, /once the agent is ready/);
    await until(() => p.get("#agent-output").textContent!.includes("Second line"));
    assert.ok(p.get("#agent-output").textContent!.includes("<script>window.hacked=true</script>")); assert.ok(p.doc.querySelector("#agent-output .markdown br")); assert.equal(p.doc.querySelector("#agent-output script"), null);
    assert.equal(p.get<HTMLDetailsElement>('.activity-entry[data-kind="thinking"]').open, false);
    await worker.close(); await migratedWorker.connect(); const migratedMachineId = randomUUID();
    await migratedWorker.request("control.worker", { machine: { id: migratedMachineId, name: "workstation", platform: "test", harnesses: ["omp"] } });
    agent!.state = "failed"; agent!.error = "Clone failed"; await publish(); await until(() => !![...p.doc.querySelectorAll("button")].find(button => button.textContent === "Launch again…"));
    p.click(p.button("Launch again…")); await until(() => !!p.doc.querySelector("#new-agent-dialog"));
    assert.equal(p.get<HTMLSelectElement>("#agent-machine").value, migratedMachineId, "a pre-migration machine id selects the current machine by name");
    assert.equal(p.get<HTMLInputElement>("#agent-repository").value, "https://example.org/_tools.git"); assert.equal(p.get<HTMLInputElement>("#agent-name").value, "tools-2"); assert.equal(p.get<HTMLTextAreaElement>("#launch-prompt").value, "Initial task"); p.click(p.button("Cancel"));
    agent!.error = undefined;
    agent!.state = "idle"; agent!.canResume = true; await publish(); await until(() => !p.get<HTMLTextAreaElement>("#agent-prompt").disabled);
    p.fill("#agent-prompt", "Keep $(this) literal\nand preserve newlines"); p.key("#agent-prompt", "Enter");
    await until(() => commands.some(command => command.method === "prompt")); assert.equal(commands.find(command => command.method === "prompt")!.params.text, "Keep $(this) literal\nand preserve newlines");
    assert.match(p.get("#agent-instructions").textContent!, /Private instructions.*Not sent to #orchestrator/);
    const log = p.get("#agent-output"); Object.defineProperties(log, { scrollHeight: { configurable: true, value: 1000 }, clientHeight: { configurable: true, value: 200 } }); log.scrollTop = 0; log.dispatchEvent(new p.dom.window.Event("scroll", { bubbles: true }));
    await publish([{ seq: 7, at: Date.now(), kind: "assistant", text: "New streamed output" }]); await until(() => !!p.doc.querySelector(".new-output")); assert.equal(p.get(".new-output").textContent, "New output"); p.click(".new-output");
    p.click('button[aria-label="Agent actions"]'); await until(() => !!p.doc.querySelector('[role="menuitem"]'));
    p.click(p.button("Change room…", "menuitem")); await until(() => !!p.doc.querySelector("#agent-action-dialog"));
    p.key("#agent-action-dialog", "Escape"); await until(() => !p.doc.querySelector("#agent-action-dialog"));
    assert.equal(p.doc.activeElement?.getAttribute("aria-label"), "Agent actions"); assert.notEqual(p.doc.body.style.pointerEvents, "none");
    p.click('button[aria-label="Agent actions"]'); await until(() => !!p.doc.querySelector('[role="menuitem"]')); p.click(p.button("Stop agent", "menuitem"));
    await until(() => !!p.doc.querySelector("#agent-resume") && !p.get<HTMLButtonElement>("#agent-resume").disabled); p.click("#agent-resume"); await until(() => !p.get<HTMLTextAreaElement>("#agent-prompt").disabled);
    await runner.close(); await until(() => p.doc.querySelector('.badge-state[data-state="offline"]') !== null);
    await p.agents(); p.click(p.get(`#agent-list button[data-agent-id="${agent!.id}"]`)); await until(() => p.doc.querySelector("#agent-output")?.textContent?.includes("Agent offline") === true);
    assert.equal(p.doc.querySelector('.pane-error[role="alert"]'), null, "offline agents don't attempt a failing log watch");
    p.click('button[aria-label="Agent actions"]'); await until(() => !!p.doc.querySelector('[role="menuitem"]')); p.click(p.button("Forget agent…", "menuitem")); await until(() => !!p.doc.querySelector("#agent-action-dialog"));
    assert.match(p.get("#agent-action-dialog").textContent!, /Files stay on the machine/); p.submit("#agent-room-form");
    await until(() => p.doc.querySelector("#workspace-title")?.textContent === "Workspace" && !p.doc.querySelector("#agent-action-dialog"));
    assert.deepEqual(transportErrors, []); assert.deepEqual(p.errors, []);
  } finally { await page?.close(); await runner.close(); await worker.close(); await migratedWorker.close(); await unavailable.close(); await offline.close(); await peer.close(); await server.close(); }
});
