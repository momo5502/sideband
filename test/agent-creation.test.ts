import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { RoomServer } from "../src/room-server.js";
import { RoomClient } from "../src/room-client.js";
import { browserPage, until } from "./browser-fixture.js";
import { testTimeout } from "./waits.js";
import type { ControlCommand } from "../src/orchestration-protocol.js";

for (const mobile of [false, true]) test(`${mobile ? "mobile" : "desktop"} creation chooses the machine first and fences folder/model choices across machines`, { timeout: testTimeout(30000) }, async () => {
  const server = await RoomServer.start({ host: "127.0.0.1", port: 0, statusPort: 0 }), profile = { server: `127.0.0.1:${server.port}`, password: server.password };
  const first = new RoomClient(profile), second = new RoomClient(profile), empty = new RoomClient(profile), firstId = randomUUID(), secondId = randomUUID(), emptyId = randomUUID();
  const errors: unknown[] = [], launches: any[] = []; let requests = 0, release: (() => Promise<unknown>) | undefined, page: Awaited<ReturnType<typeof browserPage>> | undefined;
  const folders = (path: string) => ({ path, parent: "/", roots: ["/"], entries: ["alpha", "beta", "a-folder-with-a-long-name"].map(name => ({ name, path: `${path}/${name}` })) });
  first.onEvent((event, command: ControlCommand) => {
    if (event !== "control.command") return;
    if (command.method === "launch") { launches.push({ machineId: firstId, spec: command.params.spec }); void first.request("control.reply", { id: command.id, error: "Captured launch" }).catch(error => errors.push(error)); return; }
    if (command.method === "folders" && ++requests === 2) { release = () => first.request("control.reply", { id: command.id, result: folders("/old-machine-late-reply") }); return; }
    void first.request("control.reply", { id: command.id, result: command.method === "folders" ? folders("/first") : {} }).catch(error => errors.push(error));
  });
  second.onEvent((event, command: ControlCommand) => {
    if (event !== "control.command") return;
    if (command.method === "launch") launches.push({ machineId: secondId, spec: command.params.spec });
    void second.request("control.reply", { id: command.id, ...(command.method === "launch" ? { error: "Captured launch" } : { result: command.method === "folders" ? folders("/second") : {} }) }).catch(error => errors.push(error));
  });
  try {
    for (const [worker, id, name, harnesses] of [[first, firstId, "first-omp", ["omp"]], [second, secondId, "second-pi", ["pi"]], [empty, emptyId, "unconfigured", []]] as const) {
      await worker.connect(); await worker.request("control.worker", { machine: { id, name, platform: "test", terminal: "window", harnesses } }); await worker.request("control.features", { folders: true });
    }
    page = await browserPage(server, { mobile }); const p = page; await p.login(); await p.navigation(); p.click("#new-agent"); await until(() => !!p.doc.querySelector("#new-agent-dialog"));
    await until(() => p.get<HTMLSelectElement>("#agent-machine").value === firstId);
    const before = (a: string, b: string) => assert.ok(p.get(a).compareDocumentPosition(p.get(b)) & p.dom.window.Node.DOCUMENT_POSITION_FOLLOWING);
    before("#agent-machine", "#agent-harness"); before("#agent-harness", "#agent-workspace"); before("#agent-workspace", "#agent-name");
    assert.equal(p.get<HTMLButtonElement>('#agent-harness [value="pi"]').disabled, true);
    assert.equal([...p.get<HTMLSelectElement>("#agent-machine").options].find(option => option.value === secondId)?.disabled, false);
    p.fill("#launch-model", "old-model"); p.fill("#agent-workspace", "folder"); await until(() => !!p.doc.querySelector("#browse-folders"));
    p.click("#browse-folders"); await until(() => p.doc.querySelector("#folder-current")?.textContent === "/first");
    assert.equal(p.doc.querySelectorAll(".folder-list .folder-item").length, 3);
    assert.equal(p.get('.folder-item[data-folder="/first/alpha"]').title, "/first/alpha"); assert.ok(p.get(".folder-item").querySelector("svg"));
    p.click("#folder-use"); await until(() => p.get<HTMLInputElement>("#agent-folder").value === "/first");
    p.click("#browse-folders"); await until(() => !!release);
    p.fill("#agent-machine", secondId); await until(() => p.get<HTMLInputElement>("#agent-folder").value === "" && p.get('[value="pi"]').getAttribute("data-state") === "checked");
    assert.equal(p.get<HTMLInputElement>("#launch-model").value, ""); assert.equal(p.get<HTMLButtonElement>('#agent-harness [value="omp"]').disabled, true);
    p.click("#browse-folders"); await until(() => p.doc.querySelector("#folder-current")?.textContent === "/second");
    const finishOld = release!; release = undefined; await finishOld(); assert.equal(p.get("#folder-current").textContent, "/second", "an old worker response cannot replace the new machine's browser");
    p.click("#folder-use"); await until(() => p.get<HTMLInputElement>("#agent-folder").value === "/second"); p.fill("#agent-name", "multi-host");
    p.submit("#agent-launch-form"); await until(() => launches.length === 1 && !!p.doc.querySelector("#launch-error"));
    assert.equal(launches[0].machineId, secondId); assert.equal(launches[0].spec.harness, "pi"); assert.equal(launches[0].spec.folder, "/second"); assert.equal(launches[0].spec.model, undefined);
    p.fill("#agent-machine", emptyId); await until(() => p.doc.querySelectorAll("#agent-harness [role=radio]:disabled").length === 4);
    assert.equal(p.get<HTMLButtonElement>("#agent-launch").disabled, true); p.submit("#agent-launch-form"); assert.equal(launches.length, 1);
    assert.deepEqual(errors, []); assert.deepEqual(p.errors, []);
  } finally { await release?.().catch(() => {}); await page?.close(); await Promise.all([first.close(), second.close(), empty.close()]); await server.close(); }
});
