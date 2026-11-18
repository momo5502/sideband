import { BrowserRoomClient, base64, unbase64 } from "./browser-protocol.js";
export const loginStorage = "sideband.login.v1", identityStorage = "sideband.identity.v1", roomsStorage = "sideband.rooms.v1";
export const draftsStorage = "sideband.drafts.v1", reloadStorage = "sideband.reloaded-build.v1";
export const identityLabel = (identity) => identity.name || `#${identity.id.replace(/^agent-/, "").slice(0, 12)}`;
const colors = ["#8ab4f8", "#81c995", "#fdd663", "#f28b82", "#c58af9", "#78d9ec", "#ffb4d2", "#ffb86b"];
const assignedColors = new Map();
export function identityColor(identity) {
    let color = assignedColors.get(identity.id);
    if (!color) {
        let hash = 2166136261;
        for (const char of identity.id)
            hash = Math.imul(hash ^ char.charCodeAt(0), 16777619) >>> 0;
        const used = new Set(assignedColors.values());
        color = colors.map((_, i) => colors[(hash + i) % colors.length]).find(candidate => !used.has(candidate)) ?? `hsl(${(hash + assignedColors.size * 137.508) % 360},70%,75%)`;
        if (assignedColors.size < 10000)
            assignedColors.set(identity.id, color);
    }
    return color;
}
export function mentionsUsername(text, name) {
    return !!name && new RegExp(`(^|[^a-zA-Z0-9_@-])@${name}(?![a-zA-Z0-9_-])`, "i").test(text);
}
const outputSizes = new WeakMap();
const outputEncoder = new TextEncoder();
export function boundedOutput(current, incoming) {
    const ordered = [...new Map([...current, ...incoming].map(event => [event.seq, event])).values()].sort((a, b) => a.seq - b.seq);
    let bytes = 0, start = ordered.length;
    while (start > 0 && ordered.length - start < 1000) {
        const event = ordered[start - 1];
        let size = outputSizes.get(event);
        if (size === undefined) {
            size = outputEncoder.encode(JSON.stringify(event)).length;
            outputSizes.set(event, size);
        }
        if (bytes + size > 2 * 1024 * 1024)
            break;
        bytes += size;
        start--;
    }
    return ordered.slice(start);
}
const initial = () => ({ connection: "off", error: "", view: { kind: "home" }, rooms: [], joined: [], messages: {}, unread: {}, mentions: {}, members: [],
    control: { machines: [], agents: [] }, controlError: "", output: [], outputAgent: "", loading: false });
