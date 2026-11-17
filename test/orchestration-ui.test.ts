import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { JSDOM, VirtualConsole } from "jsdom";
import WebSocket from "ws";
import { RoomServer } from "../src/room-server.js";
import { RoomClient } from "../src/room-client.js";
import type { ManagedAgent, ControlCommand } from "../src/orchestration-protocol.js";

async function until(check: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!check()) { if (Date.now() > deadline) throw new Error("Orchestration UI did not reach its expected state."); await new Promise(resolve => setTimeout(resolve, 10)); }
}
test("served browser controls: launch, select, safe streamed output, instructions, assigned room, stop and resume", { timeout: 15000 }, async () => {
  const server = await RoomServer.start({ host: "127.0.0.1", port: 0, statusPort: 0 });
  const profile = { server: `127.0.0.1:${server.port}`, password: server.password };
  const worker = new RoomClient(profile), runner = new RoomClient(profile, "managed-agent");
  const errors: Error[] = [], commands: ControlCommand[] = [], sockets = new Set<WebSocket>();
  const machineId = randomUUID(); let agent: ManagedAgent | undefined, dom: JSDOM | undefined;
  const publish = () => runner.request("control.publish", { agent, events: [] });
  worker.onEvent((event, command: ControlCommand) => {
    if (event !== "control.command") return;
    void (async () => {
      const spec = command.params.spec as ManagedAgent;
      agent = { ...spec, id: command.params.id as string, machineId, machineName: "test-machine", state: "idle", online: true, createdAt: Date.now(), room: spec.room ?? "" };
      await runner.request("control.runner", { agent });
      await worker.request("control.reply", { id: command.id, result: { id: agent.id } });
    })().catch(error => errors.push(error));
  });
  runner.onEvent((event, command: ControlCommand) => {
    if (event !== "control.command") return;
    void (async () => {
      commands.push(command); let result: unknown = {};
      if (command.method === "logs") result = { first: 5, next: 6, events: [{ seq: 5, at: Date.now(), kind: "assistant", text: "<script>window.hacked=true</script>\nSecond line" }] };
      if (command.method === "stop") agent!.state = "stopped";
      if (command.method === "resume") agent!.state = "idle";
      if (command.method === "room") agent!.room = command.params.room as string;
      await publish(); await runner.request("control.reply", { id: command.id, result });
    })().catch(error => errors.push(error));
  });
  try {
    await worker.connect(); await runner.connect();
    await worker.request("control.worker", { machine: { id: machineId, name: "test-machine", platform: "test", harnesses: ["omp"], online: true } });
    const console = new VirtualConsole(); console.on("jsdomError", error => errors.push(error));
    const origin = `http://127.0.0.1:${server.statusPort}`;
    dom = await JSDOM.fromURL(`${origin}/chat`, { resources: "usable", runScripts: "dangerously", virtualConsole: console,
      beforeParse(window) {
        Object.assign(window, { TextEncoder, TextDecoder, matchMedia: () => Object.assign(new window.EventTarget(), { matches: false }) });
        window.localStorage.setItem("sideband.login.v1", JSON.stringify({ name: "human", password: server.password }));
        window.WebSocket = class extends WebSocket { constructor(url: string) { super(url, { origin }); sockets.add(this); this.once("close", () => sockets.delete(this)); } } as unknown as typeof window.WebSocket;
      } });
    const doc = dom.window.document, get = (id: string) => doc.getElementById(id)!, value = (id: string, value: string) => { (get(id) as HTMLInputElement).value = value; };
    const submit = (id: string) => get(id).dispatchEvent(new dom!.window.Event("submit", { cancelable: true }));
    await until(() => !get("app").hidden);
    get("agents-open").click(); await until(() => !!doc.querySelector("#agent-machine option"));
    assert.equal(get("chat-main").hidden, true); assert.equal(doc.title, "Agents — Sideband");
    value("agent-name", "managed-agent"); value("agent-repository", "https://example.org/project.git"); value("launch-room", "project-room");
    submit("agent-launch-form"); await until(() => !!doc.querySelector("#agent-list button"));
    (doc.querySelector("#agent-list button") as HTMLElement).click(); await until(() => get("agent-output").textContent!.includes("Second line"));
    assert.ok(get("agent-output").textContent!.includes("<script>window.hacked=true</script>\nSecond line"));
    assert.equal(doc.querySelector("#agent-output script"), null); assert.equal((dom.window as any).hacked, undefined);
    assert.match(get("agent-output").textContent!, /Earlier output/);
    value("agent-prompt", "Keep $(this) literal\nand keep the newlines"); submit("agent-instructions");
    await until(() => commands.some(command => command.method === "prompt"));
    assert.equal(commands.find(command => command.method === "prompt")!.params.text, "Keep $(this) literal\nand keep the newlines");
    await runner.request("control.publish", { agent, events: [{ seq: 6, at: Date.now(), kind: "tool-output", text: "Live tool output\nAnother line" }] });
    await until(() => get("agent-output").textContent!.includes("Live tool output\nAnother line"));
    value("agent-room", "other-room"); submit("agent-room-form"); await until(() => get("agent-status").textContent!.includes("other-room"));
    get("agent-stop").click(); await until(() => get("agent-title").textContent!.includes("stopped"));
    assert.equal((get("agent-prompt-send") as HTMLButtonElement).disabled, true);
    get("agent-resume").click(); await until(() => get("agent-title").textContent!.includes("idle"));
    get("agents-back").click(); assert.equal(get("agents-view").hidden, true); assert.equal(get("chat-main").hidden, false);
    assert.deepEqual(errors, []);
  } finally {
    dom?.window.close(); for (const socket of sockets) socket.terminate(); await runner.close(); await worker.close(); await server.close();
  }
});
