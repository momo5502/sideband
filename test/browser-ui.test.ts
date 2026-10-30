import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM, VirtualConsole } from "jsdom";
import NodeWebSocket from "ws";
import { RoomServer } from "../src/room-server.js";
import { RoomClient } from "../src/room-client.js";

async function until(check: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!check()) { if (Date.now() > deadline) throw new Error("Web UI did not reach the expected state."); await new Promise(resolve => setTimeout(resolve, 10)); }
}
for (const mobile of [false, true]) test(`served ${mobile ? "mobile" : "desktop"} web UI: login, menu, storage, signed chat, safe text, room switching, tab reload and forget`, { timeout: 20000 }, async () => {
  const server = await RoomServer.start({ host: "127.0.0.1", port: 0, statusPort: 0 });
  const agent = new RoomClient({ server: `127.0.0.1:${server.port}`, password: server.password }, "agent-peer");
  const sockets = new Set<NodeWebSocket>(); const pages: JSDOM[] = []; const errors: Error[] = [];
  const open = async (saved?: string | null, identity?: string | null) => {
    const console = new VirtualConsole(); console.on("jsdomError", error => errors.push(error));
    // Only our locally served test app executes. No user pages or external scripts are loaded.
    const dom = await JSDOM.fromURL(`http://127.0.0.1:${server.statusPort}/chat`, {
      resources: "usable", runScripts: "dangerously", virtualConsole: console,
      beforeParse(window) {
        Object.assign(window, { TextEncoder, TextDecoder, matchMedia: () => Object.assign(new window.EventTarget(), { matches: mobile }) });
        assert.equal(window.crypto.subtle, undefined, "exercise HTTP without Web Crypto signing");
        window.WebSocket = class extends NodeWebSocket {
          constructor(url: string | URL) { super(String(url), { origin: `http://127.0.0.1:${server.statusPort}` }); sockets.add(this); this.once("close", () => sockets.delete(this)); }
        } as unknown as typeof window.WebSocket;
        if (saved) window.localStorage.setItem("sideband.login.v1", saved);
        if (identity) window.sessionStorage.setItem("sideband.identity.v1", identity);
      },
    });
    pages.push(dom); await until(() => dom.window.document.readyState === "complete");
    if (mobile) {
      // jsdom has no viewport/media-query layout engine. Apply the app's actual narrow-screen
      // rules so visibility/focus checks exercise the same CSS branch as the matchMedia stub.
      const rules = [...dom.window.document.styleSheets].flatMap(sheet => [...sheet.cssRules]).filter(rule => rule.type === 4);
      const style = dom.window.document.createElement("style");
      style.textContent = rules.flatMap(rule => [...(rule as CSSMediaRule).cssRules].map(child => child.cssText)).join("\n");
      dom.window.document.head.append(style);
    }
    return dom;
  };
  try {
    await agent.connect(); await agent.joinRoom("agents-room"); await agent.send("Before the human joined\nHistory newline\n\n**history**");
    const dom = await open(); const doc = dom.window.document;
    const input = (id: string) => doc.getElementById(id) as HTMLInputElement;
    input("username").value = "human"; input("password").value = server.password;
    doc.getElementById("login-form")!.dispatchEvent(new dom.window.Event("submit", { cancelable: true }));
    await until(() => !!doc.querySelector("#room-list button"));
    assert.equal(doc.getElementById("login-panel")!.hidden, true); assert.match(doc.getElementById("connection")!.textContent!, /HTTP \(unencrypted\)/);
    assert.equal(doc.body.classList.contains("chatting"), true);
    assert.equal(doc.body.classList.contains("menu-open"), mobile, "mobile opens room selection at login; desktop keeps its normal sidebar");
    assert.equal(doc.querySelector("main")!.inert, mobile);
    if (mobile) {
      assert.equal(doc.getElementById("room-menu")!.getAttribute("role"), "dialog");
      assert.equal(doc.getElementById("menu-toggle")!.getAttribute("aria-expanded"), "true");
      assert.equal(doc.activeElement?.id, "menu-close");
      doc.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Tab", shiftKey: true, cancelable: true }));
      assert.equal(doc.activeElement, doc.querySelector("#room-menu a"));
      doc.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Tab", cancelable: true }));
      assert.equal(doc.activeElement?.id, "menu-close");
      doc.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", cancelable: true }));
      assert.equal(doc.body.classList.contains("menu-open"), false); assert.equal(doc.getElementById("room-menu")!.inert, true);
      assert.equal(doc.activeElement?.id, "menu-toggle");
      doc.getElementById("menu-toggle")!.click(); doc.getElementById("menu-backdrop")!.click();
      assert.equal(doc.getElementById("menu-toggle")!.getAttribute("aria-expanded"), "false");
      doc.getElementById("menu-toggle")!.click(); doc.getElementById("menu-close")!.click();
      assert.equal(doc.body.classList.contains("menu-open"), false);
      doc.getElementById("menu-toggle")!.click();
    }
    const saved = dom.window.localStorage.getItem("sideband.login.v1"); const identity = dom.window.sessionStorage.getItem("sideband.identity.v1");
    assert.ok(JSON.parse(saved!).password === server.password); assert.equal(JSON.parse(saved!).name, "human");
    (doc.querySelector("#room-list button") as HTMLButtonElement).click();
    await until(() => doc.getElementById("messages")!.textContent!.includes("Before the human joined"));
    await until(() => !(doc.getElementById("send") as HTMLButtonElement).disabled);
    const historyBody = [...doc.querySelectorAll("#messages .message-body")].find(body => body.querySelector("strong")?.textContent === "history")!;
    assert.equal(historyBody.querySelectorAll("br").length, 1); assert.equal(historyBody.querySelectorAll("p").length, 2);
    assert.equal(doc.body.classList.contains("menu-open"), false, "selecting a room closes the drawer");
    assert.equal(doc.querySelector("main")!.inert, false);
    assert.equal(doc.getElementById("room-menu")!.inert, mobile);
    if (mobile) {
      assert.equal(dom.window.getComputedStyle(doc.querySelector("header")!).display, "none");
      assert.equal(dom.window.getComputedStyle(doc.getElementById("room-menu")!).visibility, "hidden");
      assert.equal(dom.window.getComputedStyle(doc.getElementById("room-menu")!).position, "fixed");
      assert.equal(dom.window.getComputedStyle(doc.getElementById("app")!).height, "100dvh");
      assert.equal(dom.window.getComputedStyle(doc.getElementById("leave")!).display, "none");
    }
    const received: string[] = []; agent.onMessage(message => received.push(message.text));
    const outgoing = "Browser to agent\nSecond line\n\n**bold**";
    input("message").value = outgoing; doc.getElementById("compose")!.dispatchEvent(new dom.window.Event("submit", { cancelable: true }));
    await until(() => received.length > 0 || !!doc.getElementById("notice")!.textContent);
    assert.equal(doc.getElementById("notice")!.textContent, ""); assert.equal(received[0], outgoing, "Markdown display never changes the signed message sent to agents");
    await until(() => input("message").value === "");
    const ownBody = [...doc.querySelectorAll("#messages .message-body")].find(body => body.querySelector("strong")?.textContent === "bold")!;
    assert.equal(ownBody.querySelectorAll("br").length, 1); assert.equal(ownBody.querySelectorAll("p").length, 2);
    const hostile = '<img src=x onerror="window.hacked=true">\n<script>window.hacked=true</script>';
    input("message").value = "Unsent draft"; await agent.send(hostile);
    await until(() => doc.getElementById("messages")!.textContent!.includes("<script>window.hacked=true</script>"));
    assert.equal(doc.querySelector("#messages img, #messages script"), null); assert.equal((dom.window as any).hacked, undefined);
    assert.equal(input("message").value, "Unsent draft", "push must preserve the draft");
    await agent.send("**Incoming**\r\nSecond line\r\n\r\n- first\r\n- second");
    await until(() => !![...doc.querySelectorAll("#messages strong")].find(element => element.textContent === "Incoming"));
    const incomingBody = [...doc.querySelectorAll("#messages .message-body")].find(body => body.querySelector("strong")?.textContent === "Incoming")!;
    assert.equal(incomingBody.querySelectorAll("br").length, 1); assert.equal(incomingBody.querySelectorAll("li").length, 2);
    if (mobile) doc.getElementById("menu-toggle")!.click();
    input("room-name").value = "another-room"; doc.getElementById("join-form")!.dispatchEvent(new dom.window.Event("submit", { cancelable: true }));
    await until(() => doc.getElementById("room-title")!.textContent === "another-room");
    await until(() => !(doc.getElementById("send") as HTMLButtonElement).disabled);
    assert.equal(doc.body.classList.contains("menu-open"), false, "creating a room closes the drawer too");
    assert.ok(!doc.getElementById("messages")!.textContent!.includes("<script>window.hacked=true</script>"));
    const previousKey = JSON.parse(identity!).key;
    // A real reload retains per-origin localStorage and this tab's sessionStorage.
    const reloaded = await open(saved, identity); const next = reloaded.window.document;
    assert.ok((next.getElementById("password") as HTMLInputElement).value === server.password);
    assert.equal((next.getElementById("username") as HTMLInputElement).value, "human");
    next.getElementById("login-form")!.dispatchEvent(new reloaded.window.Event("submit", { cancelable: true }));
    await until(() => next.getElementById("room-title")!.textContent === "another-room");
    assert.equal(next.body.classList.contains("menu-open"), false, "restoring a room starts with full-screen chat, not the drawer");
    assert.equal(JSON.parse(reloaded.window.sessionStorage.getItem("sideband.identity.v1")!).key, previousKey);
    if (mobile) {
      next.getElementById("menu-toggle")!.click(); next.getElementById("menu-leave")!.click();
      await until(() => next.getElementById("room-title")!.textContent === "Choose a room");
      assert.equal(next.body.classList.contains("menu-open"), true, "leaving a room keeps room selection accessible");
      assert.equal(next.getElementById("menu-leave")!.hidden, true);
    }
    next.getElementById("logout")!.click(); await until(() => !next.getElementById("login-panel")!.hidden);
    assert.equal(next.body.classList.contains("chatting"), false); assert.equal(next.body.classList.contains("menu-open"), false);
    next.getElementById("forget")!.click();
    assert.equal(reloaded.window.localStorage.getItem("sideband.login.v1"), null); assert.equal(reloaded.window.sessionStorage.getItem("sideband.identity.v1"), null);
    assert.equal((next.getElementById("password") as HTMLInputElement).value, "");
    assert.deepEqual(errors, []);
  } finally { for (const socket of sockets) socket.terminate(); for (const page of pages) page.window.close(); await agent.close(); await server.close(); }
});