const errorText = (error) => error instanceof Error ? error.message : "Request failed.";
/** Owns transport/lifecycle and exposes immutable snapshots to the React workspace. */
export class BrowserWorkspace {
    window;
    createClient;
    reloadPage;
    state = initial();
    listeners = new Set();
    client;
    wanted = false;
    attempt = 0;
    generation = 0;
    timer;
    restore = new Set();
    leftRooms = new Set();
    watched = "";
    watchGeneration = 0;
    joinGeneration = 0;
    roomTransition = Promise.resolve();
    roomRefresh;
    roomsDirty = false;
    controlRefresh;
    controlDirty = false;
    pinged = new Set();
    notifications = new Map();
    pendingLaunches = new Map();
    controlSequence = 0;
    launchSpecs = new Map();
    drafts = new Map();
    pageBuild;
    reloading = false;
    draftEditedAt = 0;
    constructor(window, createClient = (endpoint, password, name, key) => new BrowserRoomClient(endpoint, password, name, key), reloadPage = () => window.location.reload()) {
        this.window = window;
        this.createClient = createClient;
        this.reloadPage = reloadPage;
        this.pageBuild = window.document.querySelector('meta[name="sideband-build"]')?.getAttribute("content") || undefined;
        window.document.addEventListener("input", event => { if (event.target?.closest?.(".composer"))
            this.draftEditedAt = Date.now(); });
        window.addEventListener("online", () => this.retry());
        const visible = () => { if (window.document.visibilityState === "visible") {
            this.retry();
            if (this.state.view.kind === "room")
                this.markRead(this.state.view.id);
        } };
        window.document.addEventListener("visibilitychange", visible);
        window.addEventListener("focus", visible);
        window.addEventListener("pagehide", event => { if (!event.persisted)
            this.dispose(); });
        window.addEventListener("pageshow", event => { if (event.persisted)
            visible(); });
    }
    subscribe = (listener) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
    snapshot = () => this.state;
    update(change) { this.state = { ...this.state, ...change }; for (const listener of this.listeners)
        listener(); }
    storage(kind, key, value) {
        try {
            if (value === undefined)
                return JSON.parse(this.window[kind].getItem(key) ?? "null");
            if (value === null)
                this.window[kind].removeItem(key);
            else
                this.window[kind].setItem(key, JSON.stringify(value));
            return true;
        }
        catch { /* Storage may be unavailable in a private/embedded browser. */ }
    }
    savedLogin() {
        const saved = this.storage("localStorage", loginStorage);
        if (typeof saved?.name === "string" && typeof saved?.password === "string")
            return saved;
    }
    start() { const saved = this.savedLogin(); if (saved?.password)
        void this.login(saved.name, saved.password).catch(() => { }); }
    async login(name, password) {
        if (this.wanted)
            return;
        const generation = ++this.generation;
        this.update({ error: "", connection: "connecting" });
        try {
            let key;
            const saved = this.storage("sessionStorage", identityStorage);
            if (saved?.name === name && /^[A-Za-z0-9_-]{43}$/.test(saved.key))
                key = unbase64(saved.key);
            key ??= this.window.crypto.getRandomValues(new Uint8Array(32));
            const client = this.createClient(`${this.window.location.protocol === "https:" ? "wss:" : "ws:"}//${this.window.location.host}/browser-ws`, password.trim(), name.trim(), key);
            this.client = client;
            this.wanted = true;
            this.attempt = 0;
            const remembered = this.storage("sessionStorage", roomsStorage);
            this.restore.clear();
            if (remembered?.name === name && Array.isArray(remembered.rooms))
                for (const room of remembered.rooms)
                    if (typeof room === "string" && room && room.length <= 100)
                        this.restore.add(room);
            client.onMessage = item => { if (this.client === client)
                this.receive(item); };
            client.onPresence = item => { if (this.client === client) {
                this.receive(item);
                void this.refreshRooms();
                if (this.state.lastRoom === item.roomId)
                    void this.refreshMembers();
            } };
            client.onRoomsChanged = () => { if (this.client === client)
                void this.refreshRooms(); };
            client.onError = error => { if (this.client === client)
                this.update({ error: error.message }); };
            client.onControl = (event, data) => {
                if (this.client !== client)
                    return;
                if (event === "control.changed")
                    void this.refreshControl();
                if (event === "control.output" && this.state.view.kind === "agent" && data.agentId === this.state.view.id)
                    this.update({ outputAgent: data.agentId, output: boundedOutput(this.state.output, data.events) });
            };
            client.onClose = event => {
                if (this.client !== client || !this.wanted || generation !== this.generation)
                    return;
                this.watched = "";
                this.clearPending();
                if (event?.code === 4001) {
                    this.wanted = false;
                    this.update({ connection: "off", error: "This identity connected in another tab. Connect again to use this tab." });
                    return;
                }
                this.update({ connection: "reconnecting" });
                this.schedule();
            };
            await this.open(client, generation, remembered);
            if (generation !== this.generation)
                return;
            this.storage("localStorage", loginStorage, { name: name.trim(), password: password.trim() });
            this.storage("sessionStorage", identityStorage, { name: name.trim(), key: base64(key) });
        }
        catch (error) {
            if (generation !== this.generation)
                return;
            if (this.timer !== undefined)
                this.window.clearTimeout(this.timer);
            this.timer = undefined;
            this.wanted = false;
            this.client?.disconnect();
            this.client = undefined;
            this.update({ connection: "off", error: errorText(error) });
            throw error;
        }
    }
    async open(client, generation, remembered) {
        const previousRooms = this.state.joined;
        await client.connect();
        const current = () => this.client === client && this.wanted && generation === this.generation;
        if (!current()) {
            client.disconnect();
            return;
        }
        for (const room of [...client.joinedRooms.values()]) {
            if (!this.leftRooms.has(room.name.toLowerCase()))
                continue;
            await client.request("room_leave", { room: room.id });
            client.joinedRooms.delete(room.id);
            if (!current()) {
                client.disconnect();
                return;
            }
        }
        let last = this.state.joined.find(room => room.id === this.state.lastRoom)?.name ?? (typeof remembered?.active === "string" ? remembered.active : undefined);
        for (const name of this.restore) {
            await client.subscribe(name);
            if (!current()) {
                client.disconnect();
                return;
            }
        }
        const active = [...client.joinedRooms.values()].find(room => room.name.toLowerCase() === last?.toLowerCase());
        for (const old of previousRooms) {
            const replacement = [...client.joinedRooms.values()].find(room => room.name.toLowerCase() === old.name.toLowerCase());
            const draft = this.drafts.get(`room:${old.id}`);
            if (replacement && replacement.id !== old.id && draft !== undefined) {
                this.drafts.set(`room:${replacement.id}`, draft);
                this.drafts.delete(`room:${old.id}`);
            }
        }
        const savedDrafts = this.storage("sessionStorage", draftsStorage);
        if (savedDrafts?.name === (client.identity.name ?? "") && Array.isArray(savedDrafts.entries)) {
            for (const entry of savedDrafts.entries.slice(0, 200)) {
                if (typeof entry?.text !== "string" || entry.text.length > 16000 || typeof entry.id !== "string")
                    continue;
                const room = entry.kind === "room" ? [...client.joinedRooms.values()].find(room => room.name.toLowerCase() === entry.id.toLowerCase()) : undefined;
                if (room)
                    this.drafts.set(`room:${room.id}`, entry.text);
                else if (entry.kind === "agent" && /^[a-f0-9-]{36}$/.test(entry.id))
                    this.drafts.set(`agent:${entry.id}`, entry.text);
            }
        }
        this.storage("sessionStorage", draftsStorage, null);
        client.room = active ?? null;
        const mentions = { ...this.state.mentions };
        if (Array.isArray(remembered?.pings))
            for (const ping of remembered.pings) {
                const room = [...client.joinedRooms.values()].find(room => room.name === ping?.room);
                if (room && Number.isSafeInteger(ping?.count) && ping.count > 0)
                    mentions[room.id] = ping.count;
            }
        const view = this.state.view.kind === "room" || (this.state.view.kind === "home" && active) ? (active ? { kind: "room", id: active.id } : { kind: "home" }) : this.state.view;
        this.attempt = 0;
        this.watched = "";
        this.update({ connection: "on", identity: client.identity, joined: [...client.joinedRooms.values()], lastRoom: active?.id, view, mentions, error: "" });
        await Promise.all([this.refreshRooms(), this.refreshControl()]);
        if (!current())
            return;
        if (active) {
            await this.loadHistory(active);
            await this.refreshMembers();
        }
        if (this.state.view.kind === "agent")
            await this.watchAgent(this.state.view.id);
        this.saveRooms();
    }
    schedule() {
        if (this.timer !== undefined || !this.wanted)
            return;
        const generation = this.generation;
        this.timer = this.window.setTimeout(async () => {
            this.timer = undefined;
            const client = this.client;
            if (!client || !this.wanted || generation !== this.generation)
                return;
            try {
                await this.open(client, generation);
            }
            catch (error) {
                if (!this.wanted || generation !== this.generation)
                    return;
                const message = errorText(error);
                if (["AUTH_FAILED", "NAME_IN_USE", "IDENTITY_NAME"].includes(error.code ?? "") || /different server certificate/.test(message)) {
                    this.wanted = false;
                    this.update({ connection: "off", error: message });
                    return;
                }
                this.update({ connection: "reconnecting", error: "" });
                this.schedule();
            }
        }, Math.min(10000, 400 * 2 ** Math.min(this.attempt++, 5)));
    }
    retry() {
        if (!this.wanted || this.state.connection !== "reconnecting")
            return;
        if (this.timer !== undefined)
            this.window.clearTimeout(this.timer);
        this.timer = undefined;
        this.attempt = 0;
        this.schedule();
    }
    saveRooms() {
        if (!this.state.identity)
            return false;
        return this.storage("sessionStorage", roomsStorage, { name: this.state.identity.name ?? "", rooms: [...this.restore], active: this.state.joined.find(room => room.id === this.state.lastRoom)?.name ?? null,
            pings: this.state.joined.filter(room => this.state.mentions[room.id]).map(room => ({ room: room.name, count: this.state.mentions[room.id] })) }) === true;
    }
    receive(item) {
        const previous = this.state.messages[item.roomId] ?? [];
        if (previous.some(existing => existing.id === item.id))
            return;
        const messages = { ...this.state.messages, [item.roomId]: [...previous, item].slice(-200) };
        // A large number of joined rooms must not turn background chat into unbounded browser history.
        let total = Object.values(messages).reduce((count, entries) => count + entries.length, 0);
        for (const id of Object.keys(messages))
            if (id !== this.state.lastRoom && total > 1000) {
                total -= messages[id].length;
                delete messages[id];
            }
        const unread = { ...this.state.unread }, mentions = { ...this.state.mentions };
        if (!("kind" in item) && item.sender.id !== this.client?.identity.id) {
            if (this.state.view.kind !== "room" || this.state.view.id !== item.roomId || this.window.document.visibilityState === "hidden")
                unread[item.roomId] = Math.min(999, (unread[item.roomId] ?? 0) + 1);
            const key = `${item.roomId}:${item.id}`;
            if (mentionsUsername(item.text, this.client?.identity.name) && item.sender.id !== this.client?.identity.id && !this.pinged.has(key)) {
                this.pinged.add(key);
                if (this.pinged.size > 10000)
                    this.pinged.delete(this.pinged.values().next().value);
                mentions[item.roomId] = Math.min(999, (mentions[item.roomId] ?? 0) + 1);
                this.notify(item);
            }
        }
        this.update({ messages, unread, mentions });
        this.saveRooms();
    }
    notify(item) {
        const NativeNotification = this.window.Notification;
        if (this.window.isSecureContext === false || !NativeNotification || NativeNotification.permission !== "granted")
            return;
        const room = this.state.joined.find(room => room.id === item.roomId);
        if (!room)
            return;
        try {
            this.notifications.get(room.id)?.close();
            const notification = new NativeNotification(`${identityLabel(item.sender)} mentioned you in ${room.name}`, { body: Array.from(item.text).slice(0, 240).join(""), tag: `sideband:${room.id}` });
            this.notifications.set(room.id, notification);
            notification.onclick = () => { notification.close(); this.window.focus(); void this.openRoom(room.id); };
        }
        catch { /* Unread badges remain available when the browser cannot display a notification. */ }
    }
    markRead(id) {
        if (!this.state.unread[id] && !this.state.mentions[id] && !this.notifications.has(id))
            return;
        const unread = { ...this.state.unread }, mentions = { ...this.state.mentions };
        delete unread[id];
        delete mentions[id];
        this.notifications.get(id)?.close();
        this.notifications.delete(id);
        this.update({ unread, mentions });
        this.saveRooms();
    }
    refreshRooms() {
        if (this.roomRefresh) {
            this.roomsDirty = true;
            return this.roomRefresh;
        }
        const client = this.client;
        if (!client || this.state.connection !== "on")
            return Promise.resolve();
        const task = client.rooms().then(rooms => {
            if (this.client !== client)
                return;
            for (const room of rooms)
                if (client.joinedRooms.has(room.id))
                    client.joinedRooms.set(room.id, room);
            this.update({ rooms, joined: [...client.joinedRooms.values()] });
        }).catch(error => { if (this.client === client && this.state.connection === "on")
            this.update({ error: errorText(error) }); }).finally(() => {
            if (this.roomRefresh === task)
                this.roomRefresh = undefined;
            if (this.roomsDirty) {
                this.roomsDirty = false;
                void this.refreshRooms();
            }
        });
        this.roomRefresh = task;
        return task;
    }
    refreshControl() {
        if (this.controlRefresh) {
            this.controlDirty = true;
            return this.controlRefresh;
        }
        const client = this.client;
        if (!client || this.state.connection !== "on")
            return Promise.resolve();
        const task = (async () => {
            do {
                this.controlDirty = false;
                const sequence = ++this.controlSequence;
                let control = await client.request("control.list");
                if (this.client !== client)
                    return;
                for (const [id, pending] of this.pendingLaunches)
                    if (control.agents.some(agent => agent.id === id) || sequence > pending.after) {
                        this.window.clearTimeout(pending.timer);
                        this.pendingLaunches.delete(id);
                    }
                control = { ...control, agents: [...control.agents, ...[...this.pendingLaunches.values()].map(pending => pending.agent)] };
                const view = this.state.view;
                if (view.kind === "agent" && !this.state.control.agents.find(agent => agent.id === view.id)?.online && control.agents.find(agent => agent.id === view.id)?.online)
                    this.watched = "";
                const build = control.updates?.current, identity = build && (build.commit ?? `v${build.version}`);
                this.pageBuild ??= identity;
                const serverUpdate = identity && this.pageBuild && identity !== this.pageBuild ? { build: identity, automatic: this.storage("sessionStorage", reloadStorage) !== identity } : undefined;
                this.update({ control, controlError: "", serverUpdate });
                if (view.kind === "agent" && !this.watched && control.agents.find(agent => agent.id === view.id)?.online)
                    await this.watchAgent(view.id);
            } while (this.controlDirty && this.client === client && this.state.connection === "on");
        })().catch(error => { if (this.client === client)
            this.update({ controlError: errorText(error) }); }).finally(() => {
            if (this.controlRefresh === task)
                this.controlRefresh = undefined;
        });
        this.controlRefresh = task;
        return task;
    }
    async openRoom(room) {
        const client = this.requireClient(), generation = ++this.joinGeneration;
        this.update({ loading: true, error: "" });
        const operation = this.roomTransition.then(async () => {
            const joined = await client.subscribe(room);
            if (this.client !== client)
                return;
            this.leftRooms.delete(joined.name.toLowerCase());
            this.restore.add(joined.name);
            this.update({ joined: [...client.joinedRooms.values()] });
            this.saveRooms();
            if (generation !== this.joinGeneration)
                return;
            this.watched = "";
            ++this.watchGeneration;
            void client.request("control.watch", { agentId: "" }).catch(() => { });
            this.update({ view: { kind: "room", id: joined.id }, lastRoom: joined.id, members: [] });
            this.markRead(joined.id);
            this.saveRooms();
            await Promise.all([this.loadHistory(joined), this.refreshRooms(), this.refreshMembers()]);
        });
        this.roomTransition = operation.catch(() => { });
        try {
            await operation;
        }
        catch (error) {
            if (generation === this.joinGeneration)
                this.update({ error: errorText(error) });
            throw error;
        }
        finally {
            if (generation === this.joinGeneration)
                this.update({ loading: false });
        }
    }
    async loadHistory(room) {
        const client = this.client;
        if (!client || client.room?.id !== room.id)
            return;
        const history = await client.history();
        if (this.client !== client)
            return;
        const items = [...new Map([...history, ...(this.state.messages[room.id] ?? [])].map(item => [item.id, item])).values()].sort((a, b) => a.createdAt - b.createdAt).slice(-200);
        this.update({ messages: { ...this.state.messages, [room.id]: items } });
    }
    async refreshMembers() {
        const client = this.client, room = this.state.lastRoom;
        if (!client || !room || client.room?.id !== room || this.state.connection !== "on")
            return;
        try {
            const members = await client.request("members");
            if (this.client === client && this.state.lastRoom === room)
                this.update({ members });
        }
        catch { /* Reconnection and room switches refresh the list again. */ }
    }
    async leaveRoom() {
        const client = this.client, room = this.state.joined.find(room => room.id === this.state.lastRoom);
        if (!client || !room)
            return;
        this.restore.delete(room.name);
        this.leftRooms.add(room.name.toLowerCase());
        this.markRead(room.id);
        ++this.joinGeneration;
        client.joinedRooms.delete(room.id);
        if (client.room?.id === room.id)
            client.room = null;
        this.update({ joined: [...client.joinedRooms.values()], view: { kind: "home" }, lastRoom: undefined, members: [], loading: false });
        this.saveRooms();
        if (this.state.connection === "on")
            await client.request("room_leave", { room: room.id });
        await this.refreshRooms();
    }
    async sendRoom(roomId, text) {
        const client = this.requireClient(), room = client.room;
        if (!room)
            throw new Error("Join a room first.");
        if (room.id !== roomId || this.state.view.kind !== "room" || this.state.view.id !== roomId || this.state.loading)
            throw new Error("The room changed before this message could be sent. Your draft is kept.");
        const message = await client.send(text);
        if (this.client !== client)
            return;
        const previous = this.state.messages[room.id] ?? [];
        this.update({ messages: { ...this.state.messages, [room.id]: [...previous, message].slice(-200) } });
    }
    async selectAgent(id) {
        ++this.joinGeneration;
        const offline = this.state.control.agents.find(agent => agent.id === id)?.online === false;
        this.update({ view: { kind: "agent", id }, error: "", ...(offline ? { output: [], outputAgent: id, loading: false } : {}) });
        if (offline || this.state.connection !== "on") {
            this.watched = "";
            ++this.watchGeneration;
            if (this.state.connection === "on")
                void this.client?.request("control.watch", { agentId: "" }).catch(() => { });
            return;
        }
        await this.watchAgent(id);
    }
    async watchAgent(id) {
        if (this.watched === id)
            return;
        const client = this.requireClient(), generation = ++this.watchGeneration;
        this.watched = id;
        this.update({ output: [], outputAgent: id, loading: true });
        try {
            const result = await client.request("control.watch", { agentId: id });
            if (this.client === client && generation === this.watchGeneration && this.state.view.kind === "agent" && this.state.view.id === id)
                this.update({ output: boundedOutput(this.state.output, result.events) });
        }
        catch (error) {
            if (generation === this.watchGeneration) {
                this.watched = "";
                this.update({ error: errorText(error) });
            }
        }
        finally {
            if (generation === this.watchGeneration)
                this.update({ loading: false });
        }
    }
    async launch(spec) {
        const result = await this.requireClient().request("control.launch", spec);
        const { machineId, prompt: _prompt, ...description } = spec;
        const pending = { ...description, id: result.id, machineId, machineName: this.state.control.machines.find(machine => machine.id === machineId)?.name ?? "Machine", room: spec.room ?? "", state: "preparing", online: true, createdAt: Date.now(), canResume: false };
        const generation = this.generation;
        const timer = this.window.setTimeout(() => {
            if (generation !== this.generation || !this.pendingLaunches.delete(result.id))
                return;
            this.update({ control: { ...this.state.control, agents: this.state.control.agents.filter(agent => agent.id !== result.id) }, error: "The agent did not become available. Check its machine before launching again." });
        }, 30000);
        this.pendingLaunches.set(result.id, { agent: pending, after: this.controlSequence, timer });
        const { machineId: _machine, ...savedSpec } = spec;
        this.launchSpecs.set(result.id, savedSpec);
        if (this.launchSpecs.size > 50)
            this.launchSpecs.delete(this.launchSpecs.keys().next().value);
        if (!this.state.control.agents.some(agent => agent.id === result.id))
            this.update({ control: { ...this.state.control, agents: [...this.state.control.agents, pending] } });
        await this.selectAgent(result.id);
        await this.refreshControl();
        return result;
    }
    async action(id, action, params = {}) {
        const result = await this.requireClient().request("control.action", { agentId: id, action, ...params });
        await this.refreshControl();
        if (action === "dispose")
            this.update({ view: { kind: "home" }, output: [], outputAgent: "" });
        return result;
    }
    webhook(room, sender) { return this.requireClient().request("webhook", { room, sender }); }
    async updateSideband(start = false) {
        await this.requireClient().request(start ? "control.updates.start" : "control.updates.check");
        await this.refreshControl();
    }
    reloadUpdated(manual = false) {
        const update = this.state.serverUpdate;
        if (!update || this.reloading || !manual && !update.automatic || this.state.connection !== "on")
            return;
        if (!manual && this.window.document.activeElement?.closest(".composer") && Date.now() - this.draftEditedAt < 5000)
            return;
        const roomsSaved = this.saveRooms();
        const entries = [...this.drafts].filter(([, text]) => text).slice(-200).flatMap(([key, text]) => {
            if (key.startsWith("agent:"))
                return [{ kind: "agent", id: key.slice(6), text }];
            const room = this.state.joined.find(room => `room:${room.id}` === key);
            return room ? [{ kind: "room", id: room.name, text }] : [];
        });
        if (!this.storage("sessionStorage", draftsStorage, { name: this.state.identity?.name ?? "", entries }) || !roomsSaved) {
            this.update({ serverUpdate: { ...update, automatic: false }, error: "Could not save this tab for refresh. Copy your drafts before reloading the page." });
            return;
        }
        this.storage("sessionStorage", reloadStorage, update.build);
        this.reloading = true;
        this.reloadPage();
    }
    home() { this.update({ view: { kind: "home" }, error: "" }); this.watched = ""; ++this.watchGeneration; if (this.client)
        void this.client.request("control.watch", { agentId: "" }).catch(() => { }); }
    clearError() { this.update({ error: "" }); }
    requireClient() { if (!this.client || this.state.connection !== "on")
        throw new Error("Reconnecting. Your draft is kept; send it once connected."); return this.client; }
    logout() {
        this.wanted = false;
        ++this.generation;
        ++this.watchGeneration;
        ++this.joinGeneration;
        this.clearPending();
        this.controlDirty = false;
        this.roomsDirty = false;
        this.drafts.clear();
        this.launchSpecs.clear();
        this.leftRooms.clear();
        this.roomRefresh = undefined;
        this.controlRefresh = undefined;
        if (this.timer !== undefined)
            this.window.clearTimeout(this.timer);
        this.timer = undefined;
        const client = this.client;
        this.client = undefined;
        client?.disconnect();
        this.restore.clear();
        this.watched = "";
        for (const notification of this.notifications.values())
            notification.close();
        this.notifications.clear();
        this.pinged.clear();
        this.storage("sessionStorage", identityStorage, null);
        this.storage("sessionStorage", roomsStorage, null);
        this.storage("sessionStorage", draftsStorage, null);
        this.reloading = false;
        this.update(initial());
    }
    forget() { this.logout(); this.storage("localStorage", loginStorage, null); this.update({ error: "Saved login removed." }); }
    clearPending() { for (const pending of this.pendingLaunches.values())
        this.window.clearTimeout(pending.timer); this.pendingLaunches.clear(); }
    dispose() { this.wanted = false; this.clearPending(); if (this.timer !== undefined)
        this.window.clearTimeout(this.timer); const client = this.client; this.client = undefined; client?.disconnect(); }
}
//# sourceMappingURL=browser-workspace.js.map