import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { RoomServer } from "../src/room-server.js";
import { RoomClient } from "../src/room-client.js";
import type { ManagedAgent, ControlCommand } from "../src/orchestration-protocol.js";
import { browserPage, until } from "./browser-fixture.js";

for (const terminal of [true, false]) test(`the browser launches an empty workspace with terminal=${terminal}`, async () => {
  const server = await RoomServer.start({ host: "127.0.0.1", port: 0, statusPort: 0 });
  const profile = { server: `127.0.0.1:${server.port}`, password: server.password };
  const worker = new RoomClient(profile), runner = new RoomClient(profile, "scratch");
  let page: Awaited<ReturnType<typeof browserPage>> | undefined, spec: Record<string, unknown> | undefined;
  const machineId = randomUUID(), errors: unknown[] = [];
  worker.onEvent((event, command: ControlCommand) => {
    if (event !== "control.command") return;
    void (async () => {
      spec = command.params.spec as Record<string, unknown>;
      const agent = { ...spec, id: command.params.id, machineId, machineName: "local", state: "idle", room: "", canResume: true, online: true, createdAt: Date.now() } as ManagedAgent;
      await runner.request("control.runner", { agent }); await worker.request("control.reply", { id: command.id, result: { id: agent.id } });
    })().catch(error => errors.push(error));
  });
  runner.onEvent((event, command: ControlCommand) => { if (event === "control.command") void runner.request("control.reply", { id: command.id, result: { events: [], first: 1, next: 1 } }).catch(error => errors.push(error)); });
  try {
    await worker.connect(); await runner.connect(); await worker.request("control.worker", { machine: { id: machineId, name: "local", platform: "test", harnesses: ["omp"], terminal: "window" } });
    page = await browserPage(server); const p = page; await p.login(); await p.navigation(); p.click("#new-agent");
    await until(() => !!p.doc.querySelector("#new-agent-dialog"));
    await until(() => p.get<HTMLSelectElement>("#agent-machine").value === machineId && !p.get<HTMLInputElement>("#agent-terminal").disabled);
    assert.equal(p.get<HTMLInputElement>("#agent-repository").required, false); assert.equal(p.get<HTMLInputElement>("#launch-ref").disabled, true);
    assert.equal(p.get<HTMLInputElement>("#agent-terminal").checked, true, "native terminal is selected by default"); if (!terminal) p.click("#agent-terminal");
    p.fill("#agent-name", "scratch"); p.submit("#agent-launch-form");
    await until(() => p.doc.querySelector("#agent-title")?.textContent === "scratch" && !p.doc.querySelector("#new-agent-dialog")).catch(error => {
      throw new Error(`${error.message}; launch=${p.doc.querySelector("#launch-error")?.textContent}; callbacks=${errors.map(String).join("; ")}; browser=${p.errors.map(String).join("; ")}`);
    });
    assert.equal(spec?.repository, undefined); assert.equal(spec?.ref, undefined); assert.match(p.doc.querySelector(".pane-subtitle")?.textContent ?? "", /Empty workspace/);
    assert.equal(spec?.terminal, terminal ? true : undefined);
    assert.deepEqual(errors, []); assert.deepEqual(p.errors, []);
  } finally { await page?.close(); await worker.close(); await runner.close(); await server.close(); }
});

for (const harness of ["codex", "claude"] as const) test(`the browser selects and launches a detected ${harness} worker`, async () => {
  const terminal = false;
  const server = await RoomServer.start({ host: "127.0.0.1", port: 0, statusPort: 0 });
  const profile = { server: `127.0.0.1:${server.port}`, password: server.password };
  const worker = new RoomClient(profile), runner = new RoomClient(profile, "scratch");
  let page: Awaited<ReturnType<typeof browserPage>> | undefined, spec: Record<string, unknown> | undefined;
  const machineId = randomUUID(), errors: unknown[] = [];
  worker.onEvent((event, command: ControlCommand) => {
    if (event !== "control.command") return;
    void (async () => {
      spec = command.params.spec as Record<string, unknown>;
      const agent = { ...spec, id: command.params.id, machineId, machineName: "local", state: "idle", room: "", canResume: true, online: true, createdAt: Date.now() } as ManagedAgent;
      await runner.request("control.runner", { agent }); await worker.request("control.reply", { id: command.id, result: { id: agent.id } });
    })().catch(error => errors.push(error));
  });
  runner.onEvent((event, command: ControlCommand) => { if (event === "control.command") void runner.request("control.reply", { id: command.id, result: { events: [], first: 1, next: 1 } }).catch(error => errors.push(error)); });
  try {
    await worker.connect(); await runner.connect(); await worker.request("control.worker", { machine: { id: machineId, name: "local", platform: "test", harnesses: [harness], terminal: "none" } });
    page = await browserPage(server); const p = page; await p.login(); await p.navigation(); p.click("#new-agent");
    await until(() => !!p.doc.querySelector("#new-agent-dialog"));
    await until(() => p.get<HTMLSelectElement>("#agent-machine").value === machineId);
    assert.equal(p.get<HTMLInputElement>("#agent-repository").required, false); assert.equal(p.get<HTMLInputElement>("#launch-ref").disabled, true);
    assert.equal(p.get<HTMLInputElement>("#agent-terminal").checked, false);
    p.fill("#agent-name", "scratch"); p.submit("#agent-launch-form");
    await until(() => p.doc.querySelector("#agent-title")?.textContent === "scratch" && !p.doc.querySelector("#new-agent-dialog")).catch(error => {
      throw new Error(`${error.message}; launch=${p.doc.querySelector("#launch-error")?.textContent}; callbacks=${errors.map(String).join("; ")}; browser=${p.errors.map(String).join("; ")}`);
    });
    assert.equal(spec?.harness, harness); assert.equal(spec?.repository, undefined); assert.equal(spec?.ref, undefined); assert.match(p.doc.querySelector(".pane-subtitle")?.textContent ?? "", /Empty workspace/);
    assert.equal(spec?.terminal, terminal ? true : undefined);
    assert.deepEqual(errors, []); assert.deepEqual(p.errors, []);
  } finally { await page?.close(); await worker.close(); await runner.close(); await server.close(); }
});
