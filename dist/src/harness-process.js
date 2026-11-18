import spawn from "cross-spawn";
import { StringDecoder } from "node:string_decoder";
import { terminateTree } from "./process-tree.js";
/** Bounded, continuously drained JSONL transport. Closing it never touches unrelated harnesses. */
export class HarnessProcess {
    host;
    protocol;
    frame;
    child;
    stopping = false;
    ended = false;
    sequence = 0;
    pending = new Map();
    constructor(host, protocol, frame) {
        this.host = host;
        this.protocol = protocol;
        this.frame = frame;
    }
    start(executable, args, cwd) {
        const child = this.child = spawn(executable.command, [...(executable.args ?? []), ...args], { cwd, windowsHide: true, detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"] });
        const decoder = new StringDecoder("utf8");
        let buffer = "";
        child.stdout.on("data", (chunk) => {
            buffer += decoder.write(chunk);
            while (buffer.includes("\n")) {
                const end = buffer.indexOf("\n"), line = buffer.slice(0, end);
                buffer = buffer.slice(end + 1);
                if (Buffer.byteLength(line) > 8 * 1024 * 1024) {
                    this.fail(new Error("Harness output frame exceeded 8 MiB."));
                    return;
                }
                let value;
                try {
                    value = JSON.parse(line);
                }
                catch {
                    if (line)
                        this.host.event("output", line);
                    continue;
                }
                this.receive(value);
            }
            if (Buffer.byteLength(buffer) > 8 * 1024 * 1024)
                this.fail(new Error("Harness output frame exceeded 8 MiB."));
        });
        child.stderr.setEncoding("utf8");
        child.stderr.on("data", chunk => this.host.event("stderr", String(chunk)));
        child.stdin.on("error", error => this.fail(error));
        child.once("error", error => this.fail(error));
        child.once("exit", (code, signal) => this.fail(new Error(`Harness exited (${signal ?? code}).`), false));
    }
    receive(value) {
        const response = this.protocol === "claude" && value.type === "control_response" ? value.response : value;
        const id = this.protocol === "claude" ? response?.request_id : response?.id;
        const pending = this.pending.get(String(id));
        if (pending && (this.protocol === "claude" || !value.method)) {
            clearTimeout(pending.timer);
            this.pending.delete(String(id));
            if (response.error || response.subtype === "error")
                pending.reject(new Error(typeof response.error === "string" ? response.error : response.error?.message ?? "Harness request failed."));
            else
                pending.resolve(this.protocol === "claude" ? response.response ?? {} : response.result);
        }
        else
            this.frame(value);
    }
    send(value) {
        if (!this.child?.stdin.writable || this.ended)
            throw new Error("Harness is disconnected.");
        const line = JSON.stringify(value) + "\n";
        if (Buffer.byteLength(line) > 8 * 1024 * 1024 || this.child.stdin.writableLength > 2 * 1024 * 1024)
            throw new Error("Harness input backlog is full.");
        this.child.stdin.write(line);
    }
    request(method, params = {}) {
        if (this.pending.size >= 128)
            return Promise.reject(new Error("Harness request backlog is full."));
        const id = `sideband-${++this.sequence}`;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} timed out; acceptance is unknown. Check output before resending.`)); }, 25000);
            this.pending.set(id, { resolve, reject, timer });
            try {
                this.send(this.protocol === "claude" ? { type: "control_request", request_id: id, request: { subtype: method, ...params } } : { id, method, params });
            }
            catch (error) {
                clearTimeout(timer);
                this.pending.delete(id);
                reject(error);
            }
        });
    }
    fail(error, kill = true) {
        if (this.ended)
            return;
        this.ended = true;
        for (const request of this.pending.values()) {
            clearTimeout(request.timer);
            request.reject(error);
        }
        this.pending.clear();
        if (kill && this.child)
            terminateTree(this.child);
        if (!this.stopping)
            this.host.exit(error);
    }
    async stop() {
        this.stopping = true;
        const child = this.child;
        if (!child || child.exitCode !== null || child.signalCode !== null || !child.pid)
            return;
        await new Promise(resolve => { const timer = setTimeout(() => terminateTree(child), 5000); child.once("close", () => { clearTimeout(timer); resolve(); }); child.stdin.end(); });
    }
}
//# sourceMappingURL=harness-process.js.map