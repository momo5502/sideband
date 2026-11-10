import { BrowserRoomClient, base64, unbase64 } from "./browser-protocol.js";
import { messageMarkdown } from "./browser-markdown.js";
import type { AgentIdentity, Room, SignedMessage, PresenceEvent } from "./room-protocol.js";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const user = $<HTMLInputElement>("username"), password = $<HTMLInputElement>("password"), message = $<HTMLTextAreaElement>("message");
const savedKey = "sideband.login.v1", tabKey = "sideband.identity.v1", roomsKey = "sideband.rooms.v1";
const markdown = messageMarkdown(window);
let client: BrowserRoomClient | undefined, connecting: BrowserRoomClient | undefined, joining = false, loadingHistory = false;
let backlog: (SignedMessage | PresenceEvent)[] = [], seen = new Set<string>();
let historyGeneration = 0;
let availableRooms: Room[] = [];
const mentions = new Map<string, number>(), pinged = new Set<string>(), notifications = new Map<string, Notification>();
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
const namePalette = ["#8ab4f8", "#81c995", "#fdd663", "#f28b82", "#c58af9", "#78d9ec", "#ffb4d2", "#ffb86b"];
const nameColors = new Map<string, string>();
function participantName(identity: AgentIdentity): HTMLSpanElement {
  let color = nameColors.get(identity.id);
  if (!color) {
    let hash = 2166136261;
    for (const char of identity.id) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619) >>> 0;
    const used = new Set(nameColors.values());
    color = namePalette.map((_, index) => namePalette[(hash + index) % namePalette.length]!).find(candidate => !used.has(candidate))
      ?? `hsl(${(hash % 360 + nameColors.size * 137.508) % 360}, 75%, 76%)`;
    nameColors.set(identity.id, color);
  }
  const name = document.createElement("span"); name.className = "sender"; name.textContent = label(identity); name.style.color = color;
  return name;
}
const storage = (kind: "localStorage" | "sessionStorage", action: "get" | "set" | "remove", key: string, value?: string): string | null => {
  try { const target = window[kind]; if (action === "get") return target.getItem(key); if (action === "set") target.setItem(key, value!); else target.removeItem(key); }
  catch { if (action === "set") $("login-error").textContent = "Browser storage is unavailable; this login cannot be remembered."; }
  return null;
};
function error(value: unknown, login = false) { const text = value instanceof Error ? value.message : "Something went wrong."; if (login) $("login-error").textContent = text; else notice(text); }
function saveRooms(owner = client) {
  if (owner) storage("sessionStorage", "set", roomsKey, JSON.stringify({ name: owner.identity.name ?? "", rooms: [...owner.joinedRooms.values()].map(room => room.name), active: owner.room?.name ?? null,
    pings: [...owner.joinedRooms.values()].filter(room => mentions.has(room.id)).map(room => ({ room: room.name, count: mentions.get(room.id) })) }));
}
function updateRoomButtons() {
  for (const button of $("room-list").querySelectorAll<HTMLButtonElement>("button[data-room-id]")) {
    const id = button.dataset.roomId!, joined = !!client?.joinedRooms.has(id), count = mentions.get(id) ?? 0;
    button.classList.toggle("joined", joined); button.dataset.joined = String(joined);
    button.title = joined ? "Joined — click to view" : "Click to join";
    if (id === client?.room?.id) button.setAttribute("aria-current", "true"); else button.removeAttribute("aria-current");
    const badge = button.querySelector<HTMLElement>(".mention-badge")!;
    badge.hidden = count === 0; badge.textContent = count > 99 ? "@99+" : `@${count}`;
    badge.setAttribute("aria-label", `${count} unread ${count === 1 ? "mention" : "mentions"}`);
  }
}
function markRead(id: string) { mentions.delete(id); notifications.get(id)?.close(); notifications.delete(id); updateRoomButtons(); saveRooms(); }
function updateNotifications() {
  const button = $<HTMLButtonElement>("notifications"), status = $("notification-status");
  button.textContent = "Enable desktop notifications"; button.disabled = true;
  if (client && !client.identity.name) { status.textContent = "Connect with a username to receive @mentions."; return; }
  if (window.isSecureContext === false) { status.textContent = "Desktop notifications need HTTPS or localhost. Mention badges still work."; return; }
  if (typeof Notification === "undefined") { status.textContent = "Desktop notifications are unavailable in this browser. Mention badges still work."; return; }
  if (Notification.permission === "granted") { button.textContent = "Desktop notifications enabled"; status.textContent = "Mentions notify you while this client is open."; }
  else if (Notification.permission === "denied") status.textContent = "Notifications are blocked. Enable them in your browser's site settings.";
  else { button.disabled = false; status.textContent = "Get notified when someone mentions @yourUsername."; }
}
function ping(item: SignedMessage) {
  const owner = client, username = owner?.identity.name;
  const key = `${item.roomId}:${item.id}`;
  if (!owner || !username || item.sender.id === owner.identity.id || pinged.has(key)) return;
  if (!new RegExp(`(^|[^a-zA-Z0-9_@-])@${username}(?![a-zA-Z0-9_-])`, "i").test(item.text)) return;
  pinged.add(key); if (pinged.size > 10000) pinged.delete(pinged.values().next().value!);
  mentions.set(item.roomId, (mentions.get(item.roomId) ?? 0) + 1); updateRoomButtons(); saveRooms();
  if (window.isSecureContext === false || typeof Notification === "undefined" || Notification.permission !== "granted") return;
  try {
    const room = owner.joinedRooms.get(item.roomId); if (!room) return;
    notifications.get(room.id)?.close();
    const notification = new Notification(`${label(item.sender)} mentioned you in ${room.name}`, { body: Array.from(item.text).slice(0, 240).join(""), tag: `sideband:${room.id}`, renotify: true } as NotificationOptions);
    notifications.set(room.id, notification);
    notification.onclick = () => { notification.close(); window.focus(); if (client === owner) void join(room.id); };
  } catch { $("notification-status").textContent = "A desktop notification could not be displayed. Your mention badge is still available."; }
}
function setRoom() {
  document.title = client?.room ? `${client.room.name} — Sideband` : "Sideband chat";
  $("room-title").textContent = client?.room?.name || "Choose a room";
  $("leave").hidden = !client?.room; message.disabled = !client?.room || joining; $<HTMLButtonElement>("send").disabled = !client?.room || joining;
  $("menu-leave").hidden = !client?.room;
  message.placeholder = client?.room ? "Write a message…" : "Join a room to send messages";
  $<HTMLInputElement>("webhook-room").value = client?.room?.name ?? ""; clearWebhook();
}
function clearWebhook() { $<HTMLTextAreaElement>("webhook-url").value = ""; $("webhook-result").hidden = true; }
function render(item: SignedMessage | PresenceEvent) {
  if (!client?.room || item.roomId !== client.room.id || seen.has(item.id)) return;
  seen.add(item.id); if (seen.size > 10000) seen.delete(seen.values().next().value!);
  const log = $("messages"), nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 100;
  const entry = document.createElement("div");
  if ("kind" in item) { entry.className = "event"; entry.append(participantName(item.participant), ` ${item.kind}.`); }
  else {
    entry.className = "message";
    const meta = document.createElement("div"); meta.className = "meta";
    const sender = participantName(item.sender);
    const time = document.createElement("time"); time.className = "time"; time.dateTime = new Date(item.createdAt).toISOString(); time.textContent = new Date(item.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    const body = document.createElement("div"); body.className = "message-body"; body.append(markdown(item.text));
    meta.append(sender, time); entry.append(meta, body);
  }
  log.append(entry); while (log.childElementCount > 500) log.firstElementChild!.remove();
  if (nearBottom) log.scrollTop = log.scrollHeight;
}
function receive(item: SignedMessage | PresenceEvent) {
  if (!("kind" in item)) ping(item);
  if (loadingHistory) { if (backlog.length < 1000) backlog.push(item); } else render(item);
}
async function history() {
  const owner = client, room = owner?.room; if (!owner || !room) return;
  const generation = ++historyGeneration;
  loadingHistory = true; backlog = []; seen.clear(); $("messages").replaceChildren();
  try {
    const items = await owner.history();
    if (client === owner && owner.room?.id === room.id && generation === historyGeneration) for (const item of items) render(item);
  } finally {
    if (generation === historyGeneration) {
      loadingHistory = false; if (client === owner) for (const item of backlog) render(item);
      backlog = []; $("messages").scrollTop = $("messages").scrollHeight;
    }
  }
}
async function rooms() {
  if (!client) return;
  const owner = client, list = await owner.rooms(); if (client !== owner) return;
  availableRooms = list;
  for (const room of list) if (owner.joinedRooms.has(room.id)) owner.joinedRooms.set(room.id, room);
  drawRooms();
}
function drawRooms() {
  if (!client) return;
  const focus = (document.activeElement as HTMLElement | null)?.dataset.roomId;
  const list = [...new Map([...availableRooms, ...client.joinedRooms.values()].map(room => [room.id, room])).values()];
  $("room-list").replaceChildren();
  for (const room of list) {
    const button = document.createElement("button"); button.type = "button"; button.dataset.roomId = room.id;
    const title = document.createElement("span"); title.className = "room-label"; title.textContent = `${room.name} · ${room.members}`;
    const badge = document.createElement("span"); badge.className = "mention-badge"; badge.hidden = true;
    button.append(title, badge);
    button.addEventListener("click", () => { void join(room.id); }); $("room-list").append(button);
  }
  updateRoomButtons();
  if (focus) [...$("room-list").querySelectorAll<HTMLButtonElement>("button")].find(button => button.dataset.roomId === focus)?.focus();
  if (!list.length) { const empty = document.createElement("p"); empty.className = "muted"; empty.textContent = "No rooms yet. Enter a name below to join."; $("room-list").append(empty); }
}
async function join(room: string) {
  if (!client || joining) return; joining = true; setRoom(); notice("");
  const owner = client;
  try {
    // Queue live events across the join/history boundary; history can overlap pushed messages.
    loadingHistory = true; backlog = [];
    await owner.subscribe(room); if (client !== owner) return; setRoom(); saveRooms(); drawRooms();
    const pushed = backlog; await history(); for (const item of pushed) render(item);
    if (client !== owner) return;
    if (owner.room) markRead(owner.room.id);
    await rooms(); setMenu(false, true);
  } catch (value) { error(value); }
  finally { loadingHistory = false; for (const item of backlog) render(item); backlog = []; joining = false; setRoom(); if (client?.room && !mobile?.matches) message.focus(); }
}
async function login() {
  const loginButton = $<HTMLButtonElement>("login-button");
  if (client || connecting || loginButton.disabled) return;
  loginButton.disabled = true; $("login-error").textContent = "";
  let candidate: BrowserRoomClient | undefined;
  try {
    const name = user.value.trim(), enteredPassword = password.value.trim();
    let remembered: { name?: unknown; rooms?: unknown; active?: unknown; pings?: unknown } | undefined;
    try { remembered = JSON.parse(storage("sessionStorage", "get", roomsKey) || "null") ?? undefined; } catch { /* Ignore corrupt room preferences. */ }
    let secretKey: Uint8Array | undefined;
    try { const saved = JSON.parse(storage("sessionStorage", "get", tabKey) || "null"); if (saved?.name === name && /^[A-Za-z0-9_-]{43}$/.test(saved.key)) secretKey = unbase64(saved.key); } catch { /* Start a fresh identity. */ }
    secretKey ??= crypto.getRandomValues(new Uint8Array(32));
    candidate = new BrowserRoomClient(`${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/browser-ws`, enteredPassword, name, secretKey);
    connecting = candidate;
    candidate.onMessage = item => { if (client === candidate) receive(item); };
    candidate.onPresence = item => { if (client === candidate) receive(item); };
    candidate.onError = value => { if (client === candidate) error(value); };
    await candidate.connect();
    if (connecting !== candidate) { candidate.disconnect(); return; }
    client = candidate;
    ++historyGeneration; loadingHistory = false; backlog = []; seen.clear(); $("messages").replaceChildren();
    availableRooms = []; mentions.clear(); pinged.clear();
    for (const notification of notifications.values()) notification.close(); notifications.clear();
    if (remembered?.name === name && Array.isArray(remembered.rooms)) {
      for (const room of remembered.rooms) {
        if (typeof room !== "string" || !room || room.length > 100) continue;
        if (![...candidate.joinedRooms.values()].some(joined => joined.name.toLowerCase() === room.toLowerCase())) await candidate.subscribe(room);
        if (connecting !== candidate) { candidate.disconnect(); return; }
      }
      const active = remembered.active;
      candidate.room = typeof active === "string" ? [...candidate.joinedRooms.values()].find(room => room.name.toLowerCase() === active.toLowerCase()) ?? null : null;
      if (Array.isArray(remembered.pings)) for (const ping of remembered.pings) {
        if (!ping || typeof ping !== "object" || typeof ping.room !== "string" || !Number.isSafeInteger(ping.count) || ping.count <= 0) continue;
        const room = [...candidate.joinedRooms.values()].find(room => room.name.toLowerCase() === ping.room.toLowerCase());
        if (room) mentions.set(room.id, ping.count);
      }
    }
    saveRooms();
    storage("localStorage", "set", savedKey, JSON.stringify({ name, password: enteredPassword }));
    storage("sessionStorage", "set", tabKey, JSON.stringify({ name, key: base64(secretKey) }));
    $("app").hidden = false; $("login-panel").hidden = true; $("identity").replaceChildren("You: ", participantName(client.identity));
    document.body.classList.add("chatting"); setMenu(!client.room); updateNotifications();
    connection(location.protocol === "https:" ? "Connected · HTTPS" : "Connected · HTTP (unencrypted)");
    candidate.onClose = () => {
      if (client !== candidate) return; saveRooms(candidate); client = undefined; setRoom(); $("app").hidden = true; $("login-panel").hidden = false;
      document.body.classList.remove("chatting"); setMenu(false);
      connection("Disconnected"); $("login-error").textContent = "Connection closed. Connect again to rejoin.";
    };
    setRoom(); if (client.room) { await history(); if (client === candidate && candidate.room) markRead(candidate.room.id); } await rooms();
  } catch (value) {
    if (candidate && connecting !== candidate) return;
    if (client === candidate) client = undefined; candidate?.disconnect(); setRoom(); $("app").hidden = true; $("login-panel").hidden = false;
    document.body.classList.remove("chatting"); setMenu(false); connection("Disconnected"); error(value, true);
  } finally { if (!candidate || connecting === candidate) { connecting = undefined; loginButton.disabled = false; } }
}
$("login-form").addEventListener("submit", event => { event.preventDefault(); void login(); });
$("forget").addEventListener("click", () => {
  const pending = connecting; connecting = undefined;
  if (pending && client === pending) {
    client = undefined; setRoom(); $("app").hidden = true; $("login-panel").hidden = false; document.body.classList.remove("chatting"); setMenu(false); connection("Disconnected");
  }
  pending?.disconnect(); $<HTMLButtonElement>("login-button").disabled = false;
  storage("localStorage", "remove", savedKey); storage("sessionStorage", "remove", tabKey); password.value = ""; user.value = ""; $("login-error").textContent = "Saved login removed.";
  storage("sessionStorage", "remove", roomsKey);
});
$("refresh").addEventListener("click", () => { void rooms().catch(error); });
$("join-form").addEventListener("submit", event => { event.preventDefault(); const input = $<HTMLInputElement>("room-name"); const name = input.value.trim(); if (name) void join(name).then(() => { input.value = ""; }); });
for (const id of ["leave", "menu-leave"]) $(id).addEventListener("click", () => {
  if (joining || !client) return;
  const owner = client, room = owner.room;
  void owner.leave().then(async () => { if (client !== owner) return; if (room) markRead(room.id); saveRooms(); setRoom(); $("messages").replaceChildren(); await rooms(); setMenu(true); }).catch(error);
});
$("notifications").addEventListener("click", () => {
  if (typeof Notification === "undefined" || window.isSecureContext === false) return;
  $<HTMLButtonElement>("notifications").disabled = true;
  void Notification.requestPermission().then(updateNotifications).catch(value => { updateNotifications(); error(value); });
});
$("logout").addEventListener("click", () => {
  const previous = client; client = undefined; setRoom(); previous?.disconnect(); storage("sessionStorage", "remove", tabKey);
  storage("sessionStorage", "remove", roomsKey); mentions.clear(); pinged.clear();
  for (const notification of notifications.values()) notification.close(); notifications.clear();
  $("app").hidden = true; $("login-panel").hidden = false; document.body.classList.remove("chatting"); setMenu(false); connection("Disconnected");
});
$("webhook-form").addEventListener("submit", event => {
  event.preventDefault(); if (!client) return;
  const owner = client, room = $<HTMLInputElement>("webhook-room").value.trim(), sender = $<HTMLInputElement>("webhook-sender").value.trim();
  const button = $<HTMLButtonElement>("webhook-generate"); button.disabled = true; clearWebhook(); notice("");
  void owner.request<{ path: string }>("webhook", { room, sender }).then(result => {
    if (client !== owner || room !== $<HTMLInputElement>("webhook-room").value.trim() || sender !== $<HTMLInputElement>("webhook-sender").value.trim()) return;
    $<HTMLTextAreaElement>("webhook-url").value = new URL(result.path, location.origin).href; $("webhook-result").hidden = false;
  }).catch(value => { if (client === owner) error(value); }).finally(() => { button.disabled = false; });
});
for (const id of ["webhook-room", "webhook-sender"]) $(id).addEventListener("input", clearWebhook);
$("webhook-copy").addEventListener("click", () => {
  const output = $<HTMLTextAreaElement>("webhook-url"), value = output.value; if (!value) return;
  if (navigator.clipboard?.writeText) void navigator.clipboard.writeText(value).then(() => notice("Webhook URL copied.")).catch(() => { output.focus(); output.select(); notice("Select and copy the webhook URL."); });
  else { output.focus(); output.select(); notice("Select and copy the webhook URL."); }
});
$("compose").addEventListener("submit", event => {
  event.preventDefault(); if (!client || joining || !message.value.trim()) return;
  const text = message.value, current = client; $<HTMLButtonElement>("send").disabled = true;
  void current.send(text).then(sent => { if (client !== current) return; render(sent); if (message.value === text) message.value = ""; notice(""); }).catch(error)
    .finally(() => { $<HTMLButtonElement>("send").disabled = !client?.room; message.focus(); });
});
message.addEventListener("keydown", event => { if (event.key === "Enter" && !event.shiftKey && !event.isComposing) { event.preventDefault(); if (!$<HTMLButtonElement>("send").disabled) $<HTMLFormElement>("compose").requestSubmit(); } });
$("menu-toggle").addEventListener("click", () => setMenu(!document.body.classList.contains("menu-open"), true));
for (const id of ["menu-close", "menu-backdrop"]) $(id).addEventListener("click", () => setMenu(false, true));
document.addEventListener("keydown", event => {
  if (!document.body.classList.contains("menu-open")) return;
  if (event.key === "Escape") { event.preventDefault(); setMenu(false, true); }
  if (event.key === "Tab") {
    const drawer = $("room-menu");
    const controls = [...drawer.querySelectorAll<HTMLElement>("button:not([hidden]):not(:disabled),input:not(:disabled),textarea:not(:disabled),summary,a[href]")]
      .filter(element => !element.closest("[hidden]") && (!element.closest("details:not([open])") || element.tagName === "SUMMARY"));
    const first = controls[0], last = controls[controls.length - 1], active = document.activeElement;
    if (event.shiftKey && (active === first || !drawer.contains(active))) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && (active === last || !drawer.contains(active))) { event.preventDefault(); first?.focus(); }
  }
});
mobile?.addEventListener("change", () => setMenu(!client?.room));
window.addEventListener("focus", updateNotifications);
setMenu(false);
try {
  const saved = JSON.parse(storage("localStorage", "get", savedKey) || "null");
  if (typeof saved?.name === "string" && typeof saved.password === "string") {
    user.value = saved.name; password.value = saved.password;
    if (password.value.trim()) void login();
  }
} catch { /* Ignore corrupt browser state. */ }
