import type { BrowserRoomClient } from "./browser-protocol.js";
import type { ControlSnapshot, ManagedAgent, OutputEvent, OutputSnapshot } from "./orchestration-protocol.js";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

export function orchestrationPanel(closeMenu: () => void) {
  let client: BrowserRoomClient | undefined, selected = "", generation = 0, refreshing = false, dirty = false;
  let snapshot: ControlSnapshot = { machines: [], agents: [] };
  let launching = false;
  const events = new Map<number, OutputEvent>();
  const fail = (error: unknown) => { $("agent-error").textContent = error instanceof Error ? error.message : "Control request failed."; };
  const input = (id: string) => $<HTMLInputElement>(id).value.trim();
  function show(open: boolean) {
    $("agents-view").hidden = !open; $("chat-main").hidden = open;
    $("agents-open").setAttribute("aria-pressed", String(open));
    if (open) { closeMenu(); document.title = "Agents — Sideband"; void refresh(); }
    else document.title = client?.room ? `${client.room.name} — Sideband` : "Sideband chat";
  }
  function draw() {
    const select = $<HTMLSelectElement>("agent-machine"), previous = select.value;
    select.replaceChildren();
    for (const machine of snapshot.machines.filter(machine => machine.online && machine.harnesses.includes("omp"))) {
      const option = document.createElement("option"); option.value = machine.id; option.textContent = `${machine.name} (${machine.platform})`; select.append(option);
    }
    if ([...select.options].some(option => option.value === previous)) select.value = previous;
    $("machine-summary").textContent = snapshot.machines.length ? snapshot.machines.map(machine => `${machine.name}: ${machine.online ? "online" : "offline"}`).join(" · ") : "No machines connected. Run sideband worker on a machine with OMP installed.";
    $<HTMLButtonElement>("agent-launch").disabled = launching || !select.options.length;
    const list = $("agent-list"); list.replaceChildren();
    for (const agent of snapshot.agents) {
      const button = document.createElement("button"); button.type = "button"; button.dataset.agentId = agent.id;
      button.textContent = `${agent.name} · ${agent.state}${agent.online ? "" : " · offline"} · ${agent.machineName}`;
      if (agent.id === selected) button.setAttribute("aria-current", "true");
      button.addEventListener("click", () => { void watch(agent.id).catch(fail); }); list.append(button);
    }
    const agent = snapshot.agents.find(agent => agent.id === selected);
    $("agent-detail").hidden = !agent;
    if (!agent) return;
    $("agent-title").textContent = `${agent.name} · ${agent.state}${agent.online ? "" : " · offline"}`;
    $("agent-description").textContent = `${agent.harness} on ${agent.machineName} · ${agent.repository}${agent.ref ? ` @ ${agent.ref}` : ""}`;
    $("agent-status").textContent = agent.error ?? (agent.room ? `Assigned room: ${agent.room}` : "No assigned room");
    if (document.activeElement !== $("agent-room")) $<HTMLInputElement>("agent-room").value = agent.room;
    const active = agent.online && ["idle", "busy"].includes(agent.state);
    for (const id of ["agent-prompt", "agent-prompt-send", "agent-interrupt"]) ($<HTMLButtonElement>(id)).disabled = !active;
    $<HTMLButtonElement>("agent-stop").disabled = !agent.online || agent.state === "stopped";
    $<HTMLButtonElement>("agent-resume").disabled = !agent.online || !["stopped", "failed"].includes(agent.state);
    $<HTMLButtonElement>("agent-remove").disabled = !agent.online || !["stopped", "failed"].includes(agent.state);
    $<HTMLButtonElement>("agent-room-apply").disabled = !agent.online;
  }
  async function refresh() {
    if (!client) return;
    if (refreshing) { dirty = true; return; }
    refreshing = true;
    const owner = client;
    try {
      const state = await owner.request<ControlSnapshot>("control.list");
      if (client === owner) {
        if (!snapshot.agents.find(agent => agent.id === selected)?.online && state.agents.find(agent => agent.id === selected)?.online) watched = "";
        snapshot = state; draw();
      }
    }
    catch (error) { if (client === owner && !$("agents-view").hidden) fail(error); }
    finally { refreshing = false; if (dirty) { dirty = false; void refresh(); } }
  }
  function append(batch: OutputEvent[]) {
    const log = $("agent-output"), bottom = log.scrollHeight - log.scrollTop - log.clientHeight < 100;
    for (const event of batch) events.set(event.seq, event);
    const ordered = [...events.values()].sort((a, b) => a.seq - b.seq).slice(-1000);
    events.clear(); for (const event of ordered) events.set(event.seq, event);
    const fragment = document.createDocumentFragment(); let previous: number | undefined, previousKind = "", previousContent: HTMLSpanElement | undefined;
    for (const event of ordered) {
      if ((previous === undefined && event.seq > 1) || (previous !== undefined && event.seq !== previous + 1)) {
        const gap = document.createElement("div"); gap.className = "muted"; gap.textContent = "Earlier output is no longer in the recent buffer."; fragment.append(gap);
        previousContent = undefined;
      }
      if (previousContent && event.kind === previousKind && ["assistant", "thinking"].includes(event.kind)) {
        previousContent.append(event.text); previous = event.seq; continue;
      }
      const entry = document.createElement("div"); entry.className = "agent-output-entry"; entry.dataset.kind = event.kind;
      const meta = document.createElement("span"); meta.className = "muted"; meta.textContent = `${new Date(event.at).toLocaleTimeString()} ${event.kind}\n`;
      const content = document.createElement("span"); content.textContent = event.text; entry.append(meta, content); fragment.append(entry); previous = event.seq; previousKind = event.kind; previousContent = content;
    }
    log.replaceChildren(fragment); if (bottom) log.scrollTop = log.scrollHeight;
  }
  async function watch(id: string) {
    const owner = client; if (!owner) return;
    selected = watched = id; const version = ++generation; events.clear(); $("agent-output").replaceChildren(); $("agent-error").textContent = ""; draw();
    const output = await owner.request<OutputSnapshot>("control.watch", { agentId: id });
    if (client === owner && generation === version) append(output.events);
  }
  async function action(action: string, params: Record<string, unknown> = {}) {
    const owner = client, id = selected; if (!owner || !id) return;
    $("agent-error").textContent = "";
    const result = await owner.request("control.action", { agentId: id, action, ...params });
    if (owner === client) await refresh(); return result;
  }
  $("agents-open").addEventListener("click", () => show(true));
  $("agents-back").addEventListener("click", () => show(false));
  $("agents-menu").addEventListener("click", () => $("menu-toggle").click());
  $("agent-refresh").addEventListener("click", () => { void refresh(); });
  $("agent-launch-form").addEventListener("submit", event => {
    event.preventDefault(); if (!client || launching) return; launching = true;
    const button = $<HTMLButtonElement>("agent-launch"); button.disabled = true; $("agent-error").textContent = "";
    const owner = client, spec: Record<string, unknown> = { machineId: input("agent-machine"), harness: "omp", name: input("agent-name"), repository: input("agent-repository") };
    for (const key of ["ref", "model", "effort", "room", "prompt"]) { const value = input(`launch-${key}`); if (value) spec[key] = value; }
    void owner.request<{ id: string }>("control.launch", spec).then(async result => {
      if (owner !== client) return;
      selected = result.id; events.clear(); $("agent-output").replaceChildren();
      $("agent-launch-details").removeAttribute("open");
      // Registration is asynchronous; control.changed will populate the new agent.
      await refresh(); await watch(selected);
    }).catch(fail).finally(() => { launching = false; if (client === owner) draw(); });
  });
  $("agent-instructions").addEventListener("submit", event => {
    event.preventDefault(); const field = $<HTMLTextAreaElement>("agent-prompt"), text = field.value; if (!text.trim()) return;
    $<HTMLButtonElement>("agent-prompt-send").disabled = true;
    void action("prompt", { text }).then(() => { if (field.value === text) field.value = ""; }).catch(fail).finally(draw);
  });
  for (const [id, operation] of [["agent-interrupt", "interrupt"], ["agent-stop", "stop"], ["agent-resume", "resume"], ["agent-remove", "dispose"]]) $(id!).addEventListener("click", () => {
    const button = $<HTMLButtonElement>(id!); button.disabled = true;
    void action(operation!).catch(fail).finally(draw);
  });
  $("agent-room-form").addEventListener("submit", event => { event.preventDefault(); void action("room", { room: input("agent-room") }).catch(fail); });
  let watched = "";
  return {
    connect(owner: BrowserRoomClient) {
      client = owner; watched = ""; snapshot = { machines: [], agents: [] }; selected = ""; draw();
      owner.onControl = (event, data) => {
        if (client !== owner) return;
        if (event === "control.changed") void refresh().then(() => {
          if (client === owner && selected && selected !== watched && snapshot.agents.some(agent => agent.id === selected && agent.online)) {
            watched = selected; void watch(selected).catch(fail);
          }
        });
        if (event === "control.output" && data.agentId === selected) append(data.events);
      };
      void refresh();
    },
    disconnect() { client = undefined; ++generation; selected = ""; events.clear(); show(false); },
    close() { show(false); },
  };
}
