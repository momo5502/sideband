import { agentName, fields, text } from "./room-protocol.js";
export function launchSpec(input) {
    const value = fields(input, ["name", "harness", "repository", "ref", "model", "effort", "room", "prompt"]);
    const name = agentName(value.name);
    if (!name)
        throw new Error("Choose an agent name.");
    if (value.harness !== "omp")
        throw new Error("This milestone supports OMP; Claude and Codex adapters follow.");
    const repository = text(value.repository, "repository URL", 2048).trim();
    // Only remote Git URLs, never a local path, option, helper protocol or shell command.
    const ssh = /^[a-zA-Z0-9_.-]+@[a-zA-Z0-9_.-]+:[^\s]+$/.test(repository);
    let remote = ssh;
    if (!ssh)
        try {
            const url = new URL(repository);
            remote = ["https:", "ssh:"].includes(url.protocol) && !!url.hostname && !url.password && !url.hash && !url.search;
            if (url.protocol === "https:" && url.username)
                remote = false;
        }
        catch { /* Invalid URL. */ }
    if (!remote || /[\s\x00-\x1f]/.test(repository))
        throw new Error("Use an HTTPS or SSH Git repository URL, without embedded credentials.");
    const result = { name, harness: "omp", repository };
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
    if (result.effort && !["off", "minimal", "low", "medium", "high", "xhigh", "max", "auto"].includes(result.effort))
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