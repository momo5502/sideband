import test from "node:test";
import assert from "node:assert/strict";
import { RoomServer } from "../src/room-server.js";
import { RoomClient } from "../src/room-client.js";
import { browserPage, until } from "./browser-fixture.js";

for (const mobile of [false, true]) test(`${mobile ? "mobile" : "desktop"} multi-room chat: unread messages, exact mentions, notifications, visibility and live room discovery`, { timeout: 20000 }, async () => {
  const server = await RoomServer.start({ host: "127.0.0.1", port: 0, statusPort: 0 });
  const profile = { server: `127.0.0.1:${server.port}`, password: server.password };
  const a = new RoomClient(profile, "alice"), b = new RoomClient(profile, "bob"); let page: Awaited<ReturnType<typeof browserPage>> | undefined;
  try {
    await a.connect(); await b.connect(); const alpha = await a.joinRoom("Alpha"), beta = await b.joinRoom("Beta");
    page = await browserPage(server, { mobile }); const p = page; await p.login("momo"); await p.view(alpha.id, "Alpha"); await p.view(beta.id, "Beta");
    assert.equal((await a.members()).find(member => member.name === "momo")!.id, (await b.members()).find(member => member.name === "momo")!.id);
    await p.settings(); p.click("#notifications"); await until(() => p.requests === 1); p.click('#settings-dialog button[aria-label="Close dialog"]');
    await a.send("Regular message"); await a.send("Hey @momo, check Alpha.");
    await p.navigation(); await until(() => !!p.room(alpha.id)?.querySelector(".unread-badge"));
    const badge = () => p.room(alpha.id).querySelector<HTMLElement>(".mention-badge")!;
    await until(() => !badge().hidden); assert.equal(badge().parentElement, p.room(alpha.id)); assert.equal(badge().textContent, "@1");
    assert.equal(p.room(alpha.id).querySelector(".unread-badge")!.textContent, "2"); assert.equal(p.notifications.length, 1);
    assert.match(p.notifications[0]!.title, /alice.*Alpha/); assert.ok(!p.doc.querySelector("#messages")?.textContent?.includes("check Alpha"));
    await a.send("momo@example.com, @momoz and @momo-other are not exact mentions");
    await b.send("Synchronization"); await until(() => p.doc.querySelector("#messages")?.textContent?.includes("Synchronization") ?? false); assert.equal(p.notifications.length, 1);
    if (mobile) p.click("#menu-close"); p.notifications[0]!.onclick!();
    await until(() => p.doc.querySelector("#room-title")?.textContent === "Alpha"); await p.navigation(); await until(() => badge().hidden);
    assert.equal(p.focuses, 1); assert.equal(p.notifications.length, 1, "history does not notify again"); if (mobile) p.click("#menu-close");
    Object.defineProperty(p.doc, "visibilityState", { configurable: true, value: "hidden" }); await a.send("A message while hidden");
    await p.navigation(); await until(() => !!p.room(alpha.id).querySelector(".unread-badge"));
    Object.defineProperty(p.doc, "visibilityState", { configurable: true, value: "visible" }); p.doc.dispatchEvent(new p.dom.window.Event("visibilitychange"));
    await until(() => !p.room(alpha.id).querySelector(".unread-badge"));
    await b.joinRoom("Discovered live"); await until(() => !![...p.doc.querySelectorAll("#room-list button")].find(node => node.textContent?.includes("Discovered live")));
    assert.deepEqual(p.errors, []);
  } finally { await page?.close(); await a.close(); await b.close(); await server.close(); }
});
for (const notification of ["denied", "insecure", "unavailable", "throws"] as const) test(`mention badges survive ${notification} desktop notifications`, async () => {
  const server = await RoomServer.start({ host: "127.0.0.1", port: 0, statusPort: 0 }); const profile = { server: `127.0.0.1:${server.port}`, password: server.password };
  const a = new RoomClient(profile, "alice"), b = new RoomClient(profile, "bob"); let page: Awaited<ReturnType<typeof browserPage>> | undefined;
  try {
    await a.connect(); await b.connect(); const alpha = await a.joinRoom("Alpha"), beta = await b.joinRoom("Beta");
    page = await browserPage(server, { notification }); const p = page; await p.login("momo"); await p.view(alpha.id, "Alpha"); await p.view(beta.id, "Beta");
    await a.send("@momo ping"); await until(() => p.room(alpha.id).querySelector<HTMLElement>(".mention-badge")!.hidden === false);
    assert.equal(p.notifications.length, 0); assert.equal(p.room(alpha.id).querySelector(".mention-badge")!.textContent, "@1");
    await p.settings(); assert.match(p.get("#notification-status").textContent!, notification === "denied" ? /blocked/ : notification === "insecure" ? /HTTPS/ : notification === "unavailable" ? /unavailable/ : /notified/);
    assert.deepEqual(p.errors, []);
  } finally { await page?.close(); await a.close(); await b.close(); await server.close(); }
});
