import { readdir, stat, open } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
export async function hasClaudeSession(id, cwd, configuration = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude")) {
    if (!/^[a-f0-9-]{36}$/.test(id))
        throw new Error("Invalid Claude session ID.");
    const directory = join(configuration, "projects"), slug = cwd.replace(/[^a-zA-Z0-9]/g, "-");
    if (slug.length <= 200)
        try {
            if ((await stat(join(directory, slug, `${id}.jsonl`))).isFile())
                return true;
        }
        catch { /* Check canonical/long-path slug variants. */ }
    let entries;
    try {
        entries = await readdir(directory, { withFileTypes: true });
    }
    catch (error) {
        if (error.code === "ENOENT")
            return false;
        throw error;
    }
    for (const entry of entries)
        if (entry.isDirectory())
            try {
                if ((await stat(join(directory, entry.name, `${id}.jsonl`))).isFile())
                    return true;
            }
            catch { /* Only inspect this assigned UUID. */ }
    return false;
}
/** Tails only the explicitly assigned session UUID; never inspects other conversations. */
export class ClaudeTranscript {
    id;
    host;
    skipHistory;
    directory;
    cwd;
    onInterrupt;
    path;
    offset = 0;
    timer;
    reading;
    decoder = new StringDecoder("utf8");
    buffer = "";
    stopped = false;
    scannedAt = 0;
    constructor(id, host, skipHistory, directory = join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "projects"), cwd = process.cwd(), onInterrupt) {
        this.id = id;
        this.host = host;
        this.skipHistory = skipHistory;
        this.directory = directory;
        this.cwd = cwd;
        this.onInterrupt = onInterrupt;
    }
    start() { this.timer = setInterval(() => { this.reading ??= this.read().catch(error => { if (!this.stopped && error.code !== "ENOENT")
        this.host.event("error", "Claude transcript could not be read."); }).finally(() => { this.reading = undefined; }); }, 300); this.timer.unref(); }
    async read() {
        if (this.stopped)
            return;
        if (!this.path) {
            const slug = this.cwd.replace(/[^a-zA-Z0-9]/g, "-");
            const candidates = slug.length <= 200 ? [join(this.directory, slug, `${this.id}.jsonl`)] : [];
            if (Date.now() - this.scannedAt > 5000) {
                this.scannedAt = Date.now();
                const entries = await readdir(this.directory, { withFileTypes: true });
                for (const entry of entries.slice(0, 4096))
                    if (entry.isDirectory())
                        candidates.push(join(this.directory, entry.name, `${this.id}.jsonl`));
            }
            for (const candidate of candidates) {
                try {
                    const info = await stat(candidate);
                    if (info.isFile()) {
                        this.path = candidate;
                        if (this.skipHistory)
                            this.offset = info.size;
                        break;
                    }
                }
                catch { /* No transcript for this assigned UUID yet. */ }
            }
            if (!this.path)
                return;
            this.skipHistory = false;
        }
        const file = await open(this.path, "r");
        try {
            const info = await file.stat();
            if (info.size < this.offset) {
                this.offset = 0;
                this.buffer = "";
                this.decoder.end();
            }
            const size = Math.min(256 * 1024, Math.max(0, info.size - this.offset));
            if (!size)
                return;
            const buffer = Buffer.alloc(size);
            const { bytesRead } = await file.read(buffer, 0, size, this.offset);
            this.offset += bytesRead;
            this.buffer += this.decoder.write(buffer.subarray(0, bytesRead));
            while (this.buffer.includes("\n")) {
                const end = this.buffer.indexOf("\n"), line = this.buffer.slice(0, end);
                this.buffer = this.buffer.slice(end + 1);
                let record;
                try {
                    record = JSON.parse(line);
                }
                catch {
                    continue;
                }
                if (record.isSidechain || record.sessionId && record.sessionId !== this.id)
                    continue;
                if (record.type === "user") {
                    const content = record.message?.content;
                    const text = typeof content === "string" ? content : Array.isArray(content) ? content.filter((part) => part.type === "text").map((part) => part.text).join("\n") : "";
                    if (/^\[Request interrupted by user(?: for tool use)?\]$/.test(text.trim()))
                        this.onInterrupt?.();
                }
                if (record.type === "assistant")
                    for (const part of record.message?.content ?? []) {
                        if (part.type === "text" || part.type === "thinking")
                            this.host.event(part.type === "text" ? "assistant" : "thinking", part.text ?? part.thinking ?? "");
                        else if (part.type === "tool_use")
                            this.host.event("tool", `${part.name}\n${JSON.stringify(part.input ?? {})}`);
                    }
                if (record.type === "user" && Array.isArray(record.message?.content))
                    for (const part of record.message.content)
                        if (part.type === "tool_result")
                            this.host.event(part.is_error ? "error" : "tool-output", typeof part.content === "string" ? part.content : JSON.stringify(part.content));
            }
            if (Buffer.byteLength(this.buffer) > 8 * 1024 * 1024) {
                this.buffer = "";
                this.host.event("error", "A Claude transcript entry exceeded the output buffer limit.");
            }
        }
        finally {
            await file.close();
        }
    }
    async close() { this.stopped = true; if (this.timer)
        clearInterval(this.timer); await this.reading; }
}
//# sourceMappingURL=claude-transcript.js.map