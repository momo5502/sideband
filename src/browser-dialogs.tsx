import { useEffect, useRef, useState } from "react";
import * as RadioGroup from "@radix-ui/react-radio-group";
import * as Tabs from "@radix-ui/react-tabs";
import { Activity, ArrowUpRight, Check, ChevronRight, Copy, Hash, LogOut, Monitor, Plus } from "lucide-react";
import { BrowserWorkspace, identityLabel, type WorkspaceState } from "./browser-workspace.js";
import { Button, ErrorMessage, Field, Modal, Spinner } from "./browser-components.js";
import { allRooms, Brand, repositoryName, Status } from "./browser-views.js";
import type { Room } from "./room-protocol.js";
import type { ManagedAgent, LaunchSpec, HarnessName, Machine, ModelCatalog, FolderListing } from "./orchestration-protocol.js";
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
function ClaudeTrust({ machine, store, onBusyChange }: { machine: Machine; store: BrowserWorkspace; onBusyChange?(busy: boolean): void }) {
  const [busy, setBusy] = useState(false), [root, setRoot] = useState(""), [error, setError] = useState("");
  return <div className="setup-box mb-5" data-claude-trust={machine.id}>
    <p className="font-medium text-zinc-300">Claude workspace trust (one-time setup)</p>
    <p className="mt-1">Trust all current and future agent folders under this machine's Sideband workspace root. Claude can read, edit and execute files there. This saves the trust decision in Claude's configuration.</p>
    <Button className="mt-3" disabled={busy || !machine.online || !!root} onClick={() => {
      setBusy(true); onBusyChange?.(true); setError(""); void store.trustClaude(machine.id).then(result => setRoot(result.root)).catch(error => setError(error instanceof Error ? error.message : "Could not record trust.")).finally(() => { setBusy(false); onBusyChange?.(false); });
    }}>{busy ? <Spinner /> : root ? <Check size={14} /> : null}{root ? "Workspaces trusted" : busy ? "Recording trust..." : "Trust Claude workspaces"}</Button>
    {root && <p className="field-hint mt-2" role="status">Trusted: {root}. Start or resume the agent to apply it. An already-open trust prompt still needs local confirmation or a restart.</p>}
    <ErrorMessage text={error} />
  </div>;
}
function FolderPicker({ machine, store, value, onChange }: { machine?: Machine; store: BrowserWorkspace; value: string; onChange(value: string): void }) {
  const [listing, setListing] = useState<FolderListing>(), [busy, setBusy] = useState(false), [error, setError] = useState(""); const generation = useRef(0);
  useEffect(() => () => { generation.current++; }, []);
  const browse = (path?: string, cursor?: string) => {
    if (!machine?.folders) return; const current = ++generation.current; setBusy(true); setError("");
    void store.folders(machine.id, path, cursor).then(result => { if (current === generation.current) setListing(result); }).catch(error => { if (current === generation.current) setError(error instanceof Error ? error.message : "Could not browse folders."); }).finally(() => { if (current === generation.current) setBusy(false); });
  };
  return <Field label="Folder on the machine" htmlFor="agent-folder" hint="Uses this folder in place. The agent can edit its files; other agents using it share those changes. Archiving keeps the folder.">
    <input id="agent-folder" className="input" value={value} onChange={event => onChange(event.target.value)} required maxLength={4096} placeholder={machine?.platform === "win32" ? "C:\\projects\\my-project" : "/home/user/my-project"} />
    <Button id="browse-folders" className="mt-2" variant="outline" disabled={!machine?.online || !machine.folders || busy} onClick={() => browse(value || undefined)}>{busy ? <Spinner /> : <Monitor size={14} />}Browse {machine?.name ?? "machine"}</Button>
    {!machine?.folders && <p className="field-hint">Update this worker to use existing folders.</p>}
    {listing && <section className="setup-box mt-3" aria-label="Folders on selected machine"><p id="folder-current" className="break-all font-mono text-xs">{listing.path}</p><div className="flex flex-wrap gap-2 my-2">
      <Button id="folder-up" disabled={busy || !listing.parent} onClick={() => browse(listing.parent!)}>Up</Button>{listing.roots.map(root => <Button key={root} disabled={busy} onClick={() => browse(root)}>{root}</Button>)}
      <Button id="folder-use" variant="primary" disabled={busy} onClick={() => { onChange(listing.path); setListing(undefined); generation.current++; }}>Use this folder</Button><Button variant="ghost" onClick={() => { setListing(undefined); generation.current++; setBusy(false); }}>Close browser</Button></div>
      <div className="max-h-52 overflow-y-auto">{listing.entries.map(entry => <button key={entry.path} type="button" className="room-choice" disabled={busy} data-folder={entry.path} onClick={() => browse(entry.path)}>{entry.name}</button>)}{!listing.entries.length && <p className="field-hint">No accessible subfolders.</p>}</div>
      {listing.next && <Button id="folder-next" disabled={busy} onClick={() => browse(listing.path, listing.next)}>Next folders</Button>}
      {listing.partial && <p className="field-hint">Some linked folders could not be checked. You can enter their path directly.</p>}
    </section>}<ErrorMessage text={error} />
  </Field>;
}
export function NewAgent({ state, store, close, initial }: { state: WorkspaceState; store: BrowserWorkspace; close(): void; initial?: ManagedAgent }) {
  const [source, setSource] = useState(initial?.folder ? "folder" : "new"), [folder, setFolder] = useState(initial?.folder ?? "");
  const [repository, setRepository] = useState(initial?.repository ?? ""), [name, setName] = useState(() => {
    if (!initial) return ""; const names = new Set(state.control.agents.map(agent => agent.name.toLowerCase())); const base = initial.name.slice(0, 55); let result = base, index = 2; while (names.has(result.toLowerCase())) result = `${base}-${index++}`; return result;
  }), [room, setRoom] = useState(initial?.room ?? state.joined.find(room => room.id === state.lastRoom)?.name ?? "");
  const [harness, setHarness] = useState<HarnessName>(() => initial?.harness ?? (["omp", "codex", "claude", "pi"] as const).find(name => state.control.machines.some(machine => machine.online && machine.harnesses.includes(name))) ?? "omp");
  const harnessLabel = { omp: "OMP", codex: "Codex", claude: "Claude", pi: "PI" }[harness];
  const [machine, setMachine] = useState(() => {
    const eligible = state.control.machines.filter(machine => machine.online && machine.harnesses.includes(harness));
    if (initial?.folder) return initial.machineId;
    return eligible.find(machine => machine.id === initial?.machineId)?.id ?? eligible.find(machine => machine.name === initial?.machineName)?.id ?? eligible[0]?.id ?? "";
  });
  const [busy, setBusy] = useState(false), [trustBusy, setTrustBusy] = useState(false), [error, setError] = useState(""); const editedName = useRef(false);
  const [terminal, setTerminal] = useState(initial ? initial.terminal === true : harness !== "claude");
  const editedHarness = useRef(false);
  const eligible = state.control.machines.filter(machine => machine.online && machine.harnesses.includes(harness)), selected = eligible.find(candidate => candidate.id === machine);
  const [model, setModel] = useState(initial?.model ?? ""), [effort, setEffort] = useState(initial?.effort ?? ""), [catalog, setCatalog] = useState<ModelCatalog>({ models: [], at: 0 }), [modelsBusy, setModelsBusy] = useState(false), [modelsError, setModelsError] = useState("");
  const modelInfo = catalog.models.find(candidate => candidate.id === model || !model && candidate.isDefault);
  const reasoning = modelInfo?.efforts ?? (harness === "pi" ? ["off", "minimal", "low", "medium", "high", "xhigh"] : harness === "claude" ? ["low", "medium", "high", "xhigh", "max"] : ["off", "minimal", "low", "medium", "high", "xhigh", "max", "auto", ...(harness === "codex" ? ["ultra"] : [])]);
  useEffect(() => {
    let current = true; setCatalog({ models: [], at: 0 }); setModelsError(""); setModelsBusy(false);
    if (selected) void store.models(selected.id, harness).then(value => { if (current) setCatalog(value); }).catch(() => { if (current) setModelsError("Model suggestions are unavailable. Enter a model ID or use the harness default."); });
    return () => { current = false; };
  }, [selected?.id, harness, selected?.models?.[harness]?.at, store]);
  useEffect(() => { if (effort && modelInfo?.efforts && !modelInfo.efforts.includes(effort)) setEffort(""); }, [modelInfo, effort]);
  const modelSelection = useRef(`${machine}:${harness}`);
  const folderMachine = useRef(machine);
  useEffect(() => { if (folderMachine.current !== machine) { folderMachine.current = machine; setFolder(""); } }, [machine]);
  useEffect(() => { const key = `${machine}:${harness}`; if (modelSelection.current !== key) { modelSelection.current = key; setModel(""); setEffort(""); } }, [machine, harness]);
  const native = harness !== "claude" || selected?.platform === "win32" || selected?.terminal === "tmux";
  const [recent] = useState<string[]>(() => { try { const values = JSON.parse(localStorage.getItem("sideband.repositories.v1") ?? "[]"); return Array.isArray(values) ? values.filter(value => typeof value === "string").slice(0, 8) : []; } catch { return []; } });
  useEffect(() => { if (!selected && eligible.length === 1 && !initial?.folder) setMachine(eligible[0]!.id); }, [selected, eligible.length, initial?.folder]);
  useEffect(() => {
    if (initial || editedHarness.current || eligible.length) return;
    const candidate = (["omp", "codex", "claude", "pi"] as const).find(name => state.control.machines.some(machine => machine.online && machine.harnesses.includes(name)));
    if (candidate && candidate !== harness) { setHarness(candidate); setTerminal(candidate !== "claude"); }
  }, [harness, state.control.machines, eligible.length, initial]);
  const suggestName = (value: string) => {
    if (editedName.current) return; const base = value.replace(/[^a-zA-Z0-9_-]/g, "-").replace(/^[^a-zA-Z0-9]+/, "").slice(0, 55), used = new Set(state.control.agents.map(agent => agent.name.toLowerCase()));
    let result = base, index = 2; while (used.has(result.toLowerCase())) result = `${base}-${index++}`; setName(result);
  };
  return <Modal id="new-agent-dialog" open onOpenChange={open => { if (!open && !busy && !trustBusy) close(); }} title="New agent" description="Choose a machine, harness and workspace. Your agent stays available for new work.">
    <form id="agent-launch-form" onSubmit={event => {
      event.preventDefault(); if (busy || trustBusy || !selected || source === "folder" && (!selected.folders || !folder)) return; setBusy(true); setError(""); const form = new FormData(event.currentTarget);
      const spec: LaunchSpec & { machineId: string } = { machineId: machine, ...(source === "folder" ? { folder } : repository.trim() ? { repository: repository.trim() } : {}), name: name.trim(), harness };
      if (native && terminal && selected.terminal && selected.terminal !== "none") spec.terminal = true;
      for (const key of ["ref", "model", "effort", "prompt"] as const) { const value = String(form.get(key) ?? "").trim(); if (value) spec[key] = value; } if (room.trim()) spec.room = room.trim();
      void store.launch(spec).then(() => { try { if (spec.repository) localStorage.setItem("sideband.repositories.v1", JSON.stringify([spec.repository, ...recent.filter(value => value !== spec.repository)].slice(0, 8))); } catch { /* Optional convenience. */ } close(); })
        .catch(error => setError(error instanceof Error ? error.message : "Launch failed.")).finally(() => setBusy(false));
    }}>
      <Field label="Workspace" htmlFor="agent-workspace"><select id="agent-workspace" className="select" value={source} onChange={event => setSource(event.target.value)}><option value="new">New workspace (empty or clone a repository)</option><option value="folder">Existing folder on the machine</option></select></Field>
      {source === "folder" ? <FolderPicker key={selected?.id ?? "none"} machine={selected} store={store} value={folder} onChange={value => { setFolder(value); suggestName(value.replace(/[\\/]+$/, "").split(/[\\/]/).at(-1) ?? ""); }} /> : <Field label="Repository (optional)" htmlFor="agent-repository" hint="Leave empty for a new workspace, or enter an HTTPS or SSH Git URL."><input id="agent-repository" autoFocus className="input" maxLength={2048} placeholder="Empty workspace or Git URL" list="recent-repositories" value={repository} onChange={event => {
        const repository = event.target.value; setRepository(repository);
        suggestName(repository.trim() ? repositoryName(repository) : "");
      }} /><datalist id="recent-repositories">{recent.map(value => <option key={value} value={value} />)}</datalist></Field>}
      <div className="form-grid"><Field label="Agent name" htmlFor="agent-name"><input id="agent-name" className="input" required maxLength={64} pattern="[a-zA-Z0-9][a-zA-Z0-9_-]*" placeholder="project" value={name} onChange={event => { editedName.current = true; setName(event.target.value); }} /></Field>
        <Field label="Run on" htmlFor="agent-machine"><select id="agent-machine" className="select" required value={machine} onChange={event => setMachine(event.target.value)}><option value="" disabled>Choose a machine</option>
          {state.control.machines.map(candidate => <option key={candidate.id} value={candidate.id} disabled={!candidate.online || !candidate.harnesses.includes(harness)}>{candidate.name}{!candidate.online ? " — offline" : !candidate.harnesses.includes(harness) ? ` — ${harnessLabel} not installed` : ` · ${candidate.platform}`}</option>)}</select></Field></div>
      {!eligible.length && <div className="mb-5">{state.control.machines.length > 0 && <p className="field-hint mb-3">No connected machine can run {harnessLabel} yet. Bring a machine online, or install {harnessLabel} and restart its worker.</p>}<WorkerSetup state={state} /></div>}
      <span className="field-label" id="harness-label">Harness</span><RadioGroup.Root id="agent-harness" className="harness-picker" value={harness} onValueChange={value => { editedHarness.current = true; setHarness(value as HarnessName); setTerminal(value !== "claude"); }} aria-labelledby="harness-label">{(["omp", "claude", "codex", "pi"] as const).map(name => <RadioGroup.Item key={name} type="button" className="harness-option" value={name}>{name === "omp" ? "oh-my-pi" : name === "claude" ? "Claude" : name === "pi" ? "PI" : "Codex"}</RadioGroup.Item>)}</RadioGroup.Root>
      <div className="form-grid"><Field label="Model" htmlFor="launch-model" hint={catalog.error || modelsError || "Search available models or enter a custom model ID. Leave empty for the harness default."}><input id="launch-model" className="input" name="model" maxLength={256} list="launch-models" value={model} onChange={event => { setModel(event.target.value); setEffort(""); }} placeholder="Harness default" /><datalist id="launch-models">{catalog.models.map(model => <option key={model.id} value={model.id}>{model.label}{model.isDefault ? " (default)" : ""}</option>)}</datalist>
        <Button id="refresh-models" className="mt-2" variant="ghost" disabled={!selected || modelsBusy} onClick={() => { if (!selected) return; const id = selected.id, query = `${id}:${harness}`; setModelsBusy(true); setModelsError(""); void store.refreshModels(id, harness).then(() => store.models(id, harness)).then(value => { if (modelSelection.current === query) setCatalog(value); }).catch(error => { if (modelSelection.current === query) setModelsError(error instanceof Error ? error.message : "Could not refresh models."); }).finally(() => { if (modelSelection.current === query) setModelsBusy(false); }); }}>{modelsBusy && <Spinner />}{modelsBusy ? "Fetching models..." : "Refresh models"}</Button></Field>
        <Field label="Reasoning effort" htmlFor="launch-effort" hint={modelInfo?.defaultEffort ? `Default: ${modelInfo.defaultEffort}` : modelInfo?.efforts?.length === 0 ? "This model does not offer reasoning levels." : undefined}><select id="launch-effort" className="select" name="effort" value={effort} disabled={reasoning.length === 0} onChange={event => setEffort(event.target.value)}><option value="">Harness default</option>{reasoning.map(value => <option key={value}>{value}</option>)}</select></Field></div>
      <Field label="Local terminal" htmlFor="agent-terminal" hint={!native ? "Native Claude control needs Windows or tmux. Background mode supports all web controls." : harness === "claude" ? "Experimental console input. Complete startup/trust prompts locally. Avoid local typing while sending from the web panel. Background mode is more reliable." : selected?.terminal === "window" ? `Opens the normal ${harnessLabel} terminal on ${selected.name}. Uncheck to run in the background.` : selected?.terminal === "tmux" ? `Starts ${harnessLabel} in tmux. The agent output shows the local attach command.` : "Background only. Update the worker or install a terminal launcher to open locally."}><label className="flex items-center gap-2"><input id="agent-terminal" type="checkbox" checked={native && terminal && !!selected?.terminal && selected.terminal !== "none"} disabled={!native || !selected?.terminal || selected.terminal === "none"} onChange={event => setTerminal(event.target.checked)} />Open {harnessLabel} on the machine{harness === "claude" ? " (experimental)" : ""}</label></Field>
      {harness === "claude" && native && terminal && source !== "folder" && selected && <ClaudeTrust key={selected.id} machine={selected} store={store} onBusyChange={setTrustBusy} />}
      {harness === "claude" && native && terminal && source === "folder" && <p className="field-hint mb-4">Claude may ask you to trust this existing folder in its terminal. Trusting Sideband workspaces does not cover folders elsewhere.</p>}
      <Field label="Room" htmlFor="launch-room" hint="Optional. The agent joins this room automatically."><RoomPicker id="launch-room" rooms={allRooms(state)} value={room} onChange={setRoom} /></Field>
      <Field label="What should it work on?" htmlFor="launch-prompt"><textarea id="launch-prompt" className="textarea" name="prompt" rows={3} maxLength={16000} defaultValue={initial?.prompt ?? ""} placeholder="Give it a task, or leave this empty and send instructions later." /></Field>
      <details className="advanced-section"><summary><ChevronRight size={14} />Advanced</summary><Field label="Branch or ref" htmlFor="launch-ref"><input id="launch-ref" className="input" name="ref" maxLength={256} disabled={source === "folder" || !repository.trim()} defaultValue={initial?.ref ?? ""} placeholder={source !== "folder" && repository.trim() ? "Repository default" : "Requires a repository"} /></Field>
        <p className="field-hint">Agents run unattended, using this machine’s existing harness credentials.</p></details>
      <ErrorMessage text={error || state.controlError} id="launch-error" /><div className="form-actions"><Button onClick={close} disabled={busy || trustBusy} variant="ghost">Cancel</Button><Button id="agent-launch" variant="primary" type="submit" disabled={busy || trustBusy || !selected || source === "folder" && (!folder || !selected.folders)}>{busy ? <Spinner /> : <Plus size={15} />}{busy ? "Starting…" : "Launch agent"}</Button></div>
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
function MachineList({ state, store }: { state: WorkspaceState; store: BrowserWorkspace }) {
  return <div className="machine-list">{state.control.machines.map(machine => <div key={machine.id}><div className="machine-card"><Monitor size={17} className="text-zinc-500" /><div className="machine-copy"><strong>{machine.name}</strong><small>{machine.platform} · {machine.harnesses.length ? machine.harnesses.join(", ").toUpperCase() : "No supported harness detected"}</small></div><Status state={machine.online ? "on" : "offline"} label /></div>{machine.harnesses.includes("claude") && <ClaudeTrust machine={machine} store={store} />}</div>)}</div>;
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
      {tab === "machines" && <><MachineList state={state} store={store} /><div className="mt-5"><WorkerSetup state={state} /></div></>}
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
  return <Modal id="agent-action-dialog" returnFocus='button[aria-label="Agent actions"]' open onOpenChange={open => { if (!open && !busy) close(); }} title={mode === "room" ? "Change room" : `${agent.persistent ? "Archive" : agent.online ? "Remove" : "Forget"} ${agent.name}?`} description={mode === "room" ? "The agent leaves its current room and joins the one you choose." : agent.persistent ? "This stops the agent and moves it to Archived. Its workspace and harness session are kept so you can resume it later, including after restarting the machine." : agent.online ? "This stops the agent and removes it from the list. Its checkout and session files stay on the machine. You won’t be able to resume it from this panel afterward." : `This removes the offline entry. It may still be running on ${agent.machineName}; its runner will shut down when it reconnects to this server. Files stay on the machine.`}>
    <form id="agent-room-form" onSubmit={event => {
      event.preventDefault(); if (busy) return; setBusy(true); setError("");
      void (async () => {
        if (mode === "room") await store.action(agent.id, "room", { room: room.trim() });
        else if (agent.persistent) await store.action(agent.id, "archive");
        else { if (agent.online && !["stopped", "failed"].includes(agent.state)) await store.action(agent.id, "stop"); await store.action(agent.id, "dispose"); }
        close();
      })().catch(error => setError(error instanceof Error ? error.message : "Request failed.")).finally(() => setBusy(false));
    }}>
      {mode === "room" && <Field label="Room" htmlFor="agent-room"><RoomPicker id="agent-room" rooms={allRooms(state)} value={room} onChange={setRoom} /></Field>}
      <ErrorMessage text={error} /><div className="form-actions"><Button variant="ghost" onClick={close} disabled={busy}>Cancel</Button><Button id="agent-room-apply" type="submit" variant={mode === "remove" ? "danger" : "primary"} disabled={busy}>{busy && <Spinner />}{mode === "room" ? "Save room" : agent.persistent ? "Archive agent" : agent.online ? "Remove agent" : "Forget agent"}</Button></div>
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
