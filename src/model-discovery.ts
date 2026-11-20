import spawn from "cross-spawn";
import { StringDecoder } from "node:string_decoder";
import type { ChildProcess, ChildProcessWithoutNullStreams } from "node:child_process";
import { basename, dirname, join } from "node:path";
import { realpathSync, existsSync } from "node:fs";
import type { Executable } from "./managed-omp.js";
import type { HarnessName, HarnessModel, ModelCatalog } from "./orchestration-protocol.js";
import { REQUEST_TIMEOUT_MS } from "./timeouts.js";
import { terminateTree } from "./process-tree.js";

const efforts = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max", "auto", "ultra"]);
class ModelQueryError extends Error {}
export function modelEntries(harness: HarnessName, rows: unknown): HarnessModel[] {
  if (!Array.isArray(rows)) throw new Error("The harness did not return a model list.");
  const models = new Map<string, HarnessModel>();
  let bytes = 0;
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const v = row as Record<string, any>;
    if (v.hidden || harness === "claude" && v.value === "default") continue;
    const id = harness === "omp" ? v.selector ?? (v.provider && v.id ? `${v.provider}/${v.id}` : v.id) : v.model ?? v.value ?? v.id;
    if (typeof id !== "string" || !id || id.length > 256 || /[\x00-\x1f]/.test(id)) continue;
    const label = String(v.displayName ?? v.display_name ?? v.name ?? v.label ?? id).replace(/[\x00-\x1f]/g, " ").slice(0, 128);
    const levels = v.supportedReasoningEfforts?.map((e: any) => e.reasoningEffort === "none" ? "off" : e.reasoningEffort) ?? v.supportedEffortLevels ?? v.thinking ?? v.efforts ?? (v.supportsEffort === false ? [] : undefined);
    const supported = Array.isArray(levels) ? [...new Set<string>(levels.filter((e: unknown) => typeof e === "string" && efforts.has(e) && (e !== "ultra" || harness === "codex")))] : undefined;
    const defaultEffort = v.defaultReasoningEffort === "none" ? "off" : v.defaultReasoningEffort ?? v.defaultEffort;
    const model = { id, label, ...(supported ? { efforts: supported } : {}), ...(efforts.has(defaultEffort) ? { defaultEffort } : {}), ...(v.isDefault === true ? { isDefault: true } : {}) };
    bytes += Buffer.byteLength(JSON.stringify(model)) + 1; if (bytes > 190 * 1024) break;
    models.set(id, model);
    if (models.size >= 1000) break;
  }
  return [...models.values()];
}

