import { useEffect, useState, useSyncExternalStore } from "react";
import * as Dropdown from "@radix-ui/react-dropdown-menu";
import { Bot, CirclePause, CircleStop, DoorOpen, Hash, Info, LockKeyhole, Menu as MenuIcon, Play, Plus, Signal, SquareTerminal, Trash2, Users, X } from "lucide-react";
import { BrowserWorkspace } from "./browser-workspace.js";
import { Button, Composer, Menu, MenuItem, Modal, Spinner } from "./browser-components.js";
import { AgentDetails, AgentOutput, allRooms, agentStatus, MemberList, repositoryName, RoomMessages, Sidebar, Status } from "./browser-views.js";
import { AgentActionDialog, JoinRoom, Login, NewAgent, Settings } from "./browser-dialogs.js";
import type { ManagedAgent } from "./orchestration-protocol.js";

function useMobile(query: string) {
  const [mobile, setMobile] = useState(() => window.matchMedia?.(query).matches ?? false);
  useEffect(() => { const media = window.matchMedia?.(query); if (!media) return; const change = () => setMobile(media.matches); media.addEventListener("change", change); return () => media.removeEventListener("change", change); }, [query]);
  return mobile;
}
export function App({ store }: { store: BrowserWorkspace }) {
  const state = useSyncExternalStore(store.subscribe, store.snapshot), mobile = useMobile("(max-width:700px)"), narrow = useMobile("(max-width:1100px)");
  const [navigation, setNavigation] = useState(false), [dialog, setDialog] = useState<"new" | "join" | "settings" | null>(null), [details, setDetails] = useState(false), [actionDialog, setActionDialog] = useState<"room" | "remove" | null>(null), [actionBusy, setActionBusy] = useState(false), [actionError, setActionError] = useState("");
  const [launchTemplate, setLaunchTemplate] = useState<ManagedAgent | undefined>();
  const view = state.view, room = view.kind === "room" ? allRooms(state).find(room => room.id === view.id) : undefined, agent = view.kind === "agent" ? state.control.agents.find(agent => agent.id === view.id) : undefined;
  useEffect(() => { store.start(); }, [store]);
  useEffect(() => {
    if (!state.serverUpdate?.automatic || state.connection !== "on" || state.loading || actionBusy) return;
    const timer = window.setInterval(() => {
      // Keep unsaved launch/settings forms and in-flight messages intact. The Updates
      // panel has no editable form, so it may refresh as soon as the rollout returns.
      if ([...document.querySelectorAll('[role="dialog"]')].some(dialog => !dialog.querySelector("#updates-panel")) || document.querySelector('[data-sending="true"]')) return;
      store.reloadUpdated();
    }, 2000);
    return () => window.clearInterval(timer);
  }, [store, state.serverUpdate?.build, state.serverUpdate?.automatic, state.connection, state.loading, actionBusy]);
  const mentionCount = Object.values(state.mentions).reduce((sum, count) => sum + count, 0);
  useEffect(() => { document.title = `${mentionCount ? `(${mentionCount}) ` : ""}${room?.name ?? agent?.name ?? "Sideband"}${room || agent ? " — Sideband" : ""}`; }, [room?.name, agent?.name, mentionCount]);
  useEffect(() => { setActionError(""); setActionDialog(null); setDetails(false); }, [view.kind, view.kind === "home" ? "" : view.id]);
  const openDialog = (value: "new" | "join" | "settings") => { setNavigation(false); setLaunchTemplate(undefined); setDialog(value); };
  const openAgent = (id: string) => { setDetails(false); void store.selectAgent(id).catch(() => {}); };
  if (state.connection === "off" || state.connection === "connecting") return <Login store={store} state={state} />;
  const nav = <Sidebar store={store} state={state} close={() => setNavigation(false)} onNew={() => openDialog("new")} onJoin={() => openDialog("join")} onSettings={() => openDialog("settings")} />;
  const perform = (action: string) => {
    if (!agent || actionBusy) return; setActionBusy(true); setActionError("");
    void store.action(agent.id, action).catch(error => setActionError(error instanceof Error ? error.message : "Action failed.")).finally(() => setActionBusy(false));
  };
  const recoverable = !!agent?.persistent && state.control.machines.some(machine => machine.id === agent.machineId && machine.online);
  const primary = agent ? agent.state === "busy" ? { action: "interrupt", label: "Interrupt", icon: <CirclePause size={14} /> } : ["stopped", "failed"].includes(agent.state) && agent.canResume !== false ? { action: "resume", label: "Resume", icon: <Play size={14} /> } : undefined : undefined;
  return <section id="app" className="app-shell">{!mobile && <div className="desktop-sidebar">{nav}</div>}
    {mobile && <Modal id="navigation-dialog" className="mobile-sheet" open={navigation} onOpenChange={setNavigation} title="Workspace navigation">{nav}</Modal>}
    <div className="workspace-main"><header className="pane-header"><div className="pane-title-group"><Button id="menu-toggle" className="mobile-only" variant="ghost" icon aria-label="Open navigation" aria-expanded={navigation} onClick={() => setNavigation(true)}><MenuIcon size={20} /></Button>
      {room ? <Hash size={21} className="pane-icon" /> : agent ? <Bot size={22} className="pane-icon" /> : <Signal size={21} className="pane-icon" />}
      <div className="min-w-0"><div className="pane-heading"><h1 id={room ? "room-title" : agent ? "agent-title" : "workspace-title"}>{room?.name ?? agent?.name ?? "Workspace"}</h1>{agent && <Status state={agentStatus(agent)} label />}</div>
        <div className="pane-subtitle">{room ? `${state.members.length || room.members} participants · Shared room` : agent ? <>{agent.machineName} · {agent.folder ?? repositoryName(agent.repository)}{agent.ref ? ` @ ${agent.ref}` : ""}{agent.room && <button className="room-chip" onClick={() => { void store.openRoom(agent.room).catch(() => {}); }}><Hash size={10} /><span className="room-chip-label">{agent.room}</span></button>}</> : "Your people, agents and projects"}</div></div></div>
      <div className="header-actions">{room && <><Button aria-label="Room members" title="Room members" variant="ghost" onClick={() => { setDetails(!details); void store.refreshMembers(); }}><Users size={16} /><span>{state.members.length || room.members}</span></Button><Menu label="Room actions"><MenuItem onSelect={() => { void store.leaveRoom().catch(() => {}); }}><DoorOpen size={14} />Leave room</MenuItem></Menu></>}
        {agent && <>{primary && <Button id={`agent-${primary.action}`} disabled={(!agent.online && !(primary.action === "resume" && recoverable)) || actionBusy || state.connection !== "on"} onClick={() => perform(primary.action)}>{actionBusy ? <Spinner size={14} /> : primary.icon}{primary.label}</Button>}
          {agent.state === "failed" && agent.canResume === false && <Button disabled={state.connection !== "on"} onClick={() => { setLaunchTemplate({ ...agent, ...store.launchSpecs.get(agent.id) }); setDialog("new"); }}><Plus size={14} />Launch again…</Button>}
          <Button variant="ghost" icon aria-label="Agent details" onClick={() => setDetails(!details)}><Info size={17} /></Button><Menu label="Agent actions"><MenuItem defer disabled={!agent.online || state.connection !== "on"} onSelect={() => setActionDialog("room")}><Hash size={14} />Change room…</MenuItem>
            {!["stopped", "failed"].includes(agent.state) && <MenuItem disabled={!agent.online || actionBusy} onSelect={() => perform("stop")}><CircleStop size={14} />Stop agent</MenuItem>}
            <Dropdown.Separator className="dropdown-separator" /><MenuItem defer danger disabled={state.connection !== "on" || agent.archived} onSelect={() => setActionDialog("remove")}><Trash2 size={14} />{agent.persistent ? "Archive agent…" : agent.online ? "Remove agent…" : "Forget agent…"}</MenuItem></Menu></>}
        {!room && !agent && <Button onClick={() => openDialog("new")}><Plus size={14} /><span className="header-label">New agent</span></Button>}
      </div></header>
      {state.connection === "reconnecting" && <div className="connection-banner" role="status"><Spinner size={13} />Reconnecting… Your session and drafts are kept.</div>}
      {state.serverUpdate && <div id="server-update-banner" className="connection-banner flex items-center justify-between gap-3" role="status"><span>Sideband was updated. {state.serverUpdate.automatic ? "Refreshing when you finish editing; drafts are kept." : "Reload to load the latest interface."}</span><Button onClick={() => store.reloadUpdated(true)}>Reload now</Button></div>}
      {agent?.error && <div className="pane-error" role="status">{agent.error}</div>}
      {state.error && <div className="pane-error flex items-center justify-between gap-3" role="alert"><span>{state.error}</span><Button variant="ghost" icon aria-label="Dismiss error" onClick={() => store.clearError()}><X size={14} /></Button></div>}
      {actionError && <div className="pane-error flex items-center justify-between gap-3" role="alert"><span>{actionError}</span><Button variant="ghost" icon aria-label="Dismiss action error" onClick={() => setActionError("")}><X size={14} /></Button></div>}
      <div className="pane-layout"><main className="workspace-main" aria-label={room ? `Room ${room.name}` : agent ? `Agent ${agent.name}` : "Workspace"}>
        {room ? <><RoomMessages state={state} room={room} /><Composer key={`room:${room.id}`} id="message" room placeholder={`Message #${room.name}`} disabled={state.connection !== "on" || state.loading} onSend={text => store.sendRoom(room.id, text)} drafts={store.drafts} draftKey={`room:${room.id}`} context={<><Hash size={10} />Shared with everyone in this room</>} /></> :
          agent ? <><AgentOutput key={agent.id} state={state} agent={agent} /><Composer key={`agent:${agent.id}`} id="agent-prompt" placeholder={agent.state === "preparing" || agent.state === "starting" ? "Available once the agent is ready…" : agent.archived ? "Resume the archived agent to send instructions" : !agent.online && recoverable ? "Resume the saved session to send instructions" : !agent.online ? "Agent offline — reconnect to send instructions" : agent.state === "stopped" ? "Resume the agent to send instructions" : `Message ${agent.name} privately…`} disabled={state.connection !== "on" || !agent.online || !["idle", "busy"].includes(agent.state)} onSend={text => store.action(agent.id, "prompt", { text })} drafts={store.drafts} draftKey={`agent:${agent.id}`} context={<><LockKeyhole size={10} />Private instructions{agent.room ? ` · Not sent to #${agent.room}` : " · Not posted to a room"}</>} /></> :
          <div className="empty-view"><div className="empty-icon"><SquareTerminal size={28} /></div><h1>Your agents, in one place.</h1><p>Start an agent on a connected machine, or join a room to work together.</p><div className="home-actions"><Button variant="primary" onClick={() => openDialog("new")}><Plus size={15} />New agent</Button><Button onClick={() => openDialog("join")}><Hash size={15} />Join a room</Button></div><span className="workspace-summary">{state.control.machines.filter(machine => machine.online).length} machines online · {state.control.agents.length} agents · {state.joined.length} rooms joined</span></div>}
      </main>{details && !narrow && <aside className="member-panel">{agent ? <AgentDetails agent={agent} /> : <MemberList state={state} openAgent={openAgent} />}</aside>}</div>
    </div>
    {details && narrow && <Modal id="details-dialog" open onOpenChange={setDetails} title={agent ? "Agent details" : "Room members"}>{agent ? <AgentDetails agent={agent} /> : <MemberList state={state} openAgent={openAgent} />}</Modal>}
    {dialog === "new" && <NewAgent state={state} store={store} initial={launchTemplate} close={() => setDialog(null)} />}{dialog === "join" && <JoinRoom state={state} store={store} close={() => setDialog(null)} />}{dialog === "settings" && <Settings state={state} store={store} close={() => setDialog(null)} />}
    {agent && actionDialog && <AgentActionDialog mode={actionDialog} agent={agent} state={state} store={store} close={() => setActionDialog(null)} />}
  </section>;
}
