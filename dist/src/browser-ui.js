import { BrowserRoomClient, base64, unbase64 } from "./browser-protocol.js";
import { messageMarkdown } from "./browser-markdown.js";
const $ = (id) => document.getElementById(id);
const user = $("username"), password = $("password"), message = $("message");
const savedKey = "sideband.login.v1", tabKey = "sideband.identity.v1";
const markdown = messageMarkdown(window);
let client, joining = false, loadingHistory = false;
let backlog = [], seen = new Set();
const mobile = window.matchMedia?.("(max-width:650px)");
function setMenu(open, restoreFocus = false) {
    const expanded = !!mobile?.matches && !!client && open;
    document.body.classList.toggle("menu-open", expanded);
    $("menu-toggle").setAttribute("aria-expanded", String(expanded));
    const drawer = $("room-menu");
    drawer.inert = !!mobile?.matches && !expanded;
    document.querySelector("main").inert = expanded;
    if (expanded) {
        drawer.setAttribute("role", "dialog");
        drawer.setAttribute("aria-modal", "true");
        $("menu-close").focus();
    }
    else {
        drawer.removeAttribute("role");
        drawer.removeAttribute("aria-modal");
        if (restoreFocus && mobile?.matches && client)
            $("menu-toggle").focus();
    }
    if (mobile?.matches && !expanded)
        drawer.setAttribute("aria-hidden", "true");
    else
        drawer.removeAttribute("aria-hidden");
}
function connection(text) { $("connection").textContent = text; $("menu-connection").textContent = text; }
function notice(text) { $("notice").textContent = text; $("menu-notice").textContent = text; }
const label = (identity) => identity.name || `#${identity.id.slice(6, 18)}`;
const namePalette = ["#8ab4f8", "#81c995", "#fdd663", "#f28b82", "#c58af9", "#78d9ec", "#ffb4d2", "#ffb86b"];
const nameColors = new Map();
function participantName(identity) {
    let color = nameColors.get(identity.id);
    if (!color) {
        let hash = 2166136261;
        for (const char of identity.id)
            hash = Math.imul(hash ^ char.charCodeAt(0), 16777619) >>> 0;
        const used = new Set(nameColors.values());
        color = namePalette.map((_, index) => namePalette[(hash + index) % namePalette.length]).find(candidate => !used.has(candidate))
            ?? `hsl(${(hash % 360 + nameColors.size * 137.508) % 360}, 75%, 76%)`;
        nameColors.set(identity.id, color);
    }
    const name = document.createElement("span");
    name.className = "sender";
    name.textContent = label(identity);
    name.style.color = color;
    return name;
}
const storage = (kind, action, key, value) => {
    try {
        const target = window[kind];
        if (action === "get")
            return target.getItem(key);
        if (action === "set")
            target.setItem(key, value);
        else
            target.removeItem(key);
    }
    catch {
        if (action === "set")
            $("login-error").textContent = "Browser storage is unavailable; this login cannot be remembered.";
    }
    return null;
};
function error(value, login = false) { const text = value instanceof Error ? value.message : "Something went wrong."; if (login)
    $("login-error").textContent = text;
else
    notice(text); }