/** Queries native metadata only. Never submits a prompt, opens a terminal, or prints credentials. */
export class ModelDiscovery {
  private pending = new Map<HarnessName, Promise<ModelCatalog>>();
  private children = new Set<ChildProcess>();
  private cancellations = new Set<() => void>();
  private exits = new Set<Promise<void>>();
  private closed = false;
  readonly catalogs: Partial<Record<HarnessName, ModelCatalog>> = {};
  constructor(private readonly executable: (harness: HarnessName) => Executable, private readonly cwd: string, private readonly entry: string) {}
  refresh(harness: HarnessName): Promise<ModelCatalog> {
    const pending = this.pending.get(harness); if (pending) return pending;
    if (this.closed) return Promise.reject(new Error("Model discovery is closed."));
    const task = this.query(harness).then(models => ({ models, at: Date.now() }), (error: unknown) => ({ models: this.catalogs[harness]?.models ?? [], at: Date.now(), error: `Model discovery failed. ${error instanceof ModelQueryError ? error.message : "Check this harness's login and configuration on the machine."} Refresh or enter a model ID.` }))
      .then(catalog => { this.catalogs[harness] = catalog; return catalog; }).finally(() => this.pending.delete(harness));
    this.pending.set(harness, task); return task;
  }
  private async query(harness: HarnessName): Promise<HarnessModel[]> {
    const executable = this.executable(harness);
    const entry = realpathSync(this.entry), probe = join(dirname(entry), ...(basename(entry) === "cli.js" ? [] : ["src"]), "omp-model-probe.js");
    if (harness === "omp" && !existsSync(probe)) throw new ModelQueryError("OMP probe file is missing; reinstall Sideband.");
    const args = harness === "codex" ? ["app-server", "--listen", "stdio://", "-c", 'mcp_servers={}', "-c", 'plugins."sideband@sideband".enabled=false'] : harness === "claude"
      ? ["-p", "--verbose", "--input-format", "stream-json", "--output-format", "stream-json", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--settings", JSON.stringify({ enabledPlugins: { "sideband@sideband": false } })]
      : ["--mode", "rpc", "--no-ui", "--no-title", "--no-session", "--no-extensions", "-e", probe];
    return new Promise((resolve, reject) => {
      const child = spawn(executable.command, [...(executable.args ?? []), ...args], { cwd: this.cwd, windowsHide: true, detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"] }) as ChildProcessWithoutNullStreams;
      this.children.add(child);
      const exited = new Promise<void>(resolve => child.once("close", () => { this.children.delete(child); this.exits.delete(exited); resolve(); })); this.exits.add(exited);
      let settled = false, buffer = "", bytes = 0, pages = 0; const rows: unknown[] = [], cursors = new Set<string>(), decoder = new StringDecoder("utf8");
      const finish = (error?: Error, models?: HarnessModel[]) => {
        if (settled) return; settled = true; clearTimeout(timer); this.cancellations.delete(cancel);
        child.stdin.end(); if (child.exitCode === null && child.signalCode === null) terminateTree(child); error ? reject(error) : resolve(models ?? []);
      };
      const send = (value: object) => { if (!settled) child.stdin.write(JSON.stringify(value) + "\n"); };
      const cancel = () => finish(new ModelQueryError("Model discovery was cancelled.")); this.cancellations.add(cancel);
      const timer = setTimeout(() => finish(new ModelQueryError(`The query timed out after ${REQUEST_TIMEOUT_MS / 1000} s.`)), REQUEST_TIMEOUT_MS);
      if (harness === "omp") {
        let stderr = ""; const decoder = new StringDecoder("utf8");
        child.stderr.on("data", (chunk: Buffer) => {
          stderr += decoder.write(chunk); if (Buffer.byteLength(stderr) > 512 * 1024) { finish(new Error("Model response exceeded its limit.")); return; }
          while (stderr.includes("\n") && !settled) {
            const end = stderr.indexOf("\n"), line = stderr.slice(0, end); stderr = stderr.slice(end + 1);
            if (!line.startsWith("SIDEBAND_MODELS ")) continue;
            try { const response = JSON.parse(line.slice(16)); if (response.error) throw new Error(); finish(undefined, modelEntries(harness, response.models)); } catch { finish(new ModelQueryError("OMP did not return valid model metadata.")); }
          }
        });
      } else child.stderr.resume();
      child.on("error", () => finish(new ModelQueryError("The harness executable could not be started."))); child.stdin.on("error", () => finish(new ModelQueryError("The harness input closed before returning models.")));
      child.once("exit", (code, signal) => finish(new ModelQueryError(`The harness exited (${signal ?? code}) before returning models.`)));
      const frame = (v: any) => {
        if (harness === "omp") return;
        if (harness === "claude") {
          if (v.type === "control_request") send({ type: "control_response", response: { subtype: "error", request_id: v.request_id, error: "Model discovery does not run tools or request permissions." } });
          if (v.type === "control_response" && v.response?.request_id === "models") {
            if (v.response.subtype === "error") finish(new Error("Claude initialization failed.")); else finish(undefined, modelEntries(harness, v.response.response?.models));
          }
        } else {
          if (v.id !== undefined && v.method) { send({ id: v.id, error: { code: -32601, message: "Model discovery cannot execute requests." } }); return; }
          if (v.error && ["initialize", "models"].includes(v.id)) { finish(new Error("Codex model query failed.")); return; }
          if (v.id === "initialize") { send({ method: "initialized" }); send({ id: "models", method: "model/list", params: { limit: 100 } }); }
          if (v.id === "models") {
            if (!Array.isArray(v.result?.data)) { finish(new Error("Invalid Codex model response.")); return; }
            rows.push(...v.result.data); const cursor = v.result.nextCursor;
            if (typeof cursor === "string" && cursor && !cursors.has(cursor) && ++pages < 10 && rows.length < 1000) { cursors.add(cursor); send({ id: "models", method: "model/list", params: { limit: 100, cursor } }); }
            else finish(undefined, modelEntries(harness, rows));
          }
        }
      };
      child.stdout.on("data", (chunk: Buffer) => {
        bytes += chunk.length; if (bytes > 8 * 1024 * 1024) { finish(new Error("Model response exceeded its limit.")); return; }
        buffer += decoder.write(chunk);
        while (buffer.includes("\n") && !settled) { const end = buffer.indexOf("\n"), line = buffer.slice(0, end); buffer = buffer.slice(end + 1); let v; try { v = JSON.parse(line); } catch { continue; } try { frame(v); } catch { finish(new Error("Invalid model response.")); } }
      });
      child.once("spawn", () => {
        if (this.closed || settled) { terminateTree(child); return; }
        if (harness === "codex") send({ id: "initialize", method: "initialize", params: { clientInfo: { name: "sideband-models", version: "1" } } });
        if (harness === "claude") send({ type: "control_request", request_id: "models", request: { subtype: "initialize" } });
      });
    });
  }
  async close(): Promise<void> { this.closed = true; for (const cancel of this.cancellations) cancel(); for (const child of this.children) terminateTree(child); await Promise.allSettled([...this.pending.values(), ...this.exits]); }
}
