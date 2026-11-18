export type BuildInfo = { version: string; commit?: string };
export type PluginUpdate = { harness: "codex" | "claude" | "omp"; state: "updated" | "skipped" | "failed"; from?: string; to?: string; message: string; restartRequired?: boolean };
export type LocalUpdate = { target?: string; attempt?: string; phase: "idle" | "installing" | "plugins" | "restarting" | "done" | "failed"; message: string; plugins: PluginUpdate[]; at: number };
export type LatestBuild = BuildInfo & { commit: string };
export type FleetUpdates = { current: BuildInfo; latest?: LatestBuild; checking: boolean; available: boolean;
  phase: "idle" | "workers" | "server" | "done" | "failed"; message: string; workers: { id: string; name: string; state: string; message: string }[] };
export const validCommit = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{40}$/.test(value);
export function parseBuild(value: any): BuildInfo {
  if (!value || typeof value.version !== "string" || value.version.length > 128 || (value.commit !== undefined && !validCommit(value.commit))) throw new Error("Invalid build information.");
  return { version: value.version, ...(value.commit ? { commit: value.commit } : {}) };
}
export function parseUpdate(value: any): LocalUpdate {
  if (!value || !["idle", "installing", "plugins", "restarting", "done", "failed"].includes(value.phase) || typeof value.message !== "string" || value.message.length > 2048 ||
    !Number.isFinite(value.at) || (value.attempt !== undefined && (typeof value.attempt !== "string" || !/^[a-f0-9-]{36}$/.test(value.attempt))) || (value.target !== undefined && !validCommit(value.target)) || !Array.isArray(value.plugins) || value.plugins.length > 3) throw new Error("Invalid update status.");
  const plugins = value.plugins.map((plugin: any) => {
    if (!["codex", "claude", "omp"].includes(plugin.harness) || !["updated", "skipped", "failed"].includes(plugin.state) || typeof plugin.message !== "string" || plugin.message.length > 2048) throw new Error("Invalid plugin update status.");
    return { harness: plugin.harness, state: plugin.state, message: plugin.message, ...(typeof plugin.from === "string" ? { from: plugin.from.slice(0, 128) } : {}), ...(typeof plugin.to === "string" ? { to: plugin.to.slice(0, 128) } : {}), restartRequired: plugin.restartRequired === true };
  });
  return { phase: value.phase, message: value.message, at: value.at, plugins, ...(value.attempt ? { attempt: value.attempt } : {}), ...(value.target ? { target: value.target } : {}) };
}
