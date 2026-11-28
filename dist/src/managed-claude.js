import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { HarnessProcess } from "./harness-process.js";
import { ManagedRoomTools } from "./managed-room-tools.js";
import { managedInstructions } from "./managed-omp.js";
import { hasClaudeSession } from "./claude-transcript.js";
/** Long-lived stream-json: owner prompts, room inputs, interrupt and native saved-session resume. */
export class ManagedClaude {
    executable;
    cwd;
    directory;
    host;
    entry;
    configuration;
    sessionFile;
    process;
    tools;
    streamed = new Set();
    stopping = false;
    closing;
    constructor(executable, cwd, directory, host, entry, configuration = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude")) {
        this.executable = executable;
        this.cwd = cwd;
        this.directory = directory;
        this.host = host;
        this.entry = entry;
        this.configuration = configuration;
        this.process = new HarnessProcess(host, "claude", frame => this.frame(frame));
        this.tools = new ManagedRoomTools(host, join(directory, "room-tools.json"));
    }
    async start(options) {
        await mkdir(this.directory, { recursive: true, mode: 0o700 });
        await this.tools.start();
        this.sessionFile = options.resume ?? randomUUID();
        if (!/^[a-f0-9-]{36}$/.test(this.sessionFile))
            throw new Error("Invalid Claude session ID.");
        const resume = !!options.resume && await hasClaudeSession(this.sessionFile, this.cwd, this.configuration);
        const mcp = { mcpServers: { sideband_managed: { command: process.execPath, args: [this.entry, "managed-mcp", this.tools.path] } } };
        this.process.start(this.executable, ["-p", "--verbose", "--input-format", "stream-json", "--output-format", "stream-json", "--include-partial-messages", "--replay-user-messages",
            "--dangerously-skip-permissions", "--append-system-prompt", managedInstructions, "--mcp-config", JSON.stringify(mcp),
            "--settings", JSON.stringify({ enabledPlugins: { "sideband@sideband": false } }), ...(resume ? ["--resume", this.sessionFile] : ["--session-id", this.sessionFile]),
            ...(options.model ? ["--model", options.model] : []), ...(options.effort ? ["--effort", options.effort] : [])], this.cwd);
        await this.process.request("initialize", {});
        this.host.state("idle");
    }
    frame(frame) {
        if (frame.type === "control_request") {
            this.process.send({ type: "control_response", response: { subtype: "error", request_id: frame.request_id, error: "Interactive input is unavailable in this unattended session. Ask the operator through its Sideband room." } });
            return;
        }
        if (frame.type === "stream_event") {
            const event = frame.event;
            if (event?.type === "message_start") {
                this.streamed.clear();
                this.host.state("busy");
            }
            if (event?.type === "content_block_delta" && ["text_delta", "thinking_delta"].includes(event.delta?.type)) {
                this.streamed.add(event.delta.type === "text_delta" ? "text" : "thinking");
                this.host.event(event.delta.type === "text_delta" ? "assistant" : "thinking", String(event.delta.text ?? event.delta.thinking ?? ""));
            }
        }
        else if (frame.type === "assistant") {
            for (const part of frame.message?.content ?? []) {
                if (!this.streamed.has(part.type) && ["text", "thinking"].includes(part.type))
                    this.host.event(part.type === "text" ? "assistant" : "thinking", part.text ?? part.thinking ?? "");
                if (part.type === "tool_use")
                    this.host.event("tool", `${part.name}\n${JSON.stringify(part.input ?? {})}`);
            }
            this.streamed.clear();
        }
        else if (frame.type === "user") {
            for (const part of Array.isArray(frame.message?.content) ? frame.message.content : [])
                if (part.type === "tool_result")
                    this.host.event(part.is_error ? "error" : "tool-output", typeof part.content === "string" ? part.content : JSON.stringify(part.content));
        }
        else if (frame.type === "result") {
            if (frame.is_error)
                this.host.event("error", (frame.errors ?? [frame.result ?? "Claude turn failed."]).join("\n"));
            this.host.state("idle");
        }
        else if (frame.type === "system" && frame.subtype === "init") {
            const managed = frame.mcp_servers?.find((server) => server.name === "sideband_managed");
            if (managed && managed.status !== "connected")
                this.host.event("error", `Sideband room tools are ${managed.status}. Stop and resume after fixing the MCP startup error.`);
        }
    }
    async prompt(text) {
        this.process.send({ type: "user", uuid: randomUUID(), session_id: this.sessionFile, parent_tool_use_id: null, message: { role: "user", content: [{ type: "text", text }] } });
        this.host.state("busy");
    }
    async deliver(text) { await this.prompt(text); }
    async interrupt() { await this.process.request("interrupt", { cancel_queued: true }); }
    stop() { return this.closing ??= this.close(); }
    async close() {
        this.stopping = true;
        try {
            this.process.send({ type: "control_request", request_id: "sideband-stop", request: { subtype: "end_session" } });
        }
        catch { /* Already exited. */ }
        await this.process.stop();
        await this.tools.close();
    }
}
//# sourceMappingURL=managed-claude.js.map