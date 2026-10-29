import { BrowserRoomClient, base64, unbase64 } from "./browser-protocol.js";
import { messageMarkdown } from "./browser-markdown.js";
import type { AgentIdentity, SignedMessage, PresenceEvent } from "./room-protocol.js";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const user = $<HTMLInputElement>("username"), password = $<HTMLInputElement>("password"), message = $<HTMLTextAreaElement>("message");
const savedKey = "sideband.login.v1", tabKey = "sideband.identity.v1";
const markdown = messageMarkdown(window);
let client: BrowserRoomClient | undefined, joining = false, loadingHistory = false;
let backlog: (SignedMessage | PresenceEvent)[] = [], seen = new Set<string>();
const mobile = window.matchMedia?.("(max-width:650px)");
function setMenu(open: boolean, restoreFocus = false) {
  const expanded = !!mobile?.matches && !!client && open;
  document.body.classList.toggle("menu-open", expanded);
  $("menu-toggle").setAttribute("aria-expanded", String(expanded));
  const drawer = $("room-menu"); drawer.inert = !!mobile?.matches && !expanded;
  document.querySelector("main")!.inert = expanded;
  if (expanded) { drawer.setAttribute("role", "dialog"); drawer.setAttribute("aria-modal", "true"); $("menu-close").focus(); }
  else { drawer.removeAttribute("role"); drawer.removeAttribute("aria-modal"); if (restoreFocus && mobile?.matches && client) $("menu-toggle").focus(); }
  if (mobile?.matches && !expanded) drawer.setAttribute("aria-hidden", "true"); else drawer.removeAttribute("aria-hidden");
}
function connection(text: string) { $("connection").textContent = text; $("menu-connection").textContent = text; }
function notice(text: string) { $("notice").textContent = text; $("menu-notice").textContent = text; }
const label = (identity: AgentIdentity) => identity.name || `#${identity.id.slice(6, 18)}`;
const storage = (kind: "localStorage" | "sessionStorage", action: "get" | "set" | "remove", key: string, value?: string): string | null => {
  try { const target = window[kind]; if (action === "get") return target.getItem(key); if (action === "set") target.setItem(key, value!); else target.removeItem(key); }
  catch { if (action === "set") $("login-error").textContent = "Browser storage is unavailable; this login cannot be remembered."; }
  return null;
};
function error(value: unknown, login = false) { const text = value instanceof Error ? value.message : "Something went wrong."; if (login) $("login-error").textContent = text; else notice(text); }
function setRoom() {
  $("room-title").textContent = client?.room?.name || "Choose a room";
  $("leave").hidden = !client?.room; message.disabled = !client?.room || joining; $<HTMLButtonElement>("send").disabled = !client?.room || joining;
  $("menu-leave").hidden = !client?.room;
  message.placeholder = client?.room ? "Write a message…" : "Join a room to send messages";
}
function render(item: SignedMessage | PresenceEvent) {
  if (!client?.room || item.roomId !== client.room.id || seen.has(item.id)) return;
  seen.add(item.id); if (seen.size > 10000) seen.delete(seen.values().next().value!);
  const log = $("messages"), nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 100;
  const entry = document.createElement("div");
  if ("kind" in item) { entry.className = "event"; entry.textContent = `${label(item.participant)} ${item.kind}.`; }
  else {
    entry.className = "message";
    const meta = document.createElement("div"); meta.className = "meta";
    const sender = document.createElement("span"); sender.className = "sender"; sender.textContent = label(item.sender);
    const time = document.createElement("time"); time.className = "time"; time.dateTime = new Date(item.createdAt).toISOString(); time.textContent = new Date(item.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    const body = document.createElement("div"); body.className = "message-body"; body.append(markdown(item.text));
    meta.append(sender, time); entry.append(meta, body);
  }
  log.append(entry); while (log.childElementCount > 500) log.firstElementChild!.remove();
  if (nearBottom) log.scrollTop = log.scrollHeight;
}
function receive(item: SignedMessage | PresenceEvent) { if (loadingHistory) { if (backlog.length < 1000) backlog.push(item); } else render(item); }
async function history() {
  loadingHistory = true; backlog = []; seen.clear(); $("messages").replaceChildren();
  try { for (const item of await client!.history()) render(item); }
  finally { loadingHistory = false; for (const item of backlog) render(item); backlog = []; $("messages").scrollTop = $("messages").scrollHeight; }
}
async function rooms() {
  if (!client) return;
  const list = await client.rooms(); $("room-list").replaceChildren();
  for (const room of list) {
    const button = document.createElement("button"); button.type = "button"; button.textContent = `${room.name} · ${room.members}`;
    if (room.id === client.room?.id) button.setAttribute("aria-current", "true");
    button.addEventListener("click", () => { void join(room.id); }); $("room-list").append(button);
  }
  if (!list.length) { const empty = document.createElement("p"); empty.className = "muted"; empty.textContent = "No rooms yet. Create one below."; $("room-list").append(empty); }
}
async function join(room: string, create = false) {
  if (!client || joining) return; joining = true; setRoom(); notice("");
  try {
    // Queue live events across the join/history boundary; history can overlap pushed messages.
    loadingHistory = true; backlog = [];
    await client.join(room, create); setRoom();
    const pushed = backlog; await history(); for (const item of pushed) render(item);
    await rooms(); setMenu(false, true);
  } catch (value) { error(value); }
  finally { loadingHistory = false; for (const item of backlog) render(item); backlog = []; joining = false; setRoom(); if (client?.room && !mobile?.matches) message.focus(); }
}
async function login() {
  const loginButton = $<HTMLButtonElement>("login-button"); loginButton.disabled = true; $("login-error").textContent = "";
  let candidate: BrowserRoomClient | undefined;
  try {
    const name = user.value.trim(), enteredPassword = password.value.trim();
    let secretKey: Uint8Array | undefined;
    try { const saved = JSON.parse(storage("sessionStorage", "get", tabKey) || "null"); if (saved?.name === name && /^[A-Za-z0-9_-]{43}$/.test(saved.key)) secretKey = unbase64(saved.key); } catch { /* Start a fresh identity. */ }
    secretKey ??= crypto.getRandomValues(new Uint8Array(32));
    candidate = new BrowserRoomClient(`${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/browser-ws`, enteredPassword, name, secretKey);
    candidate.onMessage = receive; candidate.onPresence = receive; candidate.onError = value => error(value);
    await candidate.connect(); client = candidate;
    storage("localStorage", "set", savedKey, JSON.stringify({ name, password: enteredPassword }));
    storage("sessionStorage", "set", tabKey, JSON.stringify({ name, key: base64(secretKey) }));
    $("app").hidden = false; $("login-panel").hidden = true; $("identity").textContent = `You: ${label(client.identity)}`;
    document.body.classList.add("chatting"); setMenu(!client.room);
    connection(location.protocol === "https:" ? "Connected · HTTPS" : "Connected · HTTP (unencrypted)");
    candidate.onClose = () => {
      if (client !== candidate) return; client = undefined; $("app").hidden = true; $("login-panel").hidden = false;
      document.body.classList.remove("chatting"); setMenu(false);
      connection("Disconnected"); $("login-error").textContent = "Connection closed. Connect again to rejoin.";
    };
    setRoom(); if (client.room) await history(); await rooms();
  } catch (value) { if (client === candidate) client = undefined; candidate?.disconnect(); $("app").hidden = true; $("login-panel").hidden = false; document.body.classList.remove("chatting"); setMenu(false); connection("Disconnected"); error(value, true); }
  finally { loginButton.disabled = false; }
}
$("login-form").addEventListener("submit", event => { event.preventDefault(); void login(); });
$("forget").addEventListener("click", () => { storage("localStorage", "remove", savedKey); storage("sessionStorage", "remove", tabKey); password.value = ""; user.value = ""; $("login-error").textContent = "Saved login removed."; });
$("refresh").addEventListener("click", () => { void rooms().catch(error); });
$("create-form").addEventListener("submit", event => { event.preventDefault(); const input = $<HTMLInputElement>("room-name"); const name = input.value.trim(); if (name) void join(name, true).then(() => { input.value = ""; }); });
for (const id of ["leave", "menu-leave"]) $(id).addEventListener("click", () => { if (joining || !client) return; void client.leave().then(async () => { setRoom(); $("messages").replaceChildren(); await rooms(); setMenu(true); }).catch(error); });
$("logout").addEventListener("click", () => {
  const previous = client; client = undefined; previous?.disconnect(); storage("sessionStorage", "remove", tabKey);
  $("app").hidden = true; $("login-panel").hidden = false; document.body.classList.remove("chatting"); setMenu(false); connection("Disconnected");
});
$("compose").addEventListener("submit", event => {
  event.preventDefault(); if (!client || joining || !message.value.trim()) return;
  const text = message.value, current = client; $<HTMLButtonElement>("send").disabled = true;
  void current.send(text).then(sent => { if (client !== current) return; render(sent); if (message.value === text) message.value = ""; notice(""); }).catch(error)
    .finally(() => { $<HTMLButtonElement>("send").disabled = !client?.room; message.focus(); });
});
message.addEventListener("keydown", event => { if (event.key === "Enter" && !event.shiftKey && !event.isComposing) { event.preventDefault(); if (!$<HTMLButtonElement>("send").disabled) $<HTMLFormElement>("compose").requestSubmit(); } });
try { const saved = JSON.parse(storage("localStorage", "get", savedKey) || "null"); if (typeof saved?.name === "string" && typeof saved.password === "string") { user.value = saved.name; password.value = saved.password; } } catch { /* Ignore corrupt browser state. */ }
$("menu-toggle").addEventListener("click", () => setMenu(!document.body.classList.contains("menu-open"), true));
for (const id of ["menu-close", "menu-backdrop"]) $(id).addEventListener("click", () => setMenu(false, true));
document.addEventListener("keydown", event => {
  if (!document.body.classList.contains("menu-open")) return;
  if (event.key === "Escape") { event.preventDefault(); setMenu(false, true); }
  if (event.key === "Tab") {
    const drawer = $("room-menu");
    const controls = [...drawer.querySelectorAll<HTMLElement>("button:not([hidden]):not(:disabled),input:not(:disabled),a[href]")];
    const first = controls[0], last = controls[controls.length - 1], active = document.activeElement;
    if (event.shiftKey && (active === first || !drawer.contains(active))) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && (active === last || !drawer.contains(active))) { event.preventDefault(); first?.focus(); }
  }
});
mobile?.addEventListener("change", () => setMenu(!client?.room));
setMenu(false);
