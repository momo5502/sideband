import { REQUEST_TIMEOUT_MS } from "./timeouts.js";
import { randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { ManagedRoomTools } from "./managed-room-tools.js";
import { NativeView } from "./native-view.js";
import { ClaudeTranscript, hasClaudeSession } from "./claude-transcript.js";
import { managedInstructions } from "./managed-omp.js";
/** Optional native fallback. Input is deliberately best-effort; the SDK mode remains the default. */
export class ManagedClaudeNative {
    executable;
    cwd;
    directory;
    host;
    entry;
    configuration;
    sessionFile;
    tools;
    view;
    transcript;
    ready = false;
    busy = false;
    interrupting = false;
    interruptionTimer;
    blocked = false;
    blockedBy = new Set();
    stopping = false;
    closing;
    initialized;
    operations = Promise.resolve();
    roomInputs = new Set();
    setupApproved = false;
    sessionStarted = false;
    setupTimer;
    constructor(executable, cwd, directory, host, entry, openView = exit => new NativeView(directory, entry, host, exit), configuration = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude")) {
        this.executable = executable;
        this.cwd = cwd;
        this.directory = directory;
        this.host = host;
        this.entry = entry;
        this.configuration = configuration;
        this.tools = new ManagedRoomTools(host, join(directory, "room-tools.json"), event => this.hook(event));
        this.view = openView(error => { if (!this.stopping) {
            this.initialized?.reject(error ?? new Error("Claude's terminal closed."));
            this.host.exit(error);
            void this.stop();
        } });
    }
    async start(options) {
        await mkdir(this.directory, { recursive: true, mode: 0o700 });
        this.sessionFile = options.resume ?? randomUUID();
        if (!/^[a-f0-9-]{36}$/.test(this.sessionFile))
            throw new Error("Invalid Claude session ID.");
        const resume = !!options.resume && await hasClaudeSession(this.sessionFile, this.cwd, this.configuration);
        await this.tools.start();
        this.setupApproved = await this.bypassApproved();
        if (!this.setupApproved) {
            this.host.event("terminal", "Claude may require its one-time bypass-mode confirmation locally. Web input stays paused until setup is complete.");
            this.setupTimer = setInterval(() => { if (!this.ready && this.sessionStarted && !this.blocked && !this.stopping)
                void this.bypassApproved().then(approved => { if (approved && !this.ready && !this.blocked && !this.stopping)
                    this.markReady(false); }); }, 1000);
            this.setupTimer.unref();
        }
        const command = [process.execPath, this.entry, "managed-hook", this.tools.path].map(value => process.platform === "win32" ? `"${value.replace(/%/g, "%%")}"` : `'${value.replace(/'/g, `'"'"'`)}'`).join(" ");
        const hooks = Object.fromEntries(["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PermissionRequest", "Notification", "Stop", "StopFailure", "SubagentStop"].map(event => [event, [{ hooks: [{ type: "command", command, timeout: (REQUEST_TIMEOUT_MS + 30_000) / 1000 }] }]]));
        const settings = { enabledPlugins: { "sideband@sideband": false }, skipDangerousModePermissionPrompt: true, hooks };
        const mcp = { mcpServers: { sideband_managed: { command: process.execPath, args: [this.entry, "managed-mcp", this.tools.path] } } };
        const initialized = new Promise((resolve, reject) => { this.initialized = { resolve, reject }; });
        const timer = setTimeout(() => this.host.event("terminal", "Still waiting for Claude's local setup. The terminal remains open. Finish its startup/trust prompts there, or stop this agent and choose Background mode."), 120000);
        timer.unref();
        this.host.event("terminal", "Native Claude input is best-effort. Complete any startup/trust prompts locally; avoid typing locally while sending from the web panel.");
        this.transcript = new ClaudeTranscript(this.sessionFile, this.host, resume, join(this.configuration, "projects"), this.cwd, () => this.markReady(false));
        this.transcript.start();
        try {
            await Promise.all([initialized, this.view.start(this.executable, ["--dangerously-skip-permissions", "--append-system-prompt", managedInstructions, "--settings", JSON.stringify(settings), "--mcp-config", JSON.stringify(mcp),
                    ...(resume ? ["--resume", this.sessionFile] : ["--session-id", this.sessionFile]), ...(options.model ? ["--model", options.model] : []), ...(options.effort ? ["--effort", options.effort] : [])], this.cwd)]);
        }
        finally {
            clearTimeout(timer);
        }
    }
    hook(event) {
        if (!event || event.session_id !== this.sessionFile || this.stopping)
            return;
        const type = event.hook_event_name, owner = typeof event.agent_id === "string" ? event.agent_id : "";
        if (type === "PermissionRequest" || type === "Notification" && ["permission_prompt", "elicitation_dialog"].includes(event.notification_type)) {
            this.blockedBy.add(owner);
            this.blocked = true;
            this.host.event("terminal", "Claude is waiting for local input. Web input is paused so it cannot answer a dialog accidentally.");
            return;
        }
        if (["PreToolUse", "PostToolUse", "Stop", "StopFailure", "SubagentStop"].includes(type) || type === "Notification" && event.notification_type === "idle_prompt")
            this.blockedBy.delete(owner);
        this.blocked = this.blockedBy.size > 0;
        if (owner) {
            if (!this.blocked && this.ready)
                this.initialized?.resolve();
            return;
        }
        if (type === "SessionStart") {
            this.sessionStarted = true;
            if (this.setupApproved)
                this.markReady(false);
        }
        else if (type === "Stop" || type === "StopFailure" || type === "Notification" && event.notification_type === "idle_prompt")
            this.markReady(false);
        else if (["UserPromptSubmit", "PreToolUse", "PostToolUse"].includes(type)) {
            this.markReady(true);
            if (type === "UserPromptSubmit" && typeof event.prompt === "string") {
                if (!this.roomInputs.delete(event.prompt.replace(/\r\n?/g, "\n").trim()))
                    this.host.event("user", event.prompt);
            }
        }
    }
    async bypassApproved() { try {
        return JSON.parse(await readFile(join(this.configuration, "settings.json"), "utf8")).skipDangerousModePermissionPrompt === true;
    }
    catch {
        return false;
    } }
    markReady(busy) { this.ready = true; this.interrupting = false; if (this.interruptionTimer)
        clearTimeout(this.interruptionTimer); this.blocked = this.blockedBy.size > 0; this.busy = busy; if (this.setupTimer)
        clearInterval(this.setupTimer); this.host.state(busy ? "busy" : "idle"); if (!this.blocked)
        this.initialized?.resolve(); }
    input(text, escape) {
        const operation = this.operations.then(async () => {
            if (!this.ready || this.blocked || this.stopping)
                throw new Error("Claude is waiting for local setup or a dialog. Finish it in the terminal before sending input.");
            if (!escape || this.busy && !this.interrupting) {
                // Claude omits Stop after Escape. Prefer its transcript marker, but cancelling
                // before the first output token may write no marker. New main activity cancels
                // this best-effort fallback through markReady(). Suppress repeated Escapes meanwhile.
                if (escape)
                    this.interrupting = true;
                try {
                    await this.view.input(text, escape);
                    if (escape && this.interrupting) {
                        this.interruptionTimer = setTimeout(() => { this.interrupting = false; if (!this.stopping && !this.blocked)
                            this.markReady(false); }, 3000);
                        this.interruptionTimer.unref();
                    }
                }
                catch (error) {
                    if (escape) {
                        this.interrupting = false;
                        if (this.interruptionTimer)
                            clearTimeout(this.interruptionTimer);
                    }
                    throw error;
                }
            }
        });
        this.operations = operation.catch(() => { });
        return operation;
    }
    prompt(text) { return this.input(text, false); }
    async deliver(text) {
        const value = text;
        const key = value.replace(/\r\n?/g, "\n").trim();
        this.roomInputs.add(key);
        if (this.roomInputs.size > 100)
            this.roomInputs.delete(this.roomInputs.values().next().value);
        try {
            await this.prompt(value);
        }
        catch (error) {
            this.roomInputs.delete(key);
            throw error;
        }
    }
    interrupt() { return this.input("", true); }
    stop() { return this.closing ??= this.close(); }
    async close() { this.stopping = true; if (this.setupTimer)
        clearInterval(this.setupTimer); if (this.interruptionTimer)
        clearTimeout(this.interruptionTimer); this.initialized?.reject(new Error("Claude native session stopped.")); await this.view.stop(); await this.transcript?.close(); await this.tools.close(); }
}
//# sourceMappingURL=managed-claude-native.js.map