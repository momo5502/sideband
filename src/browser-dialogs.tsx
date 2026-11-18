import { useEffect, useRef, useState } from "react";
import * as RadioGroup from "@radix-ui/react-radio-group";
import * as Tabs from "@radix-ui/react-tabs";
import { Activity, ArrowUpRight, Check, ChevronRight, Copy, Hash, LogOut, Monitor, Plus } from "lucide-react";
import { BrowserWorkspace, identityLabel, type WorkspaceState } from "./browser-workspace.js";
import { Button, ErrorMessage, Field, Modal, Spinner } from "./browser-components.js";
import { allRooms, Brand, repositoryName, Status } from "./browser-views.js";
import type { Room } from "./room-protocol.js";
import type { ManagedAgent, LaunchSpec } from "./orchestration-protocol.js";
import { Updates } from "./browser-updates.js";

function RoomPicker({ rooms, value, onChange, id, allowNone = true }: { rooms: Room[]; value: string; onChange(value: string): void; id: string; allowNone?: boolean }) {
  const [creating, setCreating] = useState(false);
  return <><select id={id} className="select" value={creating ? "__new__" : value} onChange={event => { const value = event.target.value; setCreating(value === "__new__"); onChange(value === "__new__" ? "" : value); }}>
    <option value="">{allowNone ? "No room" : "Choose a room"}</option>{rooms.map(room => <option key={room.id} value={room.name}># {room.name}</option>)}
    {value && !creating && !rooms.some(room => room.name === value) && <option value={value}># {value}</option>}<option value="__new__">Create a new room…</option>
  </select>{creating && <input autoFocus className="input room-picker-new" aria-label="New room name" placeholder="New room name" maxLength={100} value={value} onChange={event => onChange(event.target.value)} required />}</>;
}
function CopyCommand({ text }: { text: string }) {
  const [copied, setCopied] = useState(false), input = useRef<HTMLInputElement>(null);
  return <div className="copy-command"><input className="input" ref={input} readOnly aria-label="Terminal command" value={text} onFocus={event => event.currentTarget.select()} /><Button variant="outline" icon aria-label="Copy command" onClick={() => {
    if (navigator.clipboard?.writeText) void navigator.clipboard.writeText(text).then(() => setCopied(true)).catch(() => { input.current?.focus(); input.current?.select(); }); else { input.current?.focus(); input.current?.select(); }
  }}>{copied ? <Check size={15} /> : <Copy size={15} />}</Button></div>;
}
function WorkerSetup({ state }: { state: WorkspaceState }) {
  const port = state.control.serverPort ?? 8765;
  const server = `${location.hostname}${port === 443 ? "" : `:${port}`}`;
  return <div className="setup-box"><p className="font-medium text-zinc-300">Connect a machine</p><p className="mt-1">On a machine with OMP and Sideband installed, sign in once:</p><CopyCommand text={`sideband login ${server}`} /><p className="mt-3">Then keep its worker running:</p><CopyCommand text="sideband worker" /></div>;
}
export function NewAgent({ state, store, close, initial }: { state: WorkspaceState; store: BrowserWorkspace; close(): void; initial?: ManagedAgent }) {
  const [repository, setRepository] = useState(initial?.repository ?? ""), [name, setName] = useState(() => {
    if (!initial) return ""; const names = new Set(state.control.agents.map(agent => agent.name.toLowerCase())); const base = initial.name.slice(0, 55); let result = base, index = 2; while (names.has(result.toLowerCase())) result = `${base}-${index++}`; return result;
  }), [room, setRoom] = useState(initial?.room ?? state.joined.find(room => room.id === state.lastRoom)?.name ?? "");
  const [machine, setMachine] = useState(() => {
    const eligible = state.control.machines.filter(machine => machine.online && machine.harnesses.includes("omp"));
    return eligible.find(machine => machine.id === initial?.machineId)?.id ?? eligible.find(machine => machine.name === initial?.machineName)?.id ?? eligible[0]?.id ?? "";
  });
  const [busy, setBusy] = useState(false), [error, setError] = useState(""); const editedName = useRef(false);
  const [terminal, setTerminal] = useState(initial ? initial.terminal === true : true);
  const eligible = state.control.machines.filter(machine => machine.online && machine.harnesses.includes("omp")), selected = eligible.find(candidate => candidate.id === machine);
  const [recent] = useState<string[]>(() => { try { const values = JSON.parse(localStorage.getItem("sideband.repositories.v1") ?? "[]"); return Array.isArray(values) ? values.filter(value => typeof value === "string").slice(0, 8) : []; } catch { return []; } });
  useEffect(() => { if (!selected && eligible.length === 1) setMachine(eligible[0]!.id); }, [selected, eligible.length]);
  return <Modal id="new-agent-dialog" open onOpenChange={open => { if (!open && !busy) close(); }} title="New agent" description="Choose a machine and an optional repository. Your agent gets its own workspace and stays available for new work.">
    <form id="agent-launch-form" onSubmit={event => {
      event.preventDefault(); if (busy || !selected) return; setBusy(true); setError(""); const form = new FormData(event.currentTarget);
      const spec: LaunchSpec & { machineId: string } = { machineId: machine, ...(repository.trim() ? { repository: repository.trim() } : {}), name: name.trim(), harness: "omp" };
      if (terminal && selected.terminal && selected.terminal !== "none") spec.terminal = true;
      for (const key of ["ref", "model", "effort", "prompt"] as const) { const value = String(form.get(key) ?? "").trim(); if (value) spec[key] = value; } if (room.trim()) spec.room = room.trim();
      void store.launch(spec).then(() => { try { if (spec.repository) localStorage.setItem("sideband.repositories.v1", JSON.stringify([spec.repository, ...recent.filter(value => value !== spec.repository)].slice(0, 8))); } catch { /* Optional convenience. */ } close(); })
        .catch(error => setError(error instanceof Error ? error.message : "Launch failed.")).finally(() => setBusy(false));
    }}>
      <Field label="Repository (optional)" htmlFor="agent-repository" hint="Leave empty for a new workspace, or enter an HTTPS or SSH Git URL."><input id="agent-repository" autoFocus className="input" maxLength={2048} placeholder="Empty workspace or Git URL" list="recent-repositories" value={repository} onChange={event => {
        const repository = event.target.value; setRepository(repository);
        if (!editedName.current) { const base = (repository.trim() ? repositoryName(repository) : "").replace(/[^a-zA-Z0-9_-]/g, "-").replace(/^[^a-zA-Z0-9]+/, "").slice(0, 55); const used = new Set(state.control.agents.map(agent => agent.name.toLowerCase())); let name = base, index = 2; while (used.has(name.toLowerCase())) name = `${base}-${index++}`; setName(name); }
      }} /><datalist id="recent-repositories">{recent.map(value => <option key={value} value={value} />)}</datalist></Field>
      <div className="form-grid"><Field label="Agent name" htmlFor="agent-name"><input id="agent-name" className="input" required maxLength={64} pattern="[a-zA-Z0-9][a-zA-Z0-9_-]*" placeholder="project" value={name} onChange={event => { editedName.current = true; setName(event.target.value); }} /></Field>
        <Field label="Run on" htmlFor="agent-machine"><select id="agent-machine" className="select" required value={machine} onChange={event => setMachine(event.target.value)}><option value="" disabled>Choose a machine</option>
          {state.control.machines.map(candidate => <option key={candidate.id} value={candidate.id} disabled={!candidate.online || !candidate.harnesses.includes("omp")}>{candidate.name}{!candidate.online ? " — offline" : !candidate.harnesses.includes("omp") ? " — OMP not installed" : ` · ${candidate.platform}`}</option>)}</select></Field></div>
      {!eligible.length && <div className="mb-5">{state.control.machines.length > 0 && <p className="field-hint mb-3">No connected machine can run OMP yet. Bring a machine online, or install OMP and restart its worker.</p>}<WorkerSetup state={state} /></div>}
      <span className="field-label" id="harness-label">Harness</span><RadioGroup.Root id="agent-harness" className="harness-picker" value="omp" aria-labelledby="harness-label"><RadioGroup.Item type="button" className="harness-option" value="omp">oh-my-pi</RadioGroup.Item><RadioGroup.Item type="button" className="harness-option" value="claude" disabled>Claude<small>Coming soon</small></RadioGroup.Item><RadioGroup.Item type="button" className="harness-option" value="codex" disabled>Codex<small>Coming soon</small></RadioGroup.Item></RadioGroup.Root>
      <Field label="Local terminal" htmlFor="agent-terminal" hint={selected?.terminal === "window" ? `Opens the normal OMP terminal on ${selected.name}. Uncheck to run in the background.` : selected?.terminal === "tmux" ? "Starts OMP in tmux. The agent output shows the local attach command." : "Background only. Update the worker or install a terminal launcher to open OMP locally."}><label className="flex items-center gap-2"><input id="agent-terminal" type="checkbox" checked={terminal && !!selected?.terminal && selected.terminal !== "none"} disabled={!selected?.terminal || selected.terminal === "none"} onChange={event => setTerminal(event.target.checked)} />Open OMP on the machine</label></Field>
      <Field label="Room" htmlFor="launch-room" hint="Optional. The agent joins this room automatically."><RoomPicker id="launch-room" rooms={allRooms(state)} value={room} onChange={setRoom} /></Field>
      <Field label="What should it work on?" htmlFor="launch-prompt"><textarea id="launch-prompt" className="textarea" name="prompt" rows={3} maxLength={16000} defaultValue={initial?.prompt ?? ""} placeholder="Give it a task, or leave this empty and send instructions later." /></Field>
      <details className="advanced-section"><summary><ChevronRight size={14} />Advanced</summary><Field label="Branch or ref" htmlFor="launch-ref"><input id="launch-ref" className="input" name="ref" maxLength={256} disabled={!repository.trim()} defaultValue={initial?.ref ?? ""} placeholder={repository.trim() ? "Repository default" : "Requires a repository"} /></Field>
        <div className="form-grid"><Field label="Model" htmlFor="launch-model"><input id="launch-model" className="input" name="model" maxLength={256} defaultValue={initial?.model ?? ""} placeholder="Harness default" /></Field><Field label="Reasoning effort" htmlFor="launch-effort"><select id="launch-effort" className="select" name="effort" defaultValue={initial?.effort ?? ""}><option value="">Harness default</option>{["off", "minimal", "low", "medium", "high", "xhigh", "max", "auto"].map(value => <option key={value}>{value}</option>)}</select></Field></div>
        <p className="field-hint">Agents run unattended, using this machine’s existing harness credentials.</p></details>
      <ErrorMessage text={error || state.controlError} id="launch-error" /><div className="form-actions"><Button onClick={close} disabled={busy} variant="ghost">Cancel</Button><Button id="agent-launch" variant="primary" type="submit" disabled={busy || !selected}>{busy ? <Spinner /> : <Plus size={15} />}{busy ? "Starting…" : "Launch agent"}</Button></div>
    </form>
  </Modal>;
}
export function JoinRoom({ state, store, close }: { state: WorkspaceState; store: BrowserWorkspace; close(): void }) {
  const [name, setName] = useState(""), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const rooms = allRooms(state).filter(room => room.name.toLowerCase().includes(name.toLowerCase())), exact = rooms.find(room => room.name.toLowerCase() === name.trim().toLowerCase());
  const join = (name: string) => { if (busy) return; setBusy(true); setError(""); void store.openRoom(name).then(close).catch(error => setError(error instanceof Error ? error.message : "Could not join.")).finally(() => setBusy(false)); };
  useEffect(() => { void store.refreshRooms(); }, [store]);
  return <Modal id="join-room-dialog" open onOpenChange={open => { if (!open && !busy) close(); }} title="Join a room" description="Join an existing conversation, or create a room for a new project.">
    <form id="join-form" onSubmit={event => { event.preventDefault(); if (name.trim()) join(exact?.id ?? name.trim()); }}><Field label="Room name" htmlFor="room-name"><input autoFocus id="room-name" className="input" value={name} onChange={event => setName(event.target.value)} maxLength={100} placeholder="Find or create a room…" required /></Field>
      <div className="room-choices">{rooms.map(room => <button className="room-choice" type="button" key={room.id} disabled={busy} onClick={() => join(room.id)}><Hash size={15} /><span className="room-choice-copy">{room.name}</span><small>{state.joined.some(joined => joined.id === room.id) ? "Joined" : `${room.members} participants`}</small><ArrowUpRight size={13} /></button>)}</div>
      <ErrorMessage text={error} /><div className="form-actions"><Button onClick={close} variant="ghost" disabled={busy}>Cancel</Button><Button type="submit" variant="primary" disabled={busy || !name.trim()}>{busy ? <Spinner /> : <Hash size={14} />}{exact ? "Join room" : "Create room"}</Button></div>
    </form></Modal>;
}
function MachineList({ state }: { state: WorkspaceState }) {
  return <div className="machine-list">{state.control.machines.map(machine => <div key={machine.id} className="machine-card"><Monitor size={17} className="text-zinc-500" /><div className="machine-copy"><strong>{machine.name}</strong><small>{machine.platform} · {machine.harnesses.length ? machine.harnesses.join(", ").toUpperCase() : "No supported harness detected"}</small></div><Status state={machine.online ? "on" : "offline"} label /></div>)}</div>;
}
export function Settings({ state, store, close }: { state: WorkspaceState; store: BrowserWorkspace; close(): void }) {
  const [tab, setTab] = useState("general"), [room, setRoom] = useState(state.joined.find(room => room.id === state.lastRoom)?.name ?? ""), [sender, setSender] = useState(""), [url, setUrl] = useState(""), [error, setError] = useState(""), [busy, setBusy] = useState(false), [toast, setToast] = useState("");
  const [, rerender] = useState(0), output = useRef<HTMLTextAreaElement>(null);
  const notificationAvailable = typeof Notification !== "undefined", secure = window.isSecureContext !== false, permission = notificationAvailable ? Notification.permission : "denied";
  const notificationStatus = !state.identity?.name ? "Connect with a username to receive @mentions." : !secure ? "Desktop notifications need HTTPS or localhost. Mention badges still work." : !notificationAvailable ? "Notifications are unavailable in this browser. Mention badges still work." : permission === "granted" ? "You’ll be notified when someone mentions your username." : permission === "denied" ? "Notifications are blocked. Enable them in your browser’s site settings." : "Get a desktop notification when someone mentions @yourUsername.";
  return <Modal id="settings-dialog" open onOpenChange={open => { if (!open) close(); }} title="Settings" description="Your connection, notifications and room integrations.">
    <Tabs.Root value={tab} onValueChange={value => { setTab(value); setUrl(""); setError(""); setToast(""); }}><Tabs.List className="settings-tabs" aria-label="Settings sections">{["general", "machines", "updates", "webhooks"].map(value => <Tabs.Trigger key={value} value={value} className="button button-ghost">{value.charAt(0).toUpperCase() + value.slice(1)}</Tabs.Trigger>)}</Tabs.List>
    <Tabs.Content value={tab}>
      {tab === "general" && <><div className="settings-section"><h3>Notifications</h3><p id="notification-status">{notificationStatus}</p><Button id="notifications" className="mt-3" disabled={!secure || !notificationAvailable || permission !== "default" || !state.identity?.name} onClick={() => { void Notification.requestPermission().then(() => rerender(value => value + 1)).catch(() => setError("Notifications could not be enabled.")); }}>{permission === "granted" ? <Check size={14} /> : <Activity size={14} />}{permission === "granted" ? "Notifications enabled" : "Enable desktop notifications"}</Button></div>
        <div className="settings-section"><h3>Connection</h3><p>{location.host} · {location.protocol === "https:" ? "HTTPS" : "HTTP (unencrypted)"}</p><p className="mt-2">Signed in as {state.identity ? identityLabel(state.identity) : "guest"}. Your login is remembered in this browser.</p><div className="mt-4 flex flex-wrap gap-2"><Button id="logout" onClick={() => { close(); store.logout(); }}><LogOut size={14} />Disconnect</Button><Button variant="ghost" onClick={() => window.open("/", "_blank", "noopener")}><ArrowUpRight size={14} />Server status</Button></div></div></>}
      {tab === "machines" && <><MachineList state={state} /><div className="mt-5"><WorkerSetup state={state} /></div></>}
      {tab === "updates" && <Updates state={state} store={store} />}
      {tab === "webhooks" && <form id="webhook-form" onSubmit={event => {
        event.preventDefault(); if (busy || !room.trim()) return; setBusy(true); setUrl(""); setError("");
        void store.webhook(room.trim(), sender.trim()).then(result => setUrl(new URL(result.path, location.origin).href)).catch(error => setError(error instanceof Error ? error.message : "Could not generate URL.")).finally(() => setBusy(false));
      }}><Field label="Destination room" htmlFor="webhook-room"><RoomPicker id="webhook-room" rooms={allRooms(state)} value={room} onChange={value => { setRoom(value); setUrl(""); }} allowNone={false} /></Field>
        <Field label="Sender name" htmlFor="webhook-sender"><input id="webhook-sender" className="input" value={sender} onChange={event => { setSender(event.target.value); setUrl(""); }} required pattern="[a-zA-Z0-9][a-zA-Z0-9_-]*" maxLength={64} placeholder="github" /></Field>
        <p className="field-hint">GitHub events become compact summaries. Other JSON payloads appear as YAML. This URL posts only to the selected room and stays valid until password rotation.</p>
        <Button id="webhook-generate" type="submit" className="mt-4" disabled={busy || !room.trim() || !sender.trim()}>{busy ? <Spinner /> : <Plus size={14} />}Generate URL</Button>
        {url && <div id="webhook-result" className="webhook-result"><Field label="Webhook URL" htmlFor="webhook-url"><textarea ref={output} id="webhook-url" className="textarea" readOnly rows={3} value={url} /></Field><Button id="webhook-copy" onClick={() => {
          if (navigator.clipboard?.writeText) void navigator.clipboard.writeText(url).then(() => setToast("URL copied.")).catch(() => { output.current?.focus(); output.current?.select(); }); else { output.current?.focus(); output.current?.select(); setToast("Select and copy the URL."); }
        }}><Copy size={14} />Copy URL</Button><p className="field-hint">Copy it now. Webhook URLs are not saved.</p></div>}</form>}
    </Tabs.Content></Tabs.Root><ErrorMessage text={error} />{toast && <p className="settings-toast" role="status">{toast}</p>}
  </Modal>;
}
export function AgentActionDialog({ mode, agent, state, store, close }: { mode: "room" | "remove"; agent: ManagedAgent; state: WorkspaceState; store: BrowserWorkspace; close(): void }) {
  const [room, setRoom] = useState(agent.room), [busy, setBusy] = useState(false), [error, setError] = useState("");
  return <Modal id="agent-action-dialog" returnFocus='button[aria-label="Agent actions"]' open onOpenChange={open => { if (!open && !busy) close(); }} title={mode === "room" ? "Change room" : `${agent.online ? "Remove" : "Forget"} ${agent.name}?`} description={mode === "room" ? "The agent leaves its current room and joins the one you choose." : agent.online ? "This stops the agent and removes it from the list. Its checkout and session files stay on the machine. You won’t be able to resume it from this panel afterward." : `This removes the offline entry. It may still be running on ${agent.machineName}; its runner will shut down when it reconnects to this server. Files stay on the machine.`}>
    <form id="agent-room-form" onSubmit={event => {
      event.preventDefault(); if (busy) return; setBusy(true); setError("");
      void (async () => {
        if (mode === "room") await store.action(agent.id, "room", { room: room.trim() });
        else { if (agent.online && !["stopped", "failed"].includes(agent.state)) await store.action(agent.id, "stop"); await store.action(agent.id, "dispose"); }
        close();
      })().catch(error => setError(error instanceof Error ? error.message : "Request failed.")).finally(() => setBusy(false));
    }}>
      {mode === "room" && <Field label="Room" htmlFor="agent-room"><RoomPicker id="agent-room" rooms={allRooms(state)} value={room} onChange={setRoom} /></Field>}
      <ErrorMessage text={error} /><div className="form-actions"><Button variant="ghost" onClick={close} disabled={busy}>Cancel</Button><Button id="agent-room-apply" type="submit" variant={mode === "remove" ? "danger" : "primary"} disabled={busy}>{busy && <Spinner />}{mode === "room" ? "Save room" : agent.online ? "Remove agent" : "Forget agent"}</Button></div>
    </form></Modal>;
}
export function Login({ store, state }: { store: BrowserWorkspace; state: WorkspaceState }) {
  const [key, setKey] = useState(0), saved = store.savedLogin(), busy = state.connection === "connecting";
  return <section id="login-panel" className="login-screen"><div className="login-card"><div className="login-brand"><Brand /></div><h1>Welcome to your workspace</h1><p>Chat with your agents and manage work across machines.<br /><span className="login-host">{location.host}</span></p>
    <form id="login-form" key={key} onSubmit={event => { event.preventDefault(); const data = new FormData(event.currentTarget); void store.login(String(data.get("username") ?? ""), String(data.get("password") ?? "")).catch(() => {}); }}>
      <Field label="Your name" htmlFor="username"><input id="username" name="username" className="input" autoComplete="username" maxLength={64} defaultValue={saved?.name ?? ""} placeholder="How should people know you?" /></Field>
      <Field label="Server password" htmlFor="password"><input id="password" name="password" className="input" type="password" autoComplete="current-password" required defaultValue={saved?.password ?? ""} placeholder="sb1.…" /></Field>
      <ErrorMessage id="login-error" text={state.error} /><Button id="login-button" variant="primary" type="submit" disabled={busy}>{busy ? <Spinner /> : <ArrowUpRight size={16} />}{busy ? "Connecting…" : "Connect to Sideband"}</Button>
      <p className="login-footnote">Your name and password stay in this browser so you can reconnect automatically. HTTP and HTTPS keep separate saved logins.</p>
      <Button id="forget" className="forget-login" variant="ghost" onClick={() => { store.forget(); setKey(value => value + 1); }}>Forget saved login</Button>
    </form></div></section>;
}
