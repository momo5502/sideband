import { agentName, fields, text } from "./room-protocol.js";
import type { BuildInfo, LocalUpdate, FleetUpdates } from "./update-types.js";

export type HarnessModel = { id: string; label: string; efforts?: string[]; defaultEffort?: string; isDefault?: boolean };
export type ModelCatalog = { models: HarnessModel[]; at: number; error?: string };
export type Machine = { id: string; name: string; platform: string; harnesses: string[]; online: boolean; persistent?: boolean; terminal?: "window" | "tmux" | "none"; build?: BuildInfo; updater?: boolean; update?: LocalUpdate; models?: Partial<Record<HarnessName, ModelCatalog>> };
export type AgentState = "preparing" | "starting" | "idle" | "busy" | "stopped" | "failed";
export type HarnessName = "omp" | "codex" | "claude";
export type LaunchSpec = { name: string; harness: HarnessName; repository?: string; ref?: string; model?: string; effort?: string; room?: string; prompt?: string; terminal?: boolean };
export type ManagedAgent = LaunchSpec & { id: string; machineId: string; machineName: string; state: AgentState; online: boolean; createdAt: number; room: string; error?: string; canResume?: boolean; identityId?: string; persistent?: boolean; archived?: boolean };
export type OutputEvent = { seq: number; at: number; kind: string; text: string };
export type OutputSnapshot = { events: OutputEvent[]; first: number; next: number };
export type ControlCommand = { id: string; method: string; params: Record<string, unknown> };
export type ControlSnapshot = { machines: Machine[]; agents: ManagedAgent[]; serverPort?: number; updates?: FleetUpdates };

export function modelCatalog(input: unknown): ModelCatalog {
  const value = fields(input, ["models", "at", "error"]);
  if (!Number.isFinite(value.at) || !Array.isArray(value.models) || value.models.length > 1000) throw new Error("Invalid model catalog.");
  if (Buffer.byteLength(JSON.stringify(value)) > 200 * 1024) throw new Error("Model catalog exceeded its size limit.");
  const levels = ["off", "minimal", "low", "medium", "high", "xhigh", "max", "auto", "ultra"];
  const models = value.models.map(row => {
    const v = fields(row, ["id", "label", "efforts", "defaultEffort", "isDefault"]);
    const id = text(v.id, "model ID", 256), label = text(v.label, "model label", 128);
    if (/[\x00-\x1f]/.test(id + label)) throw new Error("Invalid model text.");
    if (v.efforts !== undefined && (!Array.isArray(v.efforts) || v.efforts.length > levels.length || v.efforts.some(e => !levels.includes(e)))) throw new Error("Invalid model reasoning levels.");
    if (v.defaultEffort !== undefined && !levels.includes(v.defaultEffort as string)) throw new Error("Invalid default reasoning level.");
    if (v.isDefault !== undefined && typeof v.isDefault !== "boolean") throw new Error("Invalid default model flag.");
    return { id, label, ...(v.efforts !== undefined ? { efforts: v.efforts as string[] } : {}), ...(v.defaultEffort ? { defaultEffort: v.defaultEffort as string } : {}), ...(v.isDefault !== undefined ? { isDefault: v.isDefault as boolean } : {}) };
  });
  return { models, at: value.at as number, ...(value.error ? { error: text(value.error, "model discovery error", 512) } : {}) };
}

export function launchSpec(input: unknown): LaunchSpec {
  const value = fields(input, ["name", "harness", "repository", "ref", "model", "effort", "room", "prompt", "terminal"]);
  const name = agentName(value.name); if (!name) throw new Error("Choose an agent name.");
  if (!["omp", "codex", "claude"].includes(value.harness as string)) throw new Error("Choose OMP, Codex or Claude.");
  const repository = value.repository === undefined || value.repository === "" ? undefined : text(value.repository, "repository URL", 2048).trim() || undefined;
  // Only remote Git URLs, never a local path, option, helper protocol or shell command.
  const ssh = !!repository && /^[a-zA-Z0-9_.-]+@[a-zA-Z0-9_.-]+:[^\s]+$/.test(repository);
  let remote = ssh;
  if (repository && !ssh) try {
    const url = new URL(repository);
    remote = ["https:", "ssh:"].includes(url.protocol) && !!url.hostname && !url.password && !url.hash && !url.search;
    if (url.protocol === "https:" && url.username) remote = false;
  } catch { /* Invalid URL. */ }
  if (repository && (!remote || /[\s\x00-\x1f]/.test(repository))) throw new Error("Use an HTTPS or SSH Git repository URL, without embedded credentials.");
  const result: LaunchSpec = { name, harness: value.harness as HarnessName, ...(repository ? { repository } : {}) };
  if (value.terminal !== undefined) { if (typeof value.terminal !== "boolean") throw new Error("Invalid terminal mode."); result.terminal = value.terminal; }
  for (const key of ["ref", "model", "effort", "room", "prompt"] as const) {
    if (value[key] === undefined || value[key] === "") continue;
    const content = text(value[key], key, key === "prompt" ? 16000 : key === "room" ? 100 : 256);
    if (key !== "prompt" && /[\x00-\x1f]/.test(content)) throw new Error(`Invalid ${key}.`);
    result[key] = content;
  }
  if (result.ref?.startsWith("-")) throw new Error("Invalid repository ref.");
  if (result.ref && !repository) throw new Error("A repository is required when specifying a branch or ref.");
  if (result.effort && !["off", "minimal", "low", "medium", "high", "xhigh", "max", "auto", ...(result.harness === "codex" ? ["ultra"] : [])].includes(result.effort)) throw new Error("Invalid reasoning level.");
  return result;
}

/** The runner owns this buffer, so worker/controller reconnects cannot lose recent output. */
export class OutputBuffer {
  private entries: OutputEvent[] = [];
  private bytes = 0;
  private sequence = 1;
  constructor(private readonly maxEvents = 1000, private readonly maxBytes = 2 * 1024 * 1024) {
    if (maxEvents < 1 || maxBytes < 256) throw new Error("Invalid output buffer limits.");
  }
  append(kind: string, content: string): OutputEvent {
    const budget = Math.min(4096, Math.floor(this.maxBytes / 4));
    const truncated = Buffer.byteLength(content) > budget;
    const text = truncated ? Buffer.from(content).subarray(0, budget - 32).toString("utf8") + "\n[output truncated]" : content;
    const event = { seq: this.sequence++, at: Date.now(), kind: kind.slice(0, 64), text };
    this.entries.push(event); this.bytes += Buffer.byteLength(JSON.stringify(event));
    while (this.entries.length && (this.entries.length > this.maxEvents || this.bytes > this.maxBytes)) this.bytes -= Buffer.byteLength(JSON.stringify(this.entries.shift()!));
    return event;
  }
  snapshot(after = 0, budget = 64 * 1024): OutputSnapshot {
    const events: OutputEvent[] = []; let bytes = 0;
    // Prefer the most recent events if the retained buffer is larger than a response.
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const event = this.entries[i]!; if (event.seq <= after) break;
      const size = Buffer.byteLength(JSON.stringify(event)); if (bytes + size > budget) break;
      events.push(event); bytes += size;
    }
    events.reverse();
    return { events, first: events[0]?.seq ?? this.sequence, next: this.sequence };
  }
}