function setRoom() {
    $("room-title").textContent = client?.room?.name || "Choose a room";
    $("leave").hidden = !client?.room;
    message.disabled = !client?.room || joining;
    $("send").disabled = !client?.room || joining;
    $("menu-leave").hidden = !client?.room;
    message.placeholder = client?.room ? "Write a message…" : "Join a room to send messages";
    $("webhook-room").value = client?.room?.name ?? "";
    clearWebhook();
}
function clearWebhook() { $("webhook-url").value = ""; $("webhook-result").hidden = true; }
function render(item) {
    if (!client?.room || item.roomId !== client.room.id || seen.has(item.id))
        return;
    seen.add(item.id);
    if (seen.size > 10000)
        seen.delete(seen.values().next().value);
    const log = $("messages"), nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 100;
    const entry = document.createElement("div");
    if ("kind" in item) {
        entry.className = "event";
        entry.append(participantName(item.participant), ` ${item.kind}.`);
    }
    else {
        entry.className = "message";
        const meta = document.createElement("div");
        meta.className = "meta";
        const sender = participantName(item.sender);
        const time = document.createElement("time");
        time.className = "time";
        time.dateTime = new Date(item.createdAt).toISOString();
        time.textContent = new Date(item.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
        const body = document.createElement("div");
        body.className = "message-body";
        body.append(markdown(item.text));
        meta.append(sender, time);
        entry.append(meta, body);
    }
    log.append(entry);
    while (log.childElementCount > 500)
        log.firstElementChild.remove();
    if (nearBottom)
        log.scrollTop = log.scrollHeight;
}
function receive(item) { if (loadingHistory) {
    if (backlog.length < 1000)
        backlog.push(item);
}
else
    render(item); }
async function history() {
    loadingHistory = true;
    backlog = [];
    seen.clear();
    $("messages").replaceChildren();
    try {
        for (const item of await client.history())
            render(item);
    }
    finally {
        loadingHistory = false;
        for (const item of backlog)
            render(item);
        backlog = [];
        $("messages").scrollTop = $("messages").scrollHeight;
    }
}
async function rooms() {
    if (!client)
        return;
    const list = await client.rooms();
    $("room-list").replaceChildren();
    for (const room of list) {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = `${room.name} · ${room.members}`;
        if (room.id === client.room?.id)
            button.setAttribute("aria-current", "true");
        button.addEventListener("click", () => { void join(room.id); });
        $("room-list").append(button);
    }
    if (!list.length) {
        const empty = document.createElement("p");
        empty.className = "muted";
        empty.textContent = "No rooms yet. Enter a name below to join.";
        $("room-list").append(empty);
    }
}
async function join(room) {
    if (!client || joining)
        return;
    joining = true;
    setRoom();
    notice("");
    try {
        // Queue live events across the join/history boundary; history can overlap pushed messages.
        loadingHistory = true;
        backlog = [];
        await client.join(room);
        setRoom();
        const pushed = backlog;
        await history();
        for (const item of pushed)
            render(item);
        await rooms();
        setMenu(false, true);
    }
    catch (value) {
        error(value);
    }
    finally {
        loadingHistory = false;
        for (const item of backlog)
            render(item);
        backlog = [];
        joining = false;
        setRoom();
        if (client?.room && !mobile?.matches)
            message.focus();
    }
}
async function login() {
    const loginButton = $("login-button");
    loginButton.disabled = true;
    $("login-error").textContent = "";
    let candidate;
    try {
        const name = user.value.trim(), enteredPassword = password.value.trim();
        let secretKey;
        try {
            const saved = JSON.parse(storage("sessionStorage", "get", tabKey) || "null");
            if (saved?.name === name && /^[A-Za-z0-9_-]{43}$/.test(saved.key))
                secretKey = unbase64(saved.key);
        }
        catch { /* Start a fresh identity. */ }
        secretKey ??= crypto.getRandomValues(new Uint8Array(32));
        candidate = new BrowserRoomClient(`${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/browser-ws`, enteredPassword, name, secretKey);
        candidate.onMessage = receive;
        candidate.onPresence = receive;
        candidate.onError = value => error(value);
        await candidate.connect();
        client = candidate;
        storage("localStorage", "set", savedKey, JSON.stringify({ name, password: enteredPassword }));
        storage("sessionStorage", "set", tabKey, JSON.stringify({ name, key: base64(secretKey) }));
        $("app").hidden = false;
        $("login-panel").hidden = true;
        $("identity").replaceChildren("You: ", participantName(client.identity));
        document.body.classList.add("chatting");
        setMenu(!client.room);
        connection(location.protocol === "https:" ? "Connected · HTTPS" : "Connected · HTTP (unencrypted)");
        candidate.onClose = () => {
            if (client !== candidate)
                return;
            client = undefined;
            clearWebhook();
            $("app").hidden = true;
            $("login-panel").hidden = false;
            document.body.classList.remove("chatting");
            setMenu(false);
            connection("Disconnected");
            $("login-error").textContent = "Connection closed. Connect again to rejoin.";
        };
        setRoom();
        if (client.room)
            await history();
        await rooms();
    }
    catch (value) {
        if (client === candidate)
            client = undefined;
        candidate?.disconnect();
        $("app").hidden = true;
        $("login-panel").hidden = false;
        document.body.classList.remove("chatting");
        setMenu(false);
        connection("Disconnected");
        error(value, true);
    }
    finally {
        loginButton.disabled = false;
    }
}
$("login-form").addEventListener("submit", event => { event.preventDefault(); void login(); });
$("forget").addEventListener("click", () => { storage("localStorage", "remove", savedKey); storage("sessionStorage", "remove", tabKey); password.value = ""; user.value = ""; $("login-error").textContent = "Saved login removed."; });
$("refresh").addEventListener("click", () => { void rooms().catch(error); });
$("join-form").addEventListener("submit", event => { event.preventDefault(); const input = $("room-name"); const name = input.value.trim(); if (name)
    void join(name).then(() => { input.value = ""; }); });
for (const id of ["leave", "menu-leave"])
    $(id).addEventListener("click", () => { if (joining || !client)
        return; void client.leave().then(async () => { setRoom(); $("messages").replaceChildren(); await rooms(); setMenu(true); }).catch(error); });
$("logout").addEventListener("click", () => {
    const previous = client;
    client = undefined;
    clearWebhook();
    previous?.disconnect();
    storage("sessionStorage", "remove", tabKey);
    $("app").hidden = true;
    $("login-panel").hidden = false;
    document.body.classList.remove("chatting");
    setMenu(false);
    connection("Disconnected");
});
$("webhook-form").addEventListener("submit", event => {
    event.preventDefault();
    if (!client)
        return;
    const owner = client, room = $("webhook-room").value.trim(), sender = $("webhook-sender").value.trim();
    const button = $("webhook-generate");
    button.disabled = true;
    clearWebhook();
    notice("");
    void owner.request("webhook", { room, sender }).then(result => {
        if (client !== owner || room !== $("webhook-room").value.trim() || sender !== $("webhook-sender").value.trim())
            return;
        $("webhook-url").value = new URL(result.path, location.origin).href;
        $("webhook-result").hidden = false;
    }).catch(value => { if (client === owner)
        error(value); }).finally(() => { button.disabled = false; });
});
for (const id of ["webhook-room", "webhook-sender"])
    $(id).addEventListener("input", clearWebhook);
$("webhook-copy").addEventListener("click", () => {
    const output = $("webhook-url"), value = output.value;
    if (!value)
        return;
    if (navigator.clipboard?.writeText)
        void navigator.clipboard.writeText(value).then(() => notice("Webhook URL copied.")).catch(() => { output.focus(); output.select(); notice("Select and copy the webhook URL."); });
    else {
        output.focus();
        output.select();
        notice("Select and copy the webhook URL.");
    }
});
$("compose").addEventListener("submit", event => {
    event.preventDefault();
    if (!client || joining || !message.value.trim())
        return;
    const text = message.value, current = client;
    $("send").disabled = true;
    void current.send(text).then(sent => { if (client !== current)
        return; render(sent); if (message.value === text)
        message.value = ""; notice(""); }).catch(error)
        .finally(() => { $("send").disabled = !client?.room; message.focus(); });
});
message.addEventListener("keydown", event => { if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    if (!$("send").disabled)
        $("compose").requestSubmit();
} });
try {
    const saved = JSON.parse(storage("localStorage", "get", savedKey) || "null");
    if (typeof saved?.name === "string" && typeof saved.password === "string") {
        user.value = saved.name;
        password.value = saved.password;
    }
}
catch { /* Ignore corrupt browser state. */ }
$("menu-toggle").addEventListener("click", () => setMenu(!document.body.classList.contains("menu-open"), true));
for (const id of ["menu-close", "menu-backdrop"])
    $(id).addEventListener("click", () => setMenu(false, true));
document.addEventListener("keydown", event => {
    if (!document.body.classList.contains("menu-open"))
        return;
    if (event.key === "Escape") {
        event.preventDefault();
        setMenu(false, true);
    }
    if (event.key === "Tab") {
        const drawer = $("room-menu");
        const controls = [...drawer.querySelectorAll("button:not([hidden]):not(:disabled),input:not(:disabled),textarea:not(:disabled),summary,a[href]")]
            .filter(element => !element.closest("[hidden]") && (!element.closest("details:not([open])") || element.tagName === "SUMMARY"));
        const first = controls[0], last = controls[controls.length - 1], active = document.activeElement;
        if (event.shiftKey && (active === first || !drawer.contains(active))) {
            event.preventDefault();
            last?.focus();
        }
        else if (!event.shiftKey && (active === last || !drawer.contains(active))) {
            event.preventDefault();
            first?.focus();
        }
    }
});
mobile?.addEventListener("change", () => setMenu(!client?.room));
setMenu(false);
//# sourceMappingURL=browser-ui.js.map