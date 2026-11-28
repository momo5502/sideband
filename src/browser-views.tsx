import { Fragment, useMemo, useRef, useState } from "react";
import { Activity, ArrowUpRight, Bot, Brain, ChevronRight, Hash, Plus, Search, Settings2, Signal, Users, Wrench, X } from "lucide-react";
import { clsx } from "clsx";
import { BrowserWorkspace, identityColor, identityLabel, type WorkspaceState } from "./browser-workspace.js";
import { Button, Markdown, useLogScroll } from "./browser-components.js";
import type { AgentIdentity, Room } from "./room-protocol.js";
import type { ManagedAgent, OutputEvent } from "./orchestration-protocol.js";

export const allRooms = (state: WorkspaceState) => [...new Map([...state.rooms, ...state.joined].map(room => [room.id, room])).values()];
export const agentStatus = (agent: ManagedAgent) => agent.archived ? "archived" : agent.online ? agent.state : "offline";
export const repositoryName = (repository?: string) => repository ? repository.replace(/\/+$/, "").split(/[/:]/).at(-1)?.replace(/\.git$/, "") ?? "" : "Empty workspace";
export function Avatar({ identity, small = false }: { identity: AgentIdentity; small?: boolean }) {
  return <span className={clsx("avatar", small && "avatar-small")} style={{ color: identityColor(identity) }} aria-hidden="true">{identityLabel(identity).replace(/^#/, "").slice(0, 2).toUpperCase()}</span>;
}
export function Sender({ identity }: { identity: AgentIdentity }) { return <span className="sender" style={{ color: identityColor(identity) }}>{identityLabel(identity)}{identity.name && <small className="ml-1 text-zinc-500" title={identity.id}>#{identity.id.replace(/^agent-/, "").slice(0, 12)}</small>}</span>; }
export function Status({ state, label = false }: { state: string; label?: boolean }) { return label ? <span className="badge badge-state" data-state={state}><span className="status-dot" data-state={state} />{state.charAt(0).toUpperCase() + state.slice(1)}</span> : <span className="status-dot" data-state={state} aria-label={state} />; }
export function Brand() { return <><span className="brand-mark"><Signal size={18} strokeWidth={2} /></span><span>Sideband</span></>; }
const time = (at: number) => new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

export function Sidebar({ store, state, close, onNew, onJoin, onSettings }: { store: BrowserWorkspace; state: WorkspaceState; close(): void; onNew(): void; onJoin(): void; onSettings(): void }) {
  const [search, setSearch] = useState("");
  const build = state.control.updates?.current;
  const query = search.trim().toLowerCase(), agents = state.control.agents.filter(agent => !agent.archived), failed = agents.filter(agent => agent.state === "failed" && !agent.external).length;
  const rooms = allRooms(state).filter(room => room.name.toLowerCase().includes(query)).sort((a, b) => Number(state.joined.some(room => room.id === b.id)) - Number(state.joined.some(room => room.id === a.id)) || a.name.localeCompare(b.name));
  return <aside id="room-menu" className="sidebar" aria-label="Workspace navigation">
    <div className="sidebar-brand"><button className="flex items-center gap-2.5" aria-label="Sideband home" onClick={() => { store.home(); close(); }}><Brand /></button><Button id="menu-close" className="mobile-only ml-auto" variant="ghost" icon aria-label="Close navigation" onClick={close}><X size={18} /></Button></div>
    <label className="sidebar-search"><Search size={14} /><input aria-label="Find rooms" placeholder="Find rooms" value={search} onChange={event => setSearch(event.target.value)} /></label>
    <nav className="sidebar-content">
      <section className="nav-section" aria-label="Rooms"><div className="nav-heading"><span>Rooms</span><Button variant="ghost" icon aria-label="Join or create a room" title="Join or create a room" onClick={onJoin}><Plus size={15} /></Button></div>
        <div id="room-list" className="nav-list">{rooms.map(room => {
          const joined = state.joined.some(candidate => candidate.id === room.id), mentions = state.mentions[room.id] ?? 0, unread = state.unread[room.id] ?? 0;
          return <button key={room.id} type="button" className="nav-row" data-room-id={room.id} data-joined={String(joined)} aria-current={state.view.kind === "room" && state.view.id === room.id ? "true" : undefined}
            title={joined ? "Joined · open conversation" : "Join this room"} onClick={() => { close(); void store.openRoom(room.id).catch(() => {}); }}>
            <span className="nav-icon"><Hash size={17} /></span><span className="row-copy"><span className="row-name room-label">{room.name}</span></span>
            {!joined && <span className="nav-join-label">Join</span>}{unread > 0 && <span className="unread-badge" aria-label={`${unread} unread messages`}>{unread > 99 ? "99+" : unread}</span>}
            <span className="mention-badge" hidden={!mentions} aria-label={`${mentions} unread ${mentions === 1 ? "mention" : "mentions"}`}>@{mentions > 99 ? "99+" : mentions}</span>
          </button>;
        })}</div>
        {!rooms.length && <p className="nav-empty">{query ? "No matching rooms." : "Join a room to talk with people and agents."}</p>}
        <Button variant="ghost" className="nav-add" onClick={onJoin}><Plus size={13} />Join or create room</Button>
      </section>
      <section className="agents-navigation" aria-label="Agents">
        <button id="agents-open" type="button" className="nav-row" aria-current={state.view.kind === "agents" || state.view.kind === "agent" ? "true" : undefined} title={failed ? `${failed} agents failed` : "Browse all agents"} onClick={() => { store.showAgents(); close(); }}>
          <span className="nav-icon"><Bot size={18} />{failed > 0 && <Status state="failed" />}</span><span className="row-copy"><span className="row-name">Agents</span></span><span className="agent-count">{agents.length}</span>
        </button>
        <Button id="new-agent" variant="ghost" icon aria-label="New agent" title="New agent" onClick={onNew}><Plus size={16} /></Button>
      </section>
    </nav>
    <div className="sidebar-footer"><div className="user-row">{state.identity && <Avatar identity={state.identity} small />}<div className="user-copy"><strong>{state.identity ? identityLabel(state.identity) : "Connecting"}</strong>
      <span id="connection" className="connection-label"><Status state={state.connection} />{state.connection === "on" ? "Connected" : "Reconnecting…"}</span></div>
      <Button id="settings-open" variant="ghost" icon aria-label="Settings" title="Settings" onClick={onSettings}><Settings2 size={17} /></Button></div>
      {build && <p id="server-version" className="px-1.5 pt-2 text-[10px] text-zinc-500" title={build.commit ? `Server commit ${build.commit}` : "Commit available after a managed update."}>Server v{build.version}{build.commit && ` · ${build.commit.slice(0, 8)}`}</p>}</div>
  </aside>;
}

export type AgentFilters = { search: string; machine: string; kind: "all" | "managed" | "external"; archivedOpen: boolean };
export function AgentDirectory({ store, state, filters, setFilters }: { store: BrowserWorkspace; state: WorkspaceState; filters: AgentFilters; setFilters(value: AgentFilters): void }) {
  const { search, machine, kind } = filters, query = search.trim().toLowerCase();
  const matches = state.control.agents.filter(agent => (!machine || agent.machineId === machine) && (kind === "all" || (kind === "external") === !!agent.external) &&
    `${agent.name} ${agent.machineName} ${agent.harness} ${agent.folder ?? agent.external?.workspace ?? repositoryName(agent.repository)} ${agent.room ?? ""} ${agentStatus(agent)}`.toLowerCase().includes(query));
  const sorted = (agents: ManagedAgent[]) => agents.sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }) || a.id.localeCompare(b.id));
  const agents = sorted(matches.filter(agent => !agent.archived)), archived = sorted(matches.filter(agent => agent.archived));
  const machines = [...new Map([...state.control.machines.map(value => [value.id, value.name] as const), ...state.control.agents.map(value => [value.machineId, value.machineName] as const)]).entries()].sort((a, b) => a[1].localeCompare(b[1]));
  const rows = (values: ManagedAgent[]) => values.map(agent => <button key={agent.id} type="button" data-agent-id={agent.id} className="agent-card" onClick={() => { void store.selectAgent(agent.id).catch(() => {}); }} aria-label={`${agent.name}, ${agentStatus(agent)}, ${agent.machineName}`}>
    <span className="agent-card-icon"><Bot size={20} /></span><span className="agent-card-copy"><span className="agent-card-title"><strong>{agent.name}{state.control.agents.some(other => other.id !== agent.id && other.name.toLowerCase() === agent.name.toLowerCase()) && <small className="ml-1 text-zinc-500" title={agent.identityId ?? agent.id}>#{(agent.identityId ?? agent.id).replace(/^agent-/, "").slice(0, 8)}</small>}</strong><span className="badge">{agent.harness === "omp" ? "OMP" : agent.harness === "pi" ? "PI" : agent.harness === "codex" ? "Codex" : "Claude"}</span>{agent.external && <span className="agent-origin">External</span>}</span>
      <span className="agent-card-meta">{agent.machineName}<span aria-hidden="true"> · </span>{agent.folder ?? agent.external?.workspace ?? repositoryName(agent.repository)}{agent.room && <span> · #{agent.room}</span>}</span></span>
    <Status state={agentStatus(agent)} label /><ChevronRight size={16} className="agent-card-arrow" />
  </button>);
  return <section id="agents-page" className="agents-page" aria-label="All agents">
    <div className="agents-toolbar"><label className="agents-search"><Search size={16} /><input id="agents-search" aria-label="Search agents" placeholder="Search agents, machines or harnesses" value={search} onChange={event => setFilters({ ...filters, search: event.target.value })} /></label>
      <select id="agents-machine" className="select" aria-label="Filter agents by machine" value={machine} onChange={event => setFilters({ ...filters, machine: event.target.value })}><option value="">All machines</option>{machines.map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select>
    </div>
    <div className="agents-list-heading"><div className="agents-type-filter" role="group" aria-label="Agent types">{(["all", "managed", "external"] as const).map(value => <Button key={value} variant="ghost" aria-pressed={kind === value} onClick={() => setFilters({ ...filters, kind: value })}>{value === "all" ? "All agents" : value === "managed" ? "Managed" : "External"}</Button>)}</div><span className="agents-result-count">{agents.length} agent{agents.length === 1 ? "" : "s"}</span></div>
    {state.controlError && <div className="inline-error" role="alert">{state.controlError}<Button variant="ghost" disabled={state.connection !== "on"} onClick={() => { void store.refreshControl(); }}>Retry</Button></div>}
    <div id="agent-list" className="agents-list">{rows(agents)}</div>
    {!agents.length && <div className="agents-empty"><Bot size={26} /><h2>{query || machine || kind !== "all" ? "No matching agents" : "No active agents"}</h2><p>{query || machine || kind !== "all" ? "Try a different search or filter." : archived.length ? "Your saved sessions are in Archived below." : "Start an agent on a connected machine. Sessions with the Sideband plugin also appear here."}</p>{(query || machine || kind !== "all") && <Button onClick={() => setFilters({ ...filters, search: "", machine: "", kind: "all" })}>Clear filters</Button>}</div>}
    {archived.length > 0 && <details id="archived-agents" className="agents-archived" open={filters.archivedOpen}><summary onClick={event => { event.preventDefault(); setFilters({ ...filters, archivedOpen: !filters.archivedOpen }); }}>Archived <span>{archived.length}</span></summary><div className="agents-list">{rows(archived)}</div></details>}
  </section>;
}

export function RoomMessages({ state, room }: { state: WorkspaceState; room: Room }) {
  const ref = useRef<HTMLDivElement>(null), messages = state.messages[room.id] ?? [];
  const scroll = useLogScroll(ref, room.id, messages.at(-1)?.id ?? "");
  return <div className="log-wrapper"><div id="messages" ref={ref} onScroll={scroll.onScroll} className="chat-log" role="log" aria-label="Chat messages">
    {!messages.length && <div className="empty-view h-full"><div className="empty-icon"><Hash size={26} /></div><h2>This is the start of #{room.name}</h2><p>Messages here are shared with everyone in this room.</p></div>}
    {messages.map((item, index) => {
      const previous = messages[index - 1], day = new Date(item.createdAt).toLocaleDateString(), newDay = !previous || new Date(previous.createdAt).toLocaleDateString() !== day;
      const grouped = !newDay && !("kind" in item) && previous && !("kind" in previous) && previous.sender.id === item.sender.id && item.createdAt - previous.createdAt < 5 * 60_000;
      return <Fragment key={item.id}>{newDay && <div className="date-divider">{new Date(item.createdAt).toLocaleDateString(undefined, { month: "long", day: "numeric" })}</div>}
        {"kind" in item ? <div className="presence-event">{item.rename ? <span>{item.rename.kind === "room" ? `Room #${item.rename.oldName} was renamed to #${item.rename.newName}` : `${item.rename.oldName} is now ${item.rename.newName}`}<small className="ml-1 text-zinc-500" title={item.rename.id}>#{item.rename.id.replace(/^agent-/, "").slice(0, 12)}</small></span> : <><Sender identity={item.participant} /><span>{item.kind === "joined" ? "joined the room" : item.kind === "left" ? "left the room" : item.kind === "reconnected" ? "reconnected" : "disconnected"}</span></>}</div> :
          <article className={clsx("message", grouped && "message-continuation")}>{grouped ? <span className="avatar-space" /> : <Avatar identity={item.sender} />}<div className="message-copy">
            {!grouped && <div className="message-meta"><Sender identity={item.sender} /><time className="message-time" dateTime={new Date(item.createdAt).toISOString()}>{time(item.createdAt)}</time></div>}
            <Markdown className="message-body" text={item.text} /></div></article>}
      </Fragment>;
    })}
  </div>{scroll.jump}</div>;
}
type OutputGroup = { kind: string; text: string; seq: number; last: number; at: number };
function outputGroups(events: OutputEvent[]): OutputGroup[] {
  const groups: OutputGroup[] = [];
  for (const event of events) {
    const previous = groups.at(-1);
    if (previous && previous.kind === event.kind && previous.last + 1 === event.seq && ["assistant", "thinking", "tool-output", "git", "stderr"].includes(event.kind)) { previous.text += event.text; previous.last = event.seq; }
    else groups.push({ ...event, last: event.seq });
  }
  return groups;
}
const decodeEnvelope = (text: string) => text.replace(/&(?:amp|lt|gt|quot|apos);/g, value => ({ "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'" })[value]!);
export function AgentOutput({ state, agent }: { state: WorkspaceState; agent: ManagedAgent }) {
  const [thinking, setThinking] = useState(false), [tools, setTools] = useState(false);
  const ref = useRef<HTMLDivElement>(null), events = state.outputAgent === agent.id ? state.output : [];
  const scroll = useLogScroll(ref, agent.id, String(events.at(-1)?.seq ?? ""), "New output");
  const groups = useMemo(() => outputGroups(events), [events]);
  return <><div className="log-toolbar"><span className="log-toolbar-label">{state.loading ? "Loading recent output…" : agent.external ? "Live activity · Earlier history stays in the terminal" : "Conversation & activity"}</span><div className="flex gap-1">
    <Button variant="ghost" className="toolbar-toggle" aria-pressed={thinking} onClick={() => setThinking(!thinking)}><Brain size={13} />Thinking</Button>
    <Button variant="ghost" className="toolbar-toggle" aria-pressed={tools} onClick={() => setTools(!tools)}><Wrench size={13} />Tools</Button></div></div>
    <div className="log-wrapper"><div id="agent-output" ref={ref} onScroll={scroll.onScroll} className="output-log" role="log" aria-label="Agent conversation">
      {events[0] && events[0].seq > 1 && <p className="output-gap">Showing recent output. Earlier output has left the buffer.</p>}
      {!events.length && <div className="empty-view h-full"><div className="empty-icon"><Bot size={26} /></div><h2>{agent.archived ? "Agent archived" : !agent.online && agent.persistent ? "Saved session" : !agent.online ? "Agent offline" : agent.state === "failed" ? "The agent couldn’t start" : agent.state === "stopped" ? "Agent stopped" : agent.state === "preparing" ? "Preparing workspace" : agent.state === "starting" ? "Starting the agent" : "Ready when you are"}</h2><p>{agent.persistent && !agent.online ? "The workspace and harness history are kept on its machine. Bring that machine online and choose Resume to continue." : !agent.online ? "Its machine or runner is disconnected. It will return here when it reconnects." : agent.state === "failed" ? "Check the error above. You can remove this agent and launch a new one." : agent.state === "stopped" ? "Resume to continue with the same workspace and history." : agent.state === "preparing" ? (agent.folder ? "Opening the existing folder on your selected machine." : agent.repository ? "Cloning the repository on your selected machine. Progress will appear here." : "Creating an empty workspace on your selected machine.") : "Send private instructions below, or talk to this agent in its room."}</p></div>}
      {groups.map(group => {
        const { kind, text } = group;
        if (["assistant", "user", "room"].includes(kind)) {
          const envelope = kind === "room" ? /^<sideband sender="([^"]+)">\n([\s\S]*)\n<\/sideband>$/.exec(text) : null;
          if (kind === "room" && !envelope) return <div key={group.seq} className="output-state"><Users size={12} />{decodeEnvelope(text.replace(/^<sideband event="([^"]+)" participant="([^"]+)" \/>$/, "$2 $1"))}</div>;
          return <article key={group.seq} className="agent-bubble" data-kind={kind}><div className="message-meta"><span className="sender">{kind === "user" ? "You" : envelope ? decodeEnvelope(envelope[1]!) : agent.name}</span>
            {kind === "user" && <span className="badge">Private</span>}{kind === "room" && <span className="badge"><Hash size={9} />Room</span>}<time className="message-time">{time(group.at)}</time></div><Markdown text={envelope ? decodeEnvelope(envelope[2]!) : text} /></article>;
        }
        if (kind === "error" || kind === "stderr") return <div key={group.seq} className="output-error">{text}</div>;
        if (kind === "state") return <div key={group.seq} className="output-state"><Status state={text.split(":")[0]!} />{text}</div>;
        if (kind === "tool-output" && !tools) return null;
        const heading = kind === "thinking" ? "Thinking" : kind === "tool" ? text.split("\n")[0] : kind === "tool-output" ? "Tool output" : kind === "git" ? "Repository activity" : kind.replace(/_/g, " ");
        return <details key={group.seq} className="activity-entry" data-kind={kind} open={kind === "thinking" ? thinking : kind === "tool-output" ? tools : undefined}>
          <summary>{kind === "thinking" ? <Brain size={13} /> : kind.startsWith("tool") ? <Wrench size={13} /> : kind === "git" ? <Hash size={13} /> : <Activity size={13} />}<span>{heading}</span><ChevronRight size={12} className="ml-auto" /></summary><pre>{text}</pre></details>;
      })}
    </div>{scroll.jump}</div></>;
}
export function DiscoveredAgentView({ agent }: { agent: ManagedAgent }) {
  return <div className="empty-view h-full" id="external-agent"><div className="empty-icon"><Bot size={26} /></div><h2>Started in your harness</h2><p>Sideband found this running session through its installed plugin. Use its terminal to interact with it.</p><span className="workspace-summary">{agent.machineName}{agent.external?.workspace ? ` / ${agent.external.workspace}` : ""}</span></div>;
}
export function AgentDetails({ agent }: { agent: ManagedAgent }) {
  if (agent.external) return <><h2>Agent details</h2><dl className="detail-grid"><div><dt>Machine</dt><dd>{agent.machineName}</dd></div><div><dt>Harness</dt><dd>{agent.harness}</dd></div><div><dt>Session</dt><dd>Started outside Sideband</dd></div>{agent.external.workspace && <div><dt>Workspace</dt><dd>{agent.external.workspace}</dd></div>}<div><dt>Plugin process</dt><dd>{agent.external.pid}</dd></div></dl></>;
  return <><h2>Agent details</h2><dl className="detail-grid"><div><dt>Machine</dt><dd>{agent.machineName}</dd></div><div><dt>Repository</dt><dd>{agent.repository ?? (agent.folder ? "None (existing folder)" : "None (empty workspace)")}</dd></div>{agent.ref && <div><dt>Branch or ref</dt><dd>{agent.ref}</dd></div>}<div><dt>Harness</dt><dd>{({ omp: "oh-my-pi", codex: "Codex", claude: "Claude", pi: "PI" })[agent.harness]}</dd></div><div><dt>Model</dt><dd>{agent.model ?? "Harness default"}</dd></div><div><dt>Reasoning</dt><dd>{agent.effort ?? "Harness default"}</dd></div><div><dt>Workspace</dt><dd>{agent.folder ? `${agent.folder} (used in place; files are retained)` : "Isolated workspace. Stop and resume retain its files and history."}</dd></div></dl></>;
}
export function MemberList({ state, openAgent }: { state: WorkspaceState; openAgent(id: string): void }) {
  return <><h2>Participants · {state.members.length}</h2>{state.members.map(identity => {
    const managed = state.control.agents.find(agent => agent.identityId === identity.id && agent.online);
    const body = <><Avatar identity={identity} small /><span className="min-w-0"><Sender identity={identity} /><span className="member-kind block">{identity.id === state.identity?.id ? "You" : managed ? `Agent · ${managed.machineName}` : "Participant"}</span></span>{managed && <ArrowUpRight size={12} className="ml-auto text-zinc-500" />}</>;
    return managed ? <button key={identity.id} className="member-row" onClick={() => openAgent(managed.id)}>{body}</button> : <div className="member-row" key={identity.id}>{body}</div>;
  })}</>;
}
