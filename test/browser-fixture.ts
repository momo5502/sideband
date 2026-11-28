import { testTimeout } from "./waits.js";
import assert from "node:assert/strict";
import { JSDOM, VirtualConsole } from "jsdom";
import WebSocket from "ws";
import { RoomServer } from "../src/room-server.js";

export async function until(check: () => boolean | Promise<boolean>, message = "Browser state did not settle.") {
  const deadline = Date.now() + testTimeout(8000);
  while (!await check()) { if (Date.now() > deadline) throw new Error(message); await new Promise(resolve => setTimeout(resolve, 10)); }
}
export type SavedBrowserState = { login?: string | null; identity?: string | null; rooms?: string | null };
export async function browserPage(server: RoomServer, options: { mobile?: boolean; saved?: SavedBrowserState; notification?: "default" | "denied" | "insecure" | "unavailable" | "throws"; onOpen?: (window: JSDOM["window"]) => void } = {}) {
  const errors: Error[] = [], sockets = new Set<WebSocket>(); let permission: NotificationPermission = options.notification === "denied" ? "denied" : options.notification === "throws" ? "granted" : "default";
  const notifications: { title: string; options: NotificationOptions; closed: boolean; onclick: (() => void) | null; close(): void }[] = [];
  let requests = 0, focuses = 0;
  const console = new VirtualConsole(); console.on("jsdomError", error => errors.push(error));
  const origin = `http://127.0.0.1:${server.statusPort}`;
  const dom = await JSDOM.fromURL(`${origin}/chat`, { resources: "usable", runScripts: "dangerously", virtualConsole: console, pretendToBeVisual: true,
    beforeParse(window) {
      Object.assign(window, { TextEncoder, TextDecoder, matchMedia: () => Object.assign(new window.EventTarget(), { matches: !!options.mobile }),
        PointerEvent: window.MouseEvent, ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
        isSecureContext: options.notification !== "insecure" });
      window.HTMLElement.prototype.scrollIntoView = () => {};
      window.HTMLElement.prototype.hasPointerCapture = () => false; window.HTMLElement.prototype.setPointerCapture = () => {}; window.HTMLElement.prototype.releasePointerCapture = () => {};
      window.focus = () => { focuses++; };
      if (options.notification !== "unavailable") window.Notification = class {
        static get permission() { return permission; }
        static async requestPermission() { requests++; return permission = "granted"; }
        closed = false; onclick: (() => void) | null = null;
        constructor(public title: string, public options: NotificationOptions) { notifications.push(this); }
        close() { this.closed = true; }
      } as unknown as typeof window.Notification;
      const mode = options.notification;
      if (mode === "throws") window.Notification = class {
        static permission = "granted"; static async requestPermission() { return "granted"; }
        constructor() { throw new Error("Fixture notification failure."); }
      } as unknown as typeof window.Notification;
      window.WebSocket = class extends WebSocket {
        constructor(url: string | URL) { super(String(url), { origin }); sockets.add(this); this.once("close", () => sockets.delete(this)); if (options.onOpen) this.once("open", () => options.onOpen!(window)); }
      } as unknown as typeof window.WebSocket;
      for (const [key, value] of [["sideband.login.v1", options.saved?.login], ["sideband.identity.v1", options.saved?.identity], ["sideband.rooms.v1", options.saved?.rooms]]) if (value) (key === "sideband.login.v1" ? window.localStorage : window.sessionStorage).setItem(key!, value);
    } });
  const doc = dom.window.document;
  await until(() => !!doc.querySelector("#login-form, #app"), errors.map(error => error.message).join("\n") || "React app did not mount.");
  const get = <T extends HTMLElement = HTMLElement>(selector: string) => { const element = doc.querySelector<T>(selector); assert.ok(element, `Missing ${selector}`); return element; };
  const click = (selector: string | HTMLElement) => {
    const node = typeof selector === "string" ? get(selector) : selector;
    node.focus(); node.dispatchEvent(new dom.window.MouseEvent("pointerdown", { bubbles: true, button: 0 })); node.dispatchEvent(new dom.window.MouseEvent("pointerup", { bubbles: true, button: 0 })); node.click();
  };
  const fill = (selector: string, value: string) => {
    const input = get<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(selector);
    const prototype = input instanceof dom.window.HTMLTextAreaElement ? dom.window.HTMLTextAreaElement.prototype : input instanceof dom.window.HTMLSelectElement ? dom.window.HTMLSelectElement.prototype : dom.window.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new dom.window.Event("input", { bubbles: true })); input.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  };
  const submit = (selector: string) => get<HTMLFormElement>(selector).dispatchEvent(new dom.window.Event("submit", { cancelable: true, bubbles: true }));
  const key = (selector: string | HTMLElement, key: string, extra: KeyboardEventInit = {}) => (typeof selector === "string" ? get(selector) : selector).dispatchEvent(new dom.window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...extra }));
  const button = (text: string, role = "button") => { const element = [...doc.querySelectorAll<HTMLElement>(role === "button" ? "button" : `[role=${role}]`)].find(element => element.textContent?.trim() === text); assert.ok(element, `Missing button ${text}`); return element; };
  const navigation = async () => { if (options.mobile && !doc.querySelector("#room-menu")) { click("#menu-toggle"); await until(() => !!doc.querySelector("#room-menu")); } };
  const room = (id: string) => doc.querySelector<HTMLButtonElement>(`#room-list button[data-room-id="${id}"]`)!;
  const view = async (id: string, name: string) => { await navigation(); await until(() => !!room(id)); click(room(id)); await until(() => doc.querySelector("#room-title")?.textContent === name && !doc.querySelector("#navigation-dialog") && !(doc.querySelector("#send") as HTMLButtonElement)?.disabled); };
  const agents = async () => { if (!doc.querySelector("#agents-page")) { await navigation(); click("#agents-open"); await until(() => !!doc.querySelector("#agents-page") && !doc.querySelector("#navigation-dialog")); } };
  const settings = async () => { await navigation(); click("#settings-open"); await until(() => !!doc.querySelector("#settings-dialog")); };
  return { dom, doc, get, click, fill, submit, key, button, navigation, room, view, agents, settings, errors, sockets, notifications,
    get requests() { return requests; }, get focuses() { return focuses; },
    async login(name = "human") { fill("#username", name); fill("#password", server.password); submit("#login-form"); await until(() => !!doc.querySelector("#app")); },
    save(): SavedBrowserState { return { login: dom.window.localStorage.getItem("sideband.login.v1"), identity: dom.window.sessionStorage.getItem("sideband.identity.v1"), rooms: dom.window.sessionStorage.getItem("sideband.rooms.v1") }; },
    async close() { dom.window.dispatchEvent(new dom.window.PageTransitionEvent("pagehide", { persisted: false })); for (const socket of sockets) socket.terminate(); dom.window.close(); },
  };
}
