import test from "node:test";
import assert from "node:assert/strict";
import { RoomServer } from "../src/room-server.js";
import { RoomClient } from "../src/room-client.js";
import { browserPage, until } from "./browser-fixture.js";

for (const mobile of [false, true]) test(`${mobile ? "mobile" : "desktop"} React chat: signed messages, grouped Markdown, navigation, members, drafts, settings and saved login`, { timeout: 30000 }, async () => {
  const server = await RoomServer.start({ host: "127.0.0.1", port: 0, statusPort: 0 });
  const agent = new RoomClient({ server: `127.0.0.1:${server.port}`, password: server.password }, "agent-peer");
  const pages: Awaited<ReturnType<typeof browserPage>>[] = [];
  try {
    await agent.connect(); const room = await agent.joinRoom("project"); await agent.send("Before you joined\nSecond line\n\n**history**");
    const page = await browserPage(server, { mobile }); pages.push(page);
    assert.equal(page.sockets.size, 0); await page.login(); await page.view(room.id, "project");
    await until(() => !!page.doc.querySelector("#messages strong"));
    assert.equal(page.doc.title, "project — Sideband"); assert.equal(page.doc.querySelectorAll(".pane-header").length, 1);
    assert.equal(page.doc.querySelector("#navigation-dialog"), null, "mobile chat uses the full screen after selecting a room");
    const history = page.get("#messages .message-body"); assert.equal(history.querySelectorAll("br").length, 1); assert.equal(history.querySelectorAll("p").length, 2);
    const received: string[] = []; agent.onMessage(message => received.push(message.text));
    page.fill("#message", "My message\n**bold**"); page.submit("#compose"); await until(() => received.length === 1);
    assert.equal(received[0], "My message\n**bold**"); await until(() => page.get<HTMLTextAreaElement>("#message").value === "");
    page.fill("#message", "Unsent draft"); await agent.send('<img src=x onerror="window.hacked=true">\n<script>window.hacked=true</script>');
    await until(() => page.get("#messages").textContent!.includes("window.hacked=true"));
    assert.equal(page.doc.querySelector("#messages img, #messages script"), null); assert.equal((page.dom.window as any).hacked, undefined);
    assert.equal(page.get<HTMLTextAreaElement>("#message").value, "Unsent draft");
    await agent.send("Another message"); await until(() => page.get("#messages").textContent!.includes("Another message"));
    assert.ok(page.doc.querySelector(".message-continuation"), "consecutive messages group the sender header");
    page.click('button[aria-label="Room members"]'); await until(() => page.doc.body.textContent!.includes("Participants · 2"));
    assert.ok([...page.doc.querySelectorAll(".member-row .sender")].some(node => node.textContent === "agent-peer"));
    if (page.doc.querySelector("#details-dialog")) page.click('#details-dialog button[aria-label="Close dialog"]'); else page.click('button[aria-label="Room members"]');
    await page.settings(); page.click(page.button("Webhooks", "tab")); await until(() => !!page.doc.querySelector("#webhook-form"));
    assert.equal(page.get<HTMLSelectElement>("#webhook-room").value, "project"); page.fill("#webhook-sender", "github"); page.submit("#webhook-form");
    await until(() => !!page.doc.querySelector("#webhook-url")); const webhook = page.get<HTMLTextAreaElement>("#webhook-url").value;
    assert.equal(new URL(webhook).origin, page.dom.window.location.origin); assert.ok(new URL(webhook).searchParams.get("token"));
    page.click('#settings-dialog button[aria-label="Close dialog"]');
    const posted = await fetch(webhook, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ task: "completed", result: "ok" }) });
    assert.equal(posted.status, 204); await until(() => !!page.doc.querySelector("#messages pre"));
    assert.equal(page.get("#messages pre code").textContent, "task: completed\nresult: ok\n");
    await page.navigation(); page.click('button[aria-label="Join or create a room"]'); await until(() => !!page.doc.querySelector("#join-room-dialog"));
    page.fill("#room-name", "another"); page.submit("#join-form"); await until(() => page.doc.querySelector("#room-title")?.textContent === "another" && !page.doc.querySelector("#join-room-dialog"));
    const saved = page.save(); assert.deepEqual(new Set(JSON.parse(saved.rooms!).rooms), new Set(["project", "another"]));
    await page.view(room.id, "project"); assert.equal(page.get<HTMLTextAreaElement>("#message").value, "Unsent draft", "drafts are per conversation");
    const reloadState = page.save(), key = JSON.parse(reloadState.identity!).key; await page.close();
    const reloaded = await browserPage(server, { mobile, saved: reloadState }); pages.push(reloaded);
    await until(() => reloaded.doc.querySelector("#room-title")?.textContent === "project");
    assert.equal(JSON.parse(reloaded.save().identity!).key, key); assert.equal(reloaded.doc.title, "project — Sideband");
    await reloaded.settings(); reloaded.click("#logout"); await until(() => !!reloaded.doc.querySelector("#login-form"));
    reloaded.click("#forget"); await until(() => !reloaded.save().login);
    assert.equal(reloaded.save().identity, null); assert.equal(reloaded.get<HTMLInputElement>("#password").value, "");
    assert.deepEqual(page.errors, []); assert.deepEqual(reloaded.errors, []);
  } finally { for (const page of pages) await page.close(); await agent.close(); await server.close(); }
});

