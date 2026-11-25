import { agentName, fields, text } from "./room-protocol.js";
export function modelCatalog(input) {
    const value = fields(input, ["models", "at", "error"]);
    if (!Number.isFinite(value.at) || !Array.isArray(value.models) || value.models.length > 1000)
        throw new Error("Invalid model catalog.");
    if (Buffer.byteLength(JSON.stringify(value)) > 200 * 1024)
        throw new Error("Model catalog exceeded its size limit.");
    const levels = ["off", "minimal", "low", "medium", "high", "xhigh", "max", "auto", "ultra"];
    const models = value.models.map(row => {
        const v = fields(row, ["id", "label", "efforts", "defaultEffort", "isDefault"]);
        const id = text(v.id, "model ID", 256), label = text(v.label, "model label", 128);
        if (/[\x00-\x1f]/.test(id + label))
            throw new Error("Invalid model text.");
        if (v.efforts !== undefined && (!Array.isArray(v.efforts) || v.efforts.length > levels.length || v.efforts.some(e => !levels.includes(e))))
            throw new Error("Invalid model reasoning levels.");
        if (v.defaultEffort !== undefined && !levels.includes(v.defaultEffort))
            throw new Error("Invalid default reasoning level.");
        if (v.isDefault !== undefined && typeof v.isDefault !== "boolean")
            throw new Error("Invalid default model flag.");
        return { id, label, ...(v.efforts !== undefined ? { efforts: v.efforts } : {}), ...(v.defaultEffort ? { defaultEffort: v.defaultEffort } : {}), ...(v.isDefault !== undefined ? { isDefault: v.isDefault } : {}) };
    });
    return { models, at: value.at, ...(value.error ? { error: text(value.error, "model discovery error", 512) } : {}) };
}
export function launchSpec(input) {
    const value = fields(input, ["name", "harness", "repository", "folder", "ref", "model", "effort", "room", "prompt", "terminal"]);
    const name = agentName(value.name);
    if (!name)
        throw new Error("Choose an agent name.");
    if (!["omp", "codex", "claude", "pi"].includes(value.harness))
        throw new Error("Choose OMP, Codex, Claude or PI.");
    const repository = value.repository === undefined || value.repository === "" ? undefined : text(value.repository, "repository URL", 2048).trim() || undefined;
    // Only remote Git URLs, never a local path, option, helper protocol or shell command.
    const ssh = !!repository && /^[a-zA-Z0-9_.-]+@[a-zA-Z0-9_.-]+:[^\s]+$/.test(repository);
    let remote = ssh;
    if (repository && !ssh)
        try {
            const url = new URL(repository);
            remote = ["https:", "ssh:"].includes(url.protocol) && !!url.hostname && !url.password && !url.hash && !url.search;
            if (url.protocol === "https:" && url.username)
                remote = false;
        }
        catch { /* Invalid URL. */ }
    if (repository && (!remote || /[\s\x00-\x1f]/.test(repository)))
        throw new Error("Use an HTTPS or SSH Git repository URL, without embedded credentials.");
    const result = { name, harness: value.harness, ...(repository ? { repository } : {}) };
    if (value.folder !== undefined && value.folder !== "") {
        const folder = text(value.folder, "folder path", 4096);
        if (/[\x00-\x1f]/.test(folder) || !(/^[A-Za-z]:[\\/]/.test(folder) || folder.startsWith("/") || /^\\\\[^\\]+\\[^\\]+/.test(folder)))
            throw new Error("Choose an absolute folder path on the worker machine.");
        if (repository)
            throw new Error("Choose either a repository or an existing folder.");
        result.folder = folder;
    }
    if (value.terminal !== undefined) {
        if (typeof value.terminal !== "boolean")
            throw new Error("Invalid terminal mode.");
        result.terminal = value.terminal;
    }
    for (const key of ["ref", "model", "effort", "room", "prompt"]) {
        if (value[key] === undefined || value[key] === "")
            continue;
        const content = text(value[key], key, key === "prompt" ? 16000 : key === "room" ? 100 : 256);
        if (key !== "prompt" && /[\x00-\x1f]/.test(content))
            throw new Error(`Invalid ${key}.`);
        result[key] = content;
    }
    if (result.ref?.startsWith("-"))
        throw new Error("Invalid repository ref.");
    if (result.ref && !repository)
        throw new Error("A repository is required when specifying a branch or ref.");
    if (result.harness === "pi" && result.effort && !["off", "minimal", "low", "medium", "high", "xhigh"].includes(result.effort))
        throw new Error("PI supports reasoning levels off through xhigh.");
    if (result.effort && !["off", "minimal", "low", "medium", "high", "xhigh", "max", "auto", ...(result.harness === "codex" ? ["ultra"] : [])].includes(result.effort))
        throw new Error("Invalid reasoning level.");
    return result;
}
/** The runner owns this buffer, so worker/controller reconnects cannot lose recent output. */
export class OutputBuffer {
    maxEvents;
    maxBytes;
    entries = [];
    bytes = 0;
    sequence = 1;
    constructor(maxEvents = 1000, maxBytes = 2 * 1024 * 1024) {
        this.maxEvents = maxEvents;
        this.maxBytes = maxBytes;
        if (maxEvents < 1 || maxBytes < 256)
            throw new Error("Invalid output buffer limits.");
    }
    append(kind, content) {
        const budget = Math.min(4096, Math.floor(this.maxBytes / 4));
        const truncated = Buffer.byteLength(content) > budget;
        const text = truncated ? Buffer.from(content).subarray(0, budget - 32).toString("utf8") + "\n[output truncated]" : content;
        const event = { seq: this.sequence++, at: Date.now(), kind: kind.slice(0, 64), text };
        this.entries.push(event);
        this.bytes += Buffer.byteLength(JSON.stringify(event));
        while (this.entries.length && (this.entries.length > this.maxEvents || this.bytes > this.maxBytes))
            this.bytes -= Buffer.byteLength(JSON.stringify(this.entries.shift()));
        return event;
    }
    snapshot(after = 0, budget = 64 * 1024) {
        const events = [];
        let bytes = 0;
        // Prefer the most recent events if the retained buffer is larger than a response.
        for (let i = this.entries.length - 1; i >= 0; i--) {
            const event = this.entries[i];
            if (event.seq <= after)
                break;
            const size = Buffer.byteLength(JSON.stringify(event));
            if (bytes + size > budget)
                break;
            events.push(event);
            bytes += size;
        }
        events.reverse();
        return { events, first: events[0]?.seq ?? this.sequence, next: this.sequence };
    }
}
//# sourceMappingURL=orchestration-protocol.js.map