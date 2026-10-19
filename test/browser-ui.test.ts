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
test("served web UI: login, storage, signed chat, safe text, room switching, tab reload and forget", { timeout: 20000 }, async () => {
  const server = await RoomServer.start({ host: "127.0.0.1", port: 0, statusPort: 0 });
  const agent = new RoomClient({ server: `127.0.0.1:${server.port}`, password: server.password }, "agent-peer");
  const sockets = new Set<NodeWebSocket>(); const pages: JSDOM[] = []; const errors: Error[] = [];
  const open = async (saved?: string | null, identity?: string | null) => {
    const console = new VirtualConsole(); console.on("jsdomError", error => errors.push(error));
    // Only our locally served test app executes. No user pages or external scripts are loaded.
    const dom = await JSDOM.fromURL(`http://127.0.0.1:${server.statusPort}/chat`, {
      resources: "usable", runScripts: "dangerously", virtualConsole: console,
      beforeParse(window) {
        Object.assign(window, { TextEncoder, TextDecoder });
        assert.equal(window.crypto.subtle, undefined, "exercise HTTP without Web Crypto signing");
        window.WebSocket = class extends NodeWebSocket {
          constructor(url: string | URL) { super(String(url), { origin: `http://127.0.0.1:${server.statusPort}` }); sockets.add(this); this.once("close", () => sockets.delete(this)); }
        } as unknown as typeof window.WebSocket;
        if (saved) window.localStorage.setItem("sideband.login.v1", saved);
        if (identity) window.sessionStorage.setItem("sideband.identity.v1", identity);
      },
    });
    pages.push(dom); await until(() => dom.window.document.readyState === "complete");
    return dom;
  };
  try {
    await agent.connect(); await agent.createRoom("agents-room"); await agent.send("Before the human joined");
    const dom = await open(); const doc = dom.window.document;
    const input = (id: string) => doc.getElementById(id) as HTMLInputElement;
    input("username").value = "human"; input("password").value = server.password;
    doc.getElementById("login-form")!.dispatchEvent(new dom.window.Event("submit", { cancelable: true }));
    await until(() => !!doc.querySelector("#room-list button"));
    assert.equal(doc.getElementById("login-panel")!.hidden, true); assert.match(doc.getElementById("connection")!.textContent!, /HTTP \(unencrypted\)/);
    const saved = dom.window.localStorage.getItem("sideband.login.v1"); const identity = dom.window.sessionStorage.getItem("sideband.identity.v1");
    assert.ok(JSON.parse(saved!).password === server.password); assert.equal(JSON.parse(saved!).name, "human");
    (doc.querySelector("#room-list button") as HTMLButtonElement).click();
    await until(() => doc.getElementById("messages")!.textContent!.includes("Before the human joined"));
    await until(() => !(doc.getElementById("send") as HTMLButtonElement).disabled);
    const received: string[] = []; agent.onMessage(message => received.push(message.text));
    input("message").value = "Browser to agent"; doc.getElementById("compose")!.dispatchEvent(new dom.window.Event("submit", { cancelable: true }));
    await until(() => received.length > 0 || !!doc.getElementById("notice")!.textContent);
    assert.equal(doc.getElementById("notice")!.textContent, ""); assert.equal(received[0], "Browser to agent");
    await until(() => input("message").value === "");
    const hostile = '<img src=x onerror="window.hacked=true">\n<script>window.hacked=true</script>';
    input("message").value = "Unsent draft"; await agent.send(hostile);
    await until(() => doc.getElementById("messages")!.textContent!.includes(hostile));
    assert.equal(doc.querySelector("#messages img, #messages script"), null); assert.equal((dom.window as any).hacked, undefined);
    assert.equal(input("message").value, "Unsent draft", "push must preserve the draft");
    input("room-name").value = "another-room"; doc.getElementById("create-form")!.dispatchEvent(new dom.window.Event("submit", { cancelable: true }));
    await until(() => doc.getElementById("room-title")!.textContent === "another-room");
    await until(() => !(doc.getElementById("send") as HTMLButtonElement).disabled);
    assert.ok(!doc.getElementById("messages")!.textContent!.includes(hostile));
    const previousKey = JSON.parse(identity!).key;
    // A real reload retains per-origin localStorage and this tab's sessionStorage.
    const reloaded = await open(saved, identity); const next = reloaded.window.document;
    assert.ok((next.getElementById("password") as HTMLInputElement).value === server.password);
    assert.equal((next.getElementById("username") as HTMLInputElement).value, "human");
    next.getElementById("login-form")!.dispatchEvent(new reloaded.window.Event("submit", { cancelable: true }));
    await until(() => next.getElementById("room-title")!.textContent === "another-room");
    assert.equal(JSON.parse(reloaded.window.sessionStorage.getItem("sideband.identity.v1")!).key, previousKey);
    next.getElementById("logout")!.click(); await until(() => !next.getElementById("login-panel")!.hidden);
    next.getElementById("forget")!.click();
    assert.equal(reloaded.window.localStorage.getItem("sideband.login.v1"), null); assert.equal(reloaded.window.sessionStorage.getItem("sideband.identity.v1"), null);
    assert.equal((next.getElementById("password") as HTMLInputElement).value, "");
    assert.deepEqual(errors, []);
  } finally { for (const socket of sockets) socket.terminate(); for (const page of pages) page.window.close(); await agent.close(); await server.close(); }
});
