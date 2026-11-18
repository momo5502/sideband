import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useEffect, useRef, useState } from "react";
import * as RadioGroup from "@radix-ui/react-radio-group";
import * as Tabs from "@radix-ui/react-tabs";
import { Activity, ArrowUpRight, Check, ChevronRight, Copy, Hash, LogOut, Monitor, Plus } from "lucide-react";
import { identityLabel } from "./browser-workspace.js";
import { Button, ErrorMessage, Field, Modal, Spinner } from "./browser-components.js";
import { allRooms, Brand, repositoryName, Status } from "./browser-views.js";
import { Updates } from "./browser-updates.js";
function RoomPicker({ rooms, value, onChange, id, allowNone = true }) {
    const [creating, setCreating] = useState(false);
    return _jsxs(_Fragment, { children: [_jsxs("select", { id: id, className: "select", value: creating ? "__new__" : value, onChange: event => { const value = event.target.value; setCreating(value === "__new__"); onChange(value === "__new__" ? "" : value); }, children: [_jsx("option", { value: "", children: allowNone ? "No room" : "Choose a room" }), rooms.map(room => _jsxs("option", { value: room.name, children: ["# ", room.name] }, room.id)), value && !creating && !rooms.some(room => room.name === value) && _jsxs("option", { value: value, children: ["# ", value] }), _jsx("option", { value: "__new__", children: "Create a new room\u2026" })] }), creating && _jsx("input", { autoFocus: true, className: "input room-picker-new", "aria-label": "New room name", placeholder: "New room name", maxLength: 100, value: value, onChange: event => onChange(event.target.value), required: true })] });
}
function CopyCommand({ text }) {
    const [copied, setCopied] = useState(false), input = useRef(null);
    return _jsxs("div", { className: "copy-command", children: [_jsx("input", { className: "input", ref: input, readOnly: true, "aria-label": "Terminal command", value: text, onFocus: event => event.currentTarget.select() }), _jsx(Button, { variant: "outline", icon: true, "aria-label": "Copy command", onClick: () => {
                    if (navigator.clipboard?.writeText)
                        void navigator.clipboard.writeText(text).then(() => setCopied(true)).catch(() => { input.current?.focus(); input.current?.select(); });
                    else {
                        input.current?.focus();
                        input.current?.select();
                    }
                }, children: copied ? _jsx(Check, { size: 15 }) : _jsx(Copy, { size: 15 }) })] });
}
function WorkerSetup({ state }) {
    const port = state.control.serverPort ?? 8765;
    const server = `${location.hostname}${port === 443 ? "" : `:${port}`}`;
    return _jsxs("div", { className: "setup-box", children: [_jsx("p", { className: "font-medium text-zinc-300", children: "Connect a machine" }), _jsx("p", { className: "mt-1", children: "On a machine with OMP and Sideband installed, sign in once:" }), _jsx(CopyCommand, { text: `sideband login ${server}` }), _jsx("p", { className: "mt-3", children: "Then keep its worker running:" }), _jsx(CopyCommand, { text: "sideband worker" })] });
}
function ClaudeTrust({ machine, store, onBusyChange }) {
    const [busy, setBusy] = useState(false), [root, setRoot] = useState(""), [error, setError] = useState("");
    return _jsxs("div", { className: "setup-box mb-5", "data-claude-trust": machine.id, children: [_jsx("p", { className: "font-medium text-zinc-300", children: "Claude workspace trust (one-time setup)" }), _jsx("p", { className: "mt-1", children: "Trust all current and future agent folders under this machine's Sideband workspace root. Claude can read, edit and execute files there. This saves the trust decision in Claude's configuration." }), _jsxs(Button, { className: "mt-3", disabled: busy || !machine.online || !!root, onClick: () => {
                    setBusy(true);
                    onBusyChange?.(true);
                    setError("");
                    void store.trustClaude(machine.id).then(result => setRoot(result.root)).catch(error => setError(error instanceof Error ? error.message : "Could not record trust.")).finally(() => { setBusy(false); onBusyChange?.(false); });
                }, children: [busy ? _jsx(Spinner, {}) : root ? _jsx(Check, { size: 14 }) : null, root ? "Workspaces trusted" : busy ? "Recording trust..." : "Trust Claude workspaces"] }), root && _jsxs("p", { className: "field-hint mt-2", role: "status", children: ["Trusted: ", root, ". Start or resume the agent to apply it. An already-open trust prompt still needs local confirmation or a restart."] }), _jsx(ErrorMessage, { text: error })] });
}
export function NewAgent({ state, store, close, initial }) {
    const [repository, setRepository] = useState(initial?.repository ?? ""), [name, setName] = useState(() => {
        if (!initial)
            return "";
        const names = new Set(state.control.agents.map(agent => agent.name.toLowerCase()));
        const base = initial.name.slice(0, 55);
        let result = base, index = 2;
        while (names.has(result.toLowerCase()))
            result = `${base}-${index++}`;
        return result;
    }), [room, setRoom] = useState(initial?.room ?? state.joined.find(room => room.id === state.lastRoom)?.name ?? "");
    const [harness, setHarness] = useState(() => initial?.harness ?? ["omp", "codex", "claude"].find(name => state.control.machines.some(machine => machine.online && machine.harnesses.includes(name))) ?? "omp");
    const harnessLabel = { omp: "OMP", codex: "Codex", claude: "Claude" }[harness];
    const [machine, setMachine] = useState(() => {
        const eligible = state.control.machines.filter(machine => machine.online && machine.harnesses.includes(harness));
        return eligible.find(machine => machine.id === initial?.machineId)?.id ?? eligible.find(machine => machine.name === initial?.machineName)?.id ?? eligible[0]?.id ?? "";
    });
    const [busy, setBusy] = useState(false), [trustBusy, setTrustBusy] = useState(false), [error, setError] = useState("");
    const editedName = useRef(false);
    const [terminal, setTerminal] = useState(initial ? initial.terminal === true : harness !== "claude");
    const editedHarness = useRef(false);
    const eligible = state.control.machines.filter(machine => machine.online && machine.harnesses.includes(harness)), selected = eligible.find(candidate => candidate.id === machine);
    const native = harness !== "claude" || selected?.platform === "win32" || selected?.terminal === "tmux";
    const [recent] = useState(() => { try {
        const values = JSON.parse(localStorage.getItem("sideband.repositories.v1") ?? "[]");
        return Array.isArray(values) ? values.filter(value => typeof value === "string").slice(0, 8) : [];
    }
    catch {
        return [];
    } });
    useEffect(() => { if (!selected && eligible.length === 1)
        setMachine(eligible[0].id); }, [selected, eligible.length]);
    useEffect(() => {
        if (initial || editedHarness.current || eligible.length)
            return;
        const candidate = ["omp", "codex", "claude"].find(name => state.control.machines.some(machine => machine.online && machine.harnesses.includes(name)));
        if (candidate && candidate !== harness) {
            setHarness(candidate);
            setTerminal(candidate !== "claude");
        }
    }, [harness, state.control.machines, eligible.length, initial]);
    return _jsx(Modal, { id: "new-agent-dialog", open: true, onOpenChange: open => { if (!open && !busy && !trustBusy)
            close(); }, title: "New agent", description: "Choose a machine and an optional repository. Your agent gets its own workspace and stays available for new work.", children: _jsxs("form", { id: "agent-launch-form", onSubmit: event => {
                event.preventDefault();
                if (busy || trustBusy || !selected)
                    return;
                setBusy(true);
                setError("");
                const form = new FormData(event.currentTarget);
                const spec = { machineId: machine, ...(repository.trim() ? { repository: repository.trim() } : {}), name: name.trim(), harness };
                if (native && terminal && selected.terminal && selected.terminal !== "none")
                    spec.terminal = true;
                for (const key of ["ref", "model", "effort", "prompt"]) {
                    const value = String(form.get(key) ?? "").trim();
                    if (value)
                        spec[key] = value;
                }
                if (room.trim())
                    spec.room = room.trim();
                void store.launch(spec).then(() => { try {
                    if (spec.repository)
                        localStorage.setItem("sideband.repositories.v1", JSON.stringify([spec.repository, ...recent.filter(value => value !== spec.repository)].slice(0, 8)));
                }
                catch { /* Optional convenience. */ } close(); })
                    .catch(error => setError(error instanceof Error ? error.message : "Launch failed.")).finally(() => setBusy(false));
            }, children: [_jsxs(Field, { label: "Repository (optional)", htmlFor: "agent-repository", hint: "Leave empty for a new workspace, or enter an HTTPS or SSH Git URL.", children: [_jsx("input", { id: "agent-repository", autoFocus: true, className: "input", maxLength: 2048, placeholder: "Empty workspace or Git URL", list: "recent-repositories", value: repository, onChange: event => {
                                const repository = event.target.value;
                                setRepository(repository);
                                if (!editedName.current) {
                                    const base = (repository.trim() ? repositoryName(repository) : "").replace(/[^a-zA-Z0-9_-]/g, "-").replace(/^[^a-zA-Z0-9]+/, "").slice(0, 55);
                                    const used = new Set(state.control.agents.map(agent => agent.name.toLowerCase()));
                                    let name = base, index = 2;
                                    while (used.has(name.toLowerCase()))
                                        name = `${base}-${index++}`;
                                    setName(name);
                                }
                            } }), _jsx("datalist", { id: "recent-repositories", children: recent.map(value => _jsx("option", { value: value }, value)) })] }), _jsxs("div", { className: "form-grid", children: [_jsx(Field, { label: "Agent name", htmlFor: "agent-name", children: _jsx("input", { id: "agent-name", className: "input", required: true, maxLength: 64, pattern: "[a-zA-Z0-9][a-zA-Z0-9_-]*", placeholder: "project", value: name, onChange: event => { editedName.current = true; setName(event.target.value); } }) }), _jsx(Field, { label: "Run on", htmlFor: "agent-machine", children: _jsxs("select", { id: "agent-machine", className: "select", required: true, value: machine, onChange: event => setMachine(event.target.value), children: [_jsx("option", { value: "", disabled: true, children: "Choose a machine" }), state.control.machines.map(candidate => _jsxs("option", { value: candidate.id, disabled: !candidate.online || !candidate.harnesses.includes(harness), children: [candidate.name, !candidate.online ? " — offline" : !candidate.harnesses.includes(harness) ? " — OMP not installed" : ` · ${candidate.platform}`] }, candidate.id))] }) })] }), !eligible.length && _jsxs("div", { className: "mb-5", children: [state.control.machines.length > 0 && _jsxs("p", { className: "field-hint mb-3", children: ["No connected machine can run ", harnessLabel, " yet. Bring a machine online, or install ", harnessLabel, " and restart its worker."] }), _jsx(WorkerSetup, { state: state })] }), _jsx("span", { className: "field-label", id: "harness-label", children: "Harness" }), _jsx(RadioGroup.Root, { id: "agent-harness", className: "harness-picker", value: harness, onValueChange: value => { editedHarness.current = true; setHarness(value); setTerminal(value !== "claude"); }, "aria-labelledby": "harness-label", children: ["omp", "claude", "codex"].map(name => _jsx(RadioGroup.Item, { type: "button", className: "harness-option", value: name, children: name === "omp" ? "oh-my-pi" : name === "claude" ? "Claude" : "Codex" }, name)) }), _jsx(Field, { label: "Local terminal", htmlFor: "agent-terminal", hint: !native ? "Native Claude control needs Windows or tmux. Background mode supports all web controls." : harness === "claude" ? "Experimental console input. Complete startup/trust prompts locally. Avoid local typing while sending from the web panel. Background mode is more reliable." : selected?.terminal === "window" ? `Opens the normal ${harnessLabel} terminal on ${selected.name}. Uncheck to run in the background.` : selected?.terminal === "tmux" ? `Starts ${harnessLabel} in tmux. The agent output shows the local attach command.` : "Background only. Update the worker or install a terminal launcher to open locally.", children: _jsxs("label", { className: "flex items-center gap-2", children: [_jsx("input", { id: "agent-terminal", type: "checkbox", checked: native && terminal && !!selected?.terminal && selected.terminal !== "none", disabled: !native || !selected?.terminal || selected.terminal === "none", onChange: event => setTerminal(event.target.checked) }), "Open ", harnessLabel, " on the machine", harness === "claude" ? " (experimental)" : ""] }) }), harness === "claude" && native && terminal && selected && _jsx(ClaudeTrust, { machine: selected, store: store, onBusyChange: setTrustBusy }, selected.id), _jsx(Field, { label: "Room", htmlFor: "launch-room", hint: "Optional. The agent joins this room automatically.", children: _jsx(RoomPicker, { id: "launch-room", rooms: allRooms(state), value: room, onChange: setRoom }) }), _jsx(Field, { label: "What should it work on?", htmlFor: "launch-prompt", children: _jsx("textarea", { id: "launch-prompt", className: "textarea", name: "prompt", rows: 3, maxLength: 16000, defaultValue: initial?.prompt ?? "", placeholder: "Give it a task, or leave this empty and send instructions later." }) }), _jsxs("details", { className: "advanced-section", children: [_jsxs("summary", { children: [_jsx(ChevronRight, { size: 14 }), "Advanced"] }), _jsx(Field, { label: "Branch or ref", htmlFor: "launch-ref", children: _jsx("input", { id: "launch-ref", className: "input", name: "ref", maxLength: 256, disabled: !repository.trim(), defaultValue: initial?.ref ?? "", placeholder: repository.trim() ? "Repository default" : "Requires a repository" }) }), _jsxs("div", { className: "form-grid", children: [_jsx(Field, { label: "Model", htmlFor: "launch-model", children: _jsx("input", { id: "launch-model", className: "input", name: "model", maxLength: 256, defaultValue: initial?.model ?? "", placeholder: "Harness default" }) }), _jsx(Field, { label: "Reasoning effort", htmlFor: "launch-effort", children: _jsxs("select", { id: "launch-effort", className: "select", name: "effort", defaultValue: initial?.effort ?? "", children: [_jsx("option", { value: "", children: "Harness default" }), (harness === "claude" ? ["low", "medium", "high", "xhigh", "max"] : ["off", "minimal", "low", "medium", "high", "xhigh", "max", "auto"]).map(value => _jsx("option", { children: value }, value))] }) })] }), _jsx("p", { className: "field-hint", children: "Agents run unattended, using this machine\u2019s existing harness credentials." })] }), _jsx(ErrorMessage, { text: error || state.controlError, id: "launch-error" }), _jsxs("div", { className: "form-actions", children: [_jsx(Button, { onClick: close, disabled: busy || trustBusy, variant: "ghost", children: "Cancel" }), _jsxs(Button, { id: "agent-launch", variant: "primary", type: "submit", disabled: busy || trustBusy || !selected, children: [busy ? _jsx(Spinner, {}) : _jsx(Plus, { size: 15 }), busy ? "Starting…" : "Launch agent"] })] })] }) });
}
export function JoinRoom({ state, store, close }) {
    const [name, setName] = useState(""), [busy, setBusy] = useState(false), [error, setError] = useState("");
    const rooms = allRooms(state).filter(room => room.name.toLowerCase().includes(name.toLowerCase())), exact = rooms.find(room => room.name.toLowerCase() === name.trim().toLowerCase());
    const join = (name) => { if (busy)
        return; setBusy(true); setError(""); void store.openRoom(name).then(close).catch(error => setError(error instanceof Error ? error.message : "Could not join.")).finally(() => setBusy(false)); };
    useEffect(() => { void store.refreshRooms(); }, [store]);
    return _jsx(Modal, { id: "join-room-dialog", open: true, onOpenChange: open => { if (!open && !busy)
            close(); }, title: "Join a room", description: "Join an existing conversation, or create a room for a new project.", children: _jsxs("form", { id: "join-form", onSubmit: event => { event.preventDefault(); if (name.trim())
                join(exact?.id ?? name.trim()); }, children: [_jsx(Field, { label: "Room name", htmlFor: "room-name", children: _jsx("input", { autoFocus: true, id: "room-name", className: "input", value: name, onChange: event => setName(event.target.value), maxLength: 100, placeholder: "Find or create a room\u2026", required: true }) }), _jsx("div", { className: "room-choices", children: rooms.map(room => _jsxs("button", { className: "room-choice", type: "button", disabled: busy, onClick: () => join(room.id), children: [_jsx(Hash, { size: 15 }), _jsx("span", { className: "room-choice-copy", children: room.name }), _jsx("small", { children: state.joined.some(joined => joined.id === room.id) ? "Joined" : `${room.members} participants` }), _jsx(ArrowUpRight, { size: 13 })] }, room.id)) }), _jsx(ErrorMessage, { text: error }), _jsxs("div", { className: "form-actions", children: [_jsx(Button, { onClick: close, variant: "ghost", disabled: busy, children: "Cancel" }), _jsxs(Button, { type: "submit", variant: "primary", disabled: busy || !name.trim(), children: [busy ? _jsx(Spinner, {}) : _jsx(Hash, { size: 14 }), exact ? "Join room" : "Create room"] })] })] }) });
}
function MachineList({ state, store }) {
    return _jsx("div", { className: "machine-list", children: state.control.machines.map(machine => _jsxs("div", { children: [_jsxs("div", { className: "machine-card", children: [_jsx(Monitor, { size: 17, className: "text-zinc-500" }), _jsxs("div", { className: "machine-copy", children: [_jsx("strong", { children: machine.name }), _jsxs("small", { children: [machine.platform, " \u00B7 ", machine.harnesses.length ? machine.harnesses.join(", ").toUpperCase() : "No supported harness detected"] })] }), _jsx(Status, { state: machine.online ? "on" : "offline", label: true })] }), machine.harnesses.includes("claude") && _jsx(ClaudeTrust, { machine: machine, store: store })] }, machine.id)) });
}
export function Settings({ state, store, close }) {
    const [tab, setTab] = useState("general"), [room, setRoom] = useState(state.joined.find(room => room.id === state.lastRoom)?.name ?? ""), [sender, setSender] = useState(""), [url, setUrl] = useState(""), [error, setError] = useState(""), [busy, setBusy] = useState(false), [toast, setToast] = useState("");
    const [, rerender] = useState(0), output = useRef(null);
    const notificationAvailable = typeof Notification !== "undefined", secure = window.isSecureContext !== false, permission = notificationAvailable ? Notification.permission : "denied";
    const notificationStatus = !state.identity?.name ? "Connect with a username to receive @mentions." : !secure ? "Desktop notifications need HTTPS or localhost. Mention badges still work." : !notificationAvailable ? "Notifications are unavailable in this browser. Mention badges still work." : permission === "granted" ? "You’ll be notified when someone mentions your username." : permission === "denied" ? "Notifications are blocked. Enable them in your browser’s site settings." : "Get a desktop notification when someone mentions @yourUsername.";
    return _jsxs(Modal, { id: "settings-dialog", open: true, onOpenChange: open => { if (!open)
            close(); }, title: "Settings", description: "Your connection, notifications and room integrations.", children: [_jsxs(Tabs.Root, { value: tab, onValueChange: value => { setTab(value); setUrl(""); setError(""); setToast(""); }, children: [_jsx(Tabs.List, { className: "settings-tabs", "aria-label": "Settings sections", children: ["general", "machines", "updates", "webhooks"].map(value => _jsx(Tabs.Trigger, { value: value, className: "button button-ghost", children: value.charAt(0).toUpperCase() + value.slice(1) }, value)) }), _jsxs(Tabs.Content, { value: tab, children: [tab === "general" && _jsxs(_Fragment, { children: [_jsxs("div", { className: "settings-section", children: [_jsx("h3", { children: "Notifications" }), _jsx("p", { id: "notification-status", children: notificationStatus }), _jsxs(Button, { id: "notifications", className: "mt-3", disabled: !secure || !notificationAvailable || permission !== "default" || !state.identity?.name, onClick: () => { void Notification.requestPermission().then(() => rerender(value => value + 1)).catch(() => setError("Notifications could not be enabled.")); }, children: [permission === "granted" ? _jsx(Check, { size: 14 }) : _jsx(Activity, { size: 14 }), permission === "granted" ? "Notifications enabled" : "Enable desktop notifications"] })] }), _jsxs("div", { className: "settings-section", children: [_jsx("h3", { children: "Connection" }), _jsxs("p", { children: [location.host, " \u00B7 ", location.protocol === "https:" ? "HTTPS" : "HTTP (unencrypted)"] }), _jsxs("p", { className: "mt-2", children: ["Signed in as ", state.identity ? identityLabel(state.identity) : "guest", ". Your login is remembered in this browser."] }), _jsxs("div", { className: "mt-4 flex flex-wrap gap-2", children: [_jsxs(Button, { id: "logout", onClick: () => { close(); store.logout(); }, children: [_jsx(LogOut, { size: 14 }), "Disconnect"] }), _jsxs(Button, { variant: "ghost", onClick: () => window.open("/", "_blank", "noopener"), children: [_jsx(ArrowUpRight, { size: 14 }), "Server status"] })] })] })] }), tab === "machines" && _jsxs(_Fragment, { children: [_jsx(MachineList, { state: state, store: store }), _jsx("div", { className: "mt-5", children: _jsx(WorkerSetup, { state: state }) })] }), tab === "updates" && _jsx(Updates, { state: state, store: store }), tab === "webhooks" && _jsxs("form", { id: "webhook-form", onSubmit: event => {
                                    event.preventDefault();
                                    if (busy || !room.trim())
                                        return;
                                    setBusy(true);
                                    setUrl("");
                                    setError("");
                                    void store.webhook(room.trim(), sender.trim()).then(result => setUrl(new URL(result.path, location.origin).href)).catch(error => setError(error instanceof Error ? error.message : "Could not generate URL.")).finally(() => setBusy(false));
                                }, children: [_jsx(Field, { label: "Destination room", htmlFor: "webhook-room", children: _jsx(RoomPicker, { id: "webhook-room", rooms: allRooms(state), value: room, onChange: value => { setRoom(value); setUrl(""); }, allowNone: false }) }), _jsx(Field, { label: "Sender name", htmlFor: "webhook-sender", children: _jsx("input", { id: "webhook-sender", className: "input", value: sender, onChange: event => { setSender(event.target.value); setUrl(""); }, required: true, pattern: "[a-zA-Z0-9][a-zA-Z0-9_-]*", maxLength: 64, placeholder: "github" }) }), _jsx("p", { className: "field-hint", children: "GitHub events become compact summaries. Other JSON payloads appear as YAML. This URL posts only to the selected room and stays valid until password rotation." }), _jsxs(Button, { id: "webhook-generate", type: "submit", className: "mt-4", disabled: busy || !room.trim() || !sender.trim(), children: [busy ? _jsx(Spinner, {}) : _jsx(Plus, { size: 14 }), "Generate URL"] }), url && _jsxs("div", { id: "webhook-result", className: "webhook-result", children: [_jsx(Field, { label: "Webhook URL", htmlFor: "webhook-url", children: _jsx("textarea", { ref: output, id: "webhook-url", className: "textarea", readOnly: true, rows: 3, value: url }) }), _jsxs(Button, { id: "webhook-copy", onClick: () => {
                                                    if (navigator.clipboard?.writeText)
                                                        void navigator.clipboard.writeText(url).then(() => setToast("URL copied.")).catch(() => { output.current?.focus(); output.current?.select(); });
                                                    else {
                                                        output.current?.focus();
                                                        output.current?.select();
                                                        setToast("Select and copy the URL.");
                                                    }
                                                }, children: [_jsx(Copy, { size: 14 }), "Copy URL"] }), _jsx("p", { className: "field-hint", children: "Copy it now. Webhook URLs are not saved." })] })] })] })] }), _jsx(ErrorMessage, { text: error }), toast && _jsx("p", { className: "settings-toast", role: "status", children: toast })] });
}
export function AgentActionDialog({ mode, agent, state, store, close }) {
    const [room, setRoom] = useState(agent.room), [busy, setBusy] = useState(false), [error, setError] = useState("");
    return _jsx(Modal, { id: "agent-action-dialog", returnFocus: 'button[aria-label="Agent actions"]', open: true, onOpenChange: open => { if (!open && !busy)
            close(); }, title: mode === "room" ? "Change room" : `${agent.online ? "Remove" : "Forget"} ${agent.name}?`, description: mode === "room" ? "The agent leaves its current room and joins the one you choose." : agent.online ? "This stops the agent and removes it from the list. Its checkout and session files stay on the machine. You won’t be able to resume it from this panel afterward." : `This removes the offline entry. It may still be running on ${agent.machineName}; its runner will shut down when it reconnects to this server. Files stay on the machine.`, children: _jsxs("form", { id: "agent-room-form", onSubmit: event => {
                event.preventDefault();
                if (busy)
                    return;
                setBusy(true);
                setError("");
                void (async () => {
                    if (mode === "room")
                        await store.action(agent.id, "room", { room: room.trim() });
                    else {
                        if (agent.online && !["stopped", "failed"].includes(agent.state))
                            await store.action(agent.id, "stop");
                        await store.action(agent.id, "dispose");
                    }
                    close();
                })().catch(error => setError(error instanceof Error ? error.message : "Request failed.")).finally(() => setBusy(false));
            }, children: [mode === "room" && _jsx(Field, { label: "Room", htmlFor: "agent-room", children: _jsx(RoomPicker, { id: "agent-room", rooms: allRooms(state), value: room, onChange: setRoom }) }), _jsx(ErrorMessage, { text: error }), _jsxs("div", { className: "form-actions", children: [_jsx(Button, { variant: "ghost", onClick: close, disabled: busy, children: "Cancel" }), _jsxs(Button, { id: "agent-room-apply", type: "submit", variant: mode === "remove" ? "danger" : "primary", disabled: busy, children: [busy && _jsx(Spinner, {}), mode === "room" ? "Save room" : agent.online ? "Remove agent" : "Forget agent"] })] })] }) });
}
export function Login({ store, state }) {
    const [key, setKey] = useState(0), saved = store.savedLogin(), busy = state.connection === "connecting";
    return _jsx("section", { id: "login-panel", className: "login-screen", children: _jsxs("div", { className: "login-card", children: [_jsx("div", { className: "login-brand", children: _jsx(Brand, {}) }), _jsx("h1", { children: "Welcome to your workspace" }), _jsxs("p", { children: ["Chat with your agents and manage work across machines.", _jsx("br", {}), _jsx("span", { className: "login-host", children: location.host })] }), _jsxs("form", { id: "login-form", onSubmit: event => { event.preventDefault(); const data = new FormData(event.currentTarget); void store.login(String(data.get("username") ?? ""), String(data.get("password") ?? "")).catch(() => { }); }, children: [_jsx(Field, { label: "Your name", htmlFor: "username", children: _jsx("input", { id: "username", name: "username", className: "input", autoComplete: "username", maxLength: 64, defaultValue: saved?.name ?? "", placeholder: "How should people know you?" }) }), _jsx(Field, { label: "Server password", htmlFor: "password", children: _jsx("input", { id: "password", name: "password", className: "input", type: "password", autoComplete: "current-password", required: true, defaultValue: saved?.password ?? "", placeholder: "sb1.\u2026" }) }), _jsx(ErrorMessage, { id: "login-error", text: state.error }), _jsxs(Button, { id: "login-button", variant: "primary", type: "submit", disabled: busy, children: [busy ? _jsx(Spinner, {}) : _jsx(ArrowUpRight, { size: 16 }), busy ? "Connecting…" : "Connect to Sideband"] }), _jsx("p", { className: "login-footnote", children: "Your name and password stay in this browser so you can reconnect automatically. HTTP and HTTPS keep separate saved logins." }), _jsx(Button, { id: "forget", className: "forget-login", variant: "ghost", onClick: () => { store.forget(); setKey(value => value + 1); }, children: "Forget saved login" })] }, key)] }) });
}
//# sourceMappingURL=browser-dialogs.js.map