test("browser automatically reconnects and rejoins after a lost socket, preserving identity, draft and bfcache navigation", { timeout: 15000 }, async () => {
  const server = await RoomServer.start({ host: "127.0.0.1", port: 0, statusPort: 0, graceMs: 60 });
  const peer = new RoomClient({ server: `127.0.0.1:${server.port}`, password: server.password }, "peer");
  const pages: Awaited<ReturnType<typeof browserPage>>[] = [];
  try {
    await peer.connect(); const room = await peer.joinRoom("reconnect"); const page = await browserPage(server); pages.push(page); await page.login(); await page.view(room.id, room.name);
    const identity = JSON.parse(page.save().identity!).key; page.fill("#message", "Preserve my draft");
    for (const socket of page.sockets) socket.terminate();
    await until(() => page.get("#connection").textContent!.includes("Reconnecting"));
    await until(async () => page.get("#connection").textContent!.includes("Connected") && (await peer.members()).length === 2);
    assert.equal(JSON.parse(page.save().identity!).key, identity); assert.equal(page.get<HTMLTextAreaElement>("#message").value, "Preserve my draft");
    page.dom.window.dispatchEvent(new page.dom.window.PageTransitionEvent("pagehide", { persisted: true }));
    page.dom.window.dispatchEvent(new page.dom.window.PageTransitionEvent("pageshow", { persisted: true }));
    await peer.send("After browser restore"); await until(() => page.get("#messages").textContent!.includes("After browser restore"));
    const sent: string[] = []; peer.onMessage(message => sent.push(message.text)); page.key("#message", "Enter"); await until(() => sent.length === 1);
    assert.equal(sent[0], "Preserve my draft"); assert.deepEqual(page.errors, []);
  } finally { for (const page of pages) await page.close(); await peer.close(); await server.close(); }
});

test("failed auto-login can be retried; forgetting during a connection cancels it without restoring credentials", async () => {
  const server = await RoomServer.start({ host: "127.0.0.1", port: 0, statusPort: 0 }); const pages: Awaited<ReturnType<typeof browserPage>>[] = [];
  try {
    const bad = server.password.slice(0, -1) + (server.password.endsWith("A") ? "B" : "A");
    const page = await browserPage(server, { saved: { login: JSON.stringify({ name: "retry", password: bad }) } }); pages.push(page);
    await until(() => !!page.doc.querySelector("#login-error") && !page.get<HTMLButtonElement>("#login-button").disabled);
    await page.login("retry"); assert.equal(page.doc.querySelector("#login-error"), null);
    const cancelled = await browserPage(server, { saved: { login: JSON.stringify({ name: "cancel", password: server.password }) }, onOpen: window => window.document.getElementById("forget")?.click() }); pages.push(cancelled);
    await until(() => cancelled.doc.querySelector("#login-error")?.textContent === "Saved login removed." && cancelled.sockets.size === 0);
    assert.equal(cancelled.save().login, null); assert.equal(cancelled.save().identity, null); assert.equal(cancelled.doc.querySelector("#app"), null);
  } finally { for (const page of pages) await page.close(); await server.close(); }
});
