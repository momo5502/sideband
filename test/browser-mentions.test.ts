import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM, VirtualConsole } from "jsdom";
import NodeWebSocket from "ws";
import { RoomServer } from "../src/room-server.js";
import { RoomClient } from "../src/room-client.js";

async function until(check: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 8000;
  while (!await check()) { if (Date.now() > deadline) throw new Error("Mention UI did not reach the expected state."); await new Promise(resolve => setTimeout(resolve, 10)); }
}
async function fixture(mobile: boolean, mode: "default" | "denied" | "insecure" | "unavailable" | "throws" = "default") {
  const server = await RoomServer.start({ host: "127.0.0.1", port: 0, statusPort: 0, graceMs: 60 });
  const profile = { server: `127.0.0.1:${server.port}`, password: server.password };
  const a = new RoomClient(profile, "agent-a"), b = new RoomClient(profile, "agent-b"), other = new RoomClient(profile, "outside");
  await a.connect(); await b.connect(); await other.connect();
  const alpha = await a.joinRoom("Alpha"), beta = await b.joinRoom("Beta"), unrelated = await other.joinRoom("Other");
  const pages: { dom: JSDOM; sockets: Set<NodeWebSocket> }[] = [], errors: Error[] = [];
  let permission: NotificationPermission = mode === "denied" ? "denied" : mode === "throws" || mode === "insecure" ? "granted" : "default";
  let requests = 0, focuses = 0;
  const notifications: { title: string; options: NotificationOptions; closed: boolean; onclick: ((event: Event) => void) | null }[] = [];
  async function open(saved?: string, identity?: string, rooms?: string) {
    const sockets = new Set<NodeWebSocket>(), console = new VirtualConsole(); console.on("jsdomError", error => errors.push(error));
    const dom = await JSDOM.fromURL(`http://127.0.0.1:${server.statusPort}/chat`, { resources: "usable", runScripts: "dangerously", virtualConsole: console,
      beforeParse(window) {
        Object.assign(window, { TextEncoder, TextDecoder, matchMedia: () => Object.assign(new window.EventTarget(), { matches: mobile }) });
        Object.defineProperty(window, "isSecureContext", { value: mode !== "insecure", configurable: true });
        window.focus = () => { focuses++; };
        if (mode !== "unavailable") window.Notification = class {
          static get permission() { return permission; }
          static async requestPermission() { requests++; return permission = "granted"; }
          closed = false; onclick: ((event: Event) => void) | null = null;
          constructor(public title: string, public options: NotificationOptions) {
            if (mode === "throws") throw new Error("Notifications unavailable on this device.");
            notifications.push(this);
          }
          close() { this.closed = true; }
        } as unknown as typeof Notification;
        window.WebSocket = class extends NodeWebSocket {
          constructor(url: string | URL) {
            super(String(url), { origin: `http://127.0.0.1:${server.statusPort}` }); sockets.add(this); this.once("close", () => sockets.delete(this));
          }
        } as unknown as typeof window.WebSocket;
        if (saved) window.localStorage.setItem("sideband.login.v1", saved);
        if (identity) window.sessionStorage.setItem("sideband.identity.v1", identity);
        if (rooms) window.sessionStorage.setItem("sideband.rooms.v1", rooms);
      } });
    const page = { dom, sockets }; pages.push(page); await until(() => dom.window.document.readyState === "complete"); return page;
  }
  return { server, a, b, other, alpha, beta, unrelated, open, notifications, errors,
    get requests() { return requests; }, get focuses() { return focuses; },
    async close() {
      for (const page of pages) { for (const socket of page.sockets) socket.terminate(); page.dom.window.close(); }
      await a.close(); await b.close(); await other.close(); await server.close();
    } };
}
async function login(f: Awaited<ReturnType<typeof fixture>>, page: Awaited<ReturnType<Awaited<ReturnType<typeof fixture>>["open"]>>) {
  const doc = page.dom.window.document;
  (doc.getElementById("username") as HTMLInputElement).value = "momo";
  (doc.getElementById("password") as HTMLInputElement).value = f.server.password;
  doc.getElementById("login-form")!.dispatchEvent(new page.dom.window.Event("submit", { cancelable: true }));
  await until(() => !doc.getElementById("app")!.hidden && !!doc.querySelector("#room-list button"));
}
function button(doc: Document, id: string) { return [...doc.querySelectorAll<HTMLButtonElement>("#room-list button")].find(button => button.dataset.roomId === id)!; }
function badge(doc: Document, id: string) { return button(doc, id).querySelector<HTMLElement>(".mention-badge")!; }
async function view(page: { dom: JSDOM }, id: string, name: string, mobile: boolean) {
  const doc = page.dom.window.document;
  if (mobile && !doc.body.classList.contains("menu-open")) doc.getElementById("menu-toggle")!.click();
  button(doc, id).click();
  await until(() => doc.getElementById("room-title")!.textContent === name && !(doc.getElementById("send") as HTMLButtonElement).disabled);
}

