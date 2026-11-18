import { useState } from "react";
import { Download, RefreshCw } from "lucide-react";
import { Button, ErrorMessage, Spinner } from "./browser-components.js";
import type { BrowserWorkspace, WorkspaceState } from "./browser-workspace.js";
import type { BuildInfo } from "./update-types.js";

const version = (build?: BuildInfo) => build ? `v${build.version}${build.commit ? ` (${build.commit.slice(0, 8)})` : " (bootstrap)"}` : "Version not reported";
export function Updates({ state, store }: { state: WorkspaceState; store: BrowserWorkspace }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const updates = state.control.updates, running = updates?.checking || updates?.phase === "workers" || updates?.phase === "server";
  const request = (start: boolean) => {
    setBusy(true); setError("");
    void store.updateSideband(start).catch(error => setError(error instanceof Error ? error.message : "Update request failed.")).finally(() => setBusy(false));
  };
  return <div id="updates-panel">
    <div className="settings-section"><h3>Sideband updates</h3>
      {updates ? <><p>Server: <span id="update-current">{version(updates.current)}</span></p>{updates.latest && <p className="mt-2">Latest: {version(updates.latest)}</p>}
        <div className="mt-4 flex flex-wrap gap-2"><Button id="updates-check" disabled={busy || running || state.connection !== "on"} onClick={() => request(false)}>{updates.checking ? <Spinner /> : <RefreshCw size={14} />}Check for updates</Button>
          <Button id="updates-install" variant="primary" disabled={busy || running || !updates.latest || !updates.available || state.connection !== "on"} onClick={() => request(true)}>{running && !updates.checking ? <Spinner /> : <Download size={14} />}Update connected machines</Button></div>
        <p id="update-status" className="mt-3 field-hint" role="status">{updates.message}</p></> : <p>Install the latest Sideband CLI manually on the server and workers once to enable automatic updates.</p>}
      <ErrorMessage text={error} />
    </div>
    <div className="settings-section"><h3>Workers</h3><div className="grid gap-3 mt-3">
      {!state.control.machines.length && <p>No workers registered. The server can still update itself.</p>}
      {state.control.machines.map(machine => {
        const row = updates?.workers.find(row => row.id === machine.id);
        return <div className="rounded-lg border border-zinc-700 p-3" key={machine.id}>
          <div className="flex flex-wrap justify-between gap-2"><strong>{machine.name}</strong><span className="text-xs text-zinc-400">{machine.online ? version(machine.build) : "Offline"}</span></div>
          <p className="mt-2 field-hint">{row?.message ?? machine.update?.message ?? (!machine.updater ? "Install the latest worker manually once." : "Ready")}</p>
          {!!machine.update?.plugins.length && <ul className="mt-2 grid gap-2" aria-label={`${machine.name} plugin updates`}>{machine.update.plugins.map(plugin => <li className="text-xs text-zinc-400" key={plugin.harness}><strong className="text-zinc-300">{plugin.harness === "omp" ? "oh-my-pi" : plugin.harness}</strong>: {plugin.state}{plugin.to ? ` (v${plugin.to})` : ""}. {plugin.message}</li>)}</ul>}
        </div>;
      })}</div>
    </div>
    <p className="field-hint mt-4">Workers and their installed Sideband plugins update first; the server follows. Running agents keep their current runtime. Restart existing harness sessions to load refreshed plugins. Plugin managers refresh their configured marketplace branch.</p>
    <p className="field-hint mt-3">The server restart briefly disconnects clients and clears room history. Offline workers are skipped. Previous runtimes stay on disk for running agents.</p>
  </div>;
}
