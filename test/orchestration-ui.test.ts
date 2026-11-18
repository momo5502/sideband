import { testTimeout } from "./waits.js";
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { RoomServer } from "../src/room-server.js";
import { RoomClient } from "../src/room-client.js";
import { boundedOutput, mentionsUsername } from "../src/browser-workspace.js";
import type { ManagedAgent, ControlCommand, OutputEvent } from "../src/orchestration-protocol.js";
import { browserPage, until } from "./browser-fixture.js";

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
    assert.equal(p.doc.querySelectorAll("#agent-harness [role=radio]").length, 3); assert.equal(p.doc.querySelectorAll("#agent-harness [role=radio]:disabled").length, 0);
    const options = [...p.get<HTMLSelectElement>("#agent-machine").options]; assert.ok(options.find(option => option.textContent?.includes("offline-machine"))?.disabled); assert.ok(options.find(option => option.textContent?.includes("OMP not installed"))?.disabled);
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
    await p.navigation(); p.click(p.get(`#agent-list button[data-agent-id="${agent!.id}"]`)); await until(() => p.get("#agent-output").textContent!.includes("Agent offline"));
    assert.equal(p.doc.querySelector('.pane-error[role="alert"]'), null, "offline agents don't attempt a failing log watch");
    p.click('button[aria-label="Agent actions"]'); await until(() => !!p.doc.querySelector('[role="menuitem"]')); p.click(p.button("Forget agent…", "menuitem")); await until(() => !!p.doc.querySelector("#agent-action-dialog"));
    assert.match(p.get("#agent-action-dialog").textContent!, /Files stay on the machine/); p.submit("#agent-room-form");
    await until(() => p.doc.querySelector("#workspace-title")?.textContent === "Workspace" && !p.doc.querySelector("#agent-action-dialog"));
    assert.deepEqual(transportErrors, []); assert.deepEqual(p.errors, []);
  } finally { await page?.close(); await runner.close(); await worker.close(); await migratedWorker.close(); await unavailable.close(); await offline.close(); await peer.close(); await server.close(); }
});