for (const mobile of [false, true]) test(`${mobile ? "mobile" : "desktop"} browser stays in multiple rooms and places mention badges on room buttons`, { timeout: 30000 }, async () => {
  const f = await fixture(mobile);
  try {
    const page = await f.open(), doc = page.dom.window.document; await login(f, page);
    assert.equal(f.requests, 0, "notification permission is requested only by a user click");
    await view(page, f.alpha.id, "Alpha", mobile); await view(page, f.beta.id, "Beta", mobile);
    assert.equal(button(doc, f.alpha.id).dataset.joined, "true"); assert.equal(button(doc, f.beta.id).dataset.joined, "true");
    assert.equal(button(doc, f.unrelated.id).dataset.joined, "false");
    const aMembers = await f.a.members(), bMembers = await f.b.members();
    assert.equal(aMembers.length, 2); assert.equal(bMembers.length, 2);
    assert.equal(aMembers.find(member => member.name === "momo")!.id, bMembers.find(member => member.name === "momo")!.id);
    if (mobile) doc.getElementById("menu-toggle")!.click();
    doc.getElementById("notifications")!.click(); await until(() => f.requests === 1 && (doc.getElementById("notifications") as HTMLButtonElement).disabled);
    if (mobile) doc.getElementById("menu-close")!.click();
    await f.a.send("Hey @momo, please check Alpha."); await until(() => !badge(doc, f.alpha.id).hidden);
    assert.equal(badge(doc, f.alpha.id).parentElement, button(doc, f.alpha.id), "badge is inside its room button");
    assert.equal(badge(doc, f.alpha.id).textContent, "@1"); assert.equal(f.notifications.length, 1); assert.match(f.notifications[0]!.title, /agent-a.*Alpha/);
    assert.ok(!doc.getElementById("messages")!.textContent!.includes("please check Alpha"), "background rooms never mix into the displayed conversation");
    await f.a.send("momo@example.com, @momoz and @momo-other are not exact mentions.");
    await f.b.send("Synchronization"); await until(() => doc.getElementById("messages")!.textContent!.includes("Synchronization"));
    assert.equal(f.notifications.length, 1); assert.equal(badge(doc, f.alpha.id).textContent, "@1");
    await f.b.send("@MOMO: please review Beta."); await until(() => f.notifications.length === 2);
    assert.equal(badge(doc, f.beta.id).textContent, "@1", "active-room mentions are also marked");
    (doc.getElementById("message") as HTMLTextAreaElement).value = "@momo note to myself";
    doc.getElementById("compose")!.dispatchEvent(new page.dom.window.Event("submit", { cancelable: true }));
    await until(() => (doc.getElementById("message") as HTMLTextAreaElement).value === ""); assert.equal(f.notifications.length, 2, "own messages do not ping");
    f.notifications[0]!.onclick!(new page.dom.window.Event("click"));
    await until(() => doc.getElementById("room-title")!.textContent === "Alpha" && badge(doc, f.alpha.id).hidden);
    assert.equal(f.focuses, 1); assert.equal(f.notifications[0]!.closed, true); assert.equal(badge(doc, f.beta.id).hidden, false);
    assert.equal(f.notifications.length, 2, "fetching history does not replay desktop notifications");
    await f.other.send("@momo you are not in this room"); await f.a.send("Visible barrier");
    await until(() => doc.getElementById("messages")!.textContent!.includes("Visible barrier"));
    assert.equal(f.notifications.length, 2); assert.equal(badge(doc, f.unrelated.id).hidden, true);
    const saved = page.dom.window.localStorage.getItem("sideband.login.v1")!, identity = page.dom.window.sessionStorage.getItem("sideband.identity.v1")!, rooms = page.dom.window.sessionStorage.getItem("sideband.rooms.v1")!;
    assert.deepEqual(new Set(JSON.parse(rooms).rooms), new Set(["Alpha", "Beta"]));
    for (const socket of page.sockets) socket.terminate();
    await until(async () => (await f.a.members()).length === 1 && (await f.b.members()).length === 1);
    const reloaded = await f.open(saved, identity, rooms), next = reloaded.dom.window.document;
    await until(() => next.getElementById("room-title")!.textContent === "Alpha" && !!button(next, f.alpha.id) && !!button(next, f.beta.id));
    assert.equal(button(next, f.alpha.id).dataset.joined, "true"); assert.equal(button(next, f.beta.id).dataset.joined, "true");
    assert.equal(badge(next, f.beta.id).textContent, "@1"); assert.equal(badge(next, f.beta.id).hidden, false, "unread badges survive a page reload");
    assert.equal(f.notifications.length, 2, "restoring memberships and history does not notify again");
    if (mobile) next.getElementById("menu-toggle")!.click();
    next.getElementById(mobile ? "menu-leave" : "leave")!.click();
    await until(() => next.getElementById("room-title")!.textContent === "Choose a room" && button(next, f.alpha.id).dataset.joined === "false");
    assert.equal(button(next, f.beta.id).dataset.joined, "true");
    await f.a.send("@momo after leaving Alpha"); await f.b.send("@momo still joined to Beta");
    await until(() => badge(next, f.beta.id).textContent === "@2"); assert.equal(f.notifications.length, 3); assert.equal(badge(next, f.alpha.id).hidden, true);
    next.getElementById("logout")!.click(); await until(async () => (await f.b.members()).length === 1);
    assert.equal(reloaded.dom.window.sessionStorage.getItem("sideband.rooms.v1"), null); assert.equal(next.title, "Sideband chat");
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

for (const mode of ["denied", "insecure", "unavailable", "throws"] as const) test(`mention badges work when desktop notifications are ${mode}`, async () => {
  const f = await fixture(false, mode);
  try {
    const page = await f.open(), doc = page.dom.window.document; await login(f, page);
    await view(page, f.alpha.id, "Alpha", false); await view(page, f.beta.id, "Beta", false);
    await f.a.send("@momo ping"); await until(() => !badge(doc, f.alpha.id).hidden);
    assert.equal(f.notifications.length, 0); assert.equal(badge(doc, f.alpha.id).textContent, "@1");
    assert.match(doc.getElementById("notification-status")!.textContent!, mode === "denied" ? /blocked/ : mode === "insecure" ? /HTTPS/ : mode === "unavailable" ? /unavailable/ : /could not be displayed/);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
