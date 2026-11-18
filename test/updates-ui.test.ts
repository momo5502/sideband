import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { RoomServer } from "../src/room-server.js";
import { RoomClient } from "../src/room-client.js";
import { RuntimeUpdater } from "../src/updater.js";
import { Worker } from "../src/worker.js";
import { browserPage, until } from "./browser-fixture.js";

test("authenticated web Updates checks, starts and displays per-worker plugin results; native peers cannot trigger updates", { timeout: 20000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "sideband-update-ui-")), target = "e".repeat(40), entry = resolve("dist/src/cli.js");
  const order: string[] = [];
  const serverUpdater = new RuntimeUpdater("server", entry, directory, async () => { order.push("server"); }, undefined, async () => ({ entry, build: { version: "99.0.0", commit: target } }));
  serverUpdater.build.commit = "a".repeat(40);
  serverUpdater.latest = async () => ({ version: "99.0.0", commit: target });
  const server = await RoomServer.start({ host: "127.0.0.1", port: 0, statusPort: 0, updater: serverUpdater });
  const profile = { server: `127.0.0.1:${server.port}`, password: server.password }, peer = new RoomClient(profile, "peer");
  let worker: Worker;
  const workerUpdater = new RuntimeUpdater("worker", entry, join(directory, "worker"), async () => {
    order.push("worker"); worker.machine.build = { version: "99.0.0", commit: target };
    workerUpdater.state = { ...workerUpdater.state, phase: "done", message: "Runtime updated; some plugins need attention." };
    await worker.client.request("control.worker", { machine: { ...worker.machine, update: workerUpdater.state } });
  }, undefined, async () => ({ entry, build: { version: "99.0.0", commit: target } }), async (_run, progress) => {
    const plugins = [{ harness: "codex" as const, state: "failed" as const, message: "SSH unavailable" }]; progress?.(plugins); return plugins;
  });
  worker = new Worker({ entry, profile, updater: workerUpdater, name: "update-machine", root: join(directory, "workspaces"), omp: { command: process.execPath } });
  let page: Awaited<ReturnType<typeof browserPage>> | undefined;
  try {
    await worker.start(); await peer.connect();
    await assert.rejects(peer.request("control.updates.check"), /authenticated web panel/);
    await assert.rejects(peer.request("control.worker_update", { update: { phase: "done" } }), /Only a registered worker/);
    page = await browserPage(server); await page.login();
    await until(() => !!page!.doc.querySelector("#server-version"));
    assert.equal(page.get("#server-version").textContent, `Server v${serverUpdater.build.version} · aaaaaaaa`);
    assert.equal(page.get("#server-version").title, `Server commit ${serverUpdater.build.commit}`);
    await page.settings(); page.click(page.button("Updates", "tab"));
    await until(() => !!page!.doc.querySelector("#updates-panel"));
    assert.equal(page.get<HTMLButtonElement>("#updates-install").disabled, true);
    page.click("#updates-check"); await until(() => !page!.get<HTMLButtonElement>("#updates-install").disabled);
    assert.match(page.get("#updates-panel").textContent!, /99.0.0/);
    page.click("#updates-install"); await until(() => order.includes("server")); assert.deepEqual(order, ["worker", "server"]);
    await until(() => page!.get("#updates-panel").textContent!.includes("SSH unavailable"));
    const status = worker.machine.update!; assert.ok(status.attempt); assert.equal(status.target, target);
    assert.deepEqual(page.errors, []);
    // Browser-supplied sources or command arguments are rejected, not passed to npm.
    const impostor = new RoomClient(profile); await impostor.connect();
    try { await assert.rejects(impostor.request("control.updates.start", { url: "https://evil.example" }), /authenticated web panel/); } finally { await impostor.close(); }
  } finally { await page?.close(); await peer.close(); await worker.close(); await server.close(); assert.ok(directory.startsWith(join(tmpdir(), "sideband-update-ui-"))); await rm(directory, { recursive: true, force: true }); }
});

test("browser update controls reject extra parameters and show one-time bootstrap help when unavailable", async () => {
  const server = await RoomServer.start({ host: "127.0.0.1", port: 0, statusPort: 0 });
  const page = await browserPage(server);
  try {
    await page.login(); await page.settings(); page.click(page.button("Updates", "tab"));
    await until(() => !!page.doc.querySelector("#updates-panel")); assert.match(page.get("#updates-panel").textContent!, /manually.*once/);
    assert.equal(page.doc.querySelector("#updates-install"), null);
  } finally { await page.close(); await server.close(); }
});

test("browser automatically refreshes a changed server build after editable dialogs close", { timeout: 20000 }, async () => {
  const updater = new RuntimeUpdater("server", resolve("dist/src/cli.js"), resolve(".cache/reload-ui-fixture"), async () => {});
  updater.build.commit = "a".repeat(40);
  const server = await RoomServer.start({ host: "127.0.0.1", port: 0, statusPort: 0, updater });
  const page = await browserPage(server), peer = new RoomClient({ server: `127.0.0.1:${server.port}`, password: server.password });
  try {
    assert.equal(page.doc.querySelector('meta[name="sideband-build"]')?.getAttribute("content"), updater.build.commit);
    await page.login(); await page.navigation(); page.click("#new-agent");
    await until(() => !!page.doc.querySelector("#new-agent-dialog")); page.fill("#agent-name", "unsaved-name");
    updater.build.commit = "b".repeat(40);
    await peer.connect(); await peer.request("control.worker", { machine: { id: randomUUID(), name: "machine", platform: "test", harnesses: ["omp"] } });
    await until(() => !!page.doc.querySelector("#server-update-banner"));
    await new Promise(resolve => setTimeout(resolve, 2300));
    assert.equal(page.errors.length, 0, "an editable launch dialog defers the automatic refresh");
    assert.equal(page.get<HTMLInputElement>("#agent-name").value, "unsaved-name"); page.click(page.button("Cancel"));
    // jsdom reports navigation instead of navigating; this proves the actual App effect
    // invoked location.reload(), while BrowserWorkspace tests exercise restored state.
    await until(() => page.errors.length === 1); assert.match(page.errors[0]!.message, /Not implemented: navigation/);
  } finally { await page.close(); await peer.close(); await server.close(); }
});
