import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { RoomServer } from "../src/room-server.js";
import { RoomClient } from "../src/room-client.js";
import { AgentKeys, verifyMessage, type PresenceEvent } from "../src/room-protocol.js";
import { browserPage, until } from "./browser-fixture.js";

test("a send racing a rename is re-signed once, and missing saved room IDs fall back to their name", async () => {
  const server = await RoomServer.start({ host: "127.0.0.1", port: 0 });
  const peer = new RoomClient({ server: `127.0.0.1:${server.port}`, password: server.password }, "before");
  let release: (() => void) | undefined;
  try {
    await peer.connect(); const room = await peer.joinRoom(randomUUID(), "recovered"); assert.equal(room.name, "recovered");
    const request = peer.request.bind(peer), gate = new Promise<void>(resolve => { release = resolve; }); let sends = 0;
    peer.request = async (method, params) => { if (method === "send" && ++sends === 1) await gate; return request(method, params) as never; };
    const sent = peer.send("In flight"); await peer.rename("after"); release!(); await sent;
    assert.equal(sends, 2); const history = await peer.history(); assert.equal(history.length, 1);
    assert.equal(history[0]!.sender.name, "after"); assert.ok(verifyMessage(history[0]));
  } finally { release?.(); await peer.close(); await server.close(); }
});

for (const mobile of [false, true]) test(`room rename preserves membership, signed history and drafts (${mobile ? "phone" : "desktop"})`, async () => {
  const directory = await mkdtemp(join(tmpdir(), "sideband-rename-"));
  const options = { host: "127.0.0.1", port: 0, statusPort: 0, credentialsFile: join(directory, "server.json"), databaseFile: join(directory, "server.sqlite") };
  let server = await RoomServer.start(options), page = await browserPage(server, { mobile });
  const profile = { server: `127.0.0.1:${server.port}`, password: server.password }, peer = new RoomClient(profile, "reviewer"), other = new RoomClient(profile, "reviewer");
  let restored: RoomClient | undefined, second: Awaited<ReturnType<typeof browserPage>> | undefined;
  try {
    await peer.connect(); await other.connect(); const room = await peer.joinRoom("original"); await other.joinRoom(room.id);
    await peer.send("Before rename"); const identity = peer.identity.id, publicKey = peer.identity.publicKey;
    const events: PresenceEvent[] = []; peer.onPresence(event => events.push(event));
    await page.login("admin"); await page.view(room.id, room.name);
    second = await browserPage(server); await second.login("admin"); await second.view(room.id, room.name);
    page.fill("#message", "An unsent draft");
    page.click('[aria-label="Room actions"]'); await until(() => !!page!.doc.querySelector('[role="menuitem"]')); page.click(page.button("Rename room", "menuitem"));
    await until(() => !!page.doc.querySelector("#rename-name")); page.fill("#rename-name", "renamed room"); page.click("#rename-apply");
    await until(() => page.doc.querySelector("#room-title")?.textContent === "renamed room" && !page.doc.querySelector("#rename-dialog"));
    await until(() => second!.doc.querySelector("#room-title")?.textContent === "renamed room");
    assert.equal(page.get<HTMLTextAreaElement>("#message").value, "An unsent draft");
    await until(() => events.some(event => event.rename?.kind === "room"));
    assert.equal(peer.room?.id, room.id); assert.equal(peer.room?.name, "renamed room");
    assert.ok([...page.doc.querySelectorAll(".presence-event")].some(event => event.textContent?.includes("original")));
    await peer.rename("admin"); await other.rename("admin");
    await until(() => events.filter(event => event.rename?.kind === "agent").length === 2);
    assert.equal(peer.identity.id, identity); assert.equal(peer.identity.publicKey, publicKey);
    await peer.send("After rename"); const history = await peer.history();
    assert.deepEqual(history.map(message => message.sender.name), ["reviewer", "admin"]); assert.ok(history.every(verifyMessage));
    assert.equal((await peer.members()).filter(member => member.name === "admin").length, 4);
    const freshKeys = new AgentKeys("reviewer", peer.keys.exportPrivateKey());
    await page.close(); await second.close(); second = undefined; await peer.close(); await other.close(); await server.close();
    server = await RoomServer.start(options);
    restored = new RoomClient({ server: `127.0.0.1:${server.port}`, password: server.password }, "reviewer", { keys: freshKeys });
    await restored.connect(); assert.equal(restored.identity.name, "admin"); assert.equal(restored.identity.id, identity);
    assert.equal((await restored.joinRoom(room.id)).name, "renamed room"); assert.deepEqual(await restored.history(), []);
    page = await browserPage(server, { mobile }); await page.login("admin"); await page.view(room.id, "renamed room");
    page.click('[aria-label="Room actions"]'); await until(() => !!page!.doc.querySelector('[role="menuitem"]')); page.click(page.button("Rename room", "menuitem"));
    await until(() => !!page.doc.querySelector("#rename-name")); page.fill("#rename-name", "final name"); page.click("#rename-apply");
    await until(() => page.doc.querySelector("#room-title")?.textContent === "final name");
    assert.equal(restored.room?.id, room.id);
  } finally { await page.close(); await second?.close(); await peer.close(); await other.close(); await restored?.close(); await server.close(); await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
});
