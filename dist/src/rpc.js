import { spawn } from "node:child_process";
import { Duplex } from "node:stream";
import WebSocket from "ws";
export class RpcError extends Error {
    code;
    constructor(message, code) {
        super(message);
        this.code = code;
        this.name = "RpcError";
    }
}
export class CodexRpc {
    socket;
    child;
    nextId = 1;
    pending = new Map();
    constructor(socket, child) {
        this.socket = socket;
        this.child = child;
        socket.on("message", (data) => {
            let message;
            try {
                message = JSON.parse(data.toString());
            }
            catch {
                return;
            }
            if (message.id === undefined)
                return;
            if (message.method) {
                // Delivery does not subscribe/resume threads. Leave any broadcast approval/user-input
                // request to the existing harness UI; even an error response could consume its request.
                return;
            }
            const request = this.pending.get(message.id);
            if (!request)
                return;
            this.pending.delete(message.id);
            clearTimeout(request.timer);
            if (message.error)
                request.reject(new RpcError(message.error.message, message.error.code));
            else
                request.resolve(message.result);
        });
        socket.on("error", (error) => this.fail(error));
        socket.on("close", () => this.fail(new Error("Codex app-server connection closed.")));
        child?.on("error", (error) => this.fail(error));
    }
    static async connect(options = {}) {
        let child;
        let socket;
        if (options.url) {
            // Remote authentication is intentionally not added to this local-session adapter.
            const url = new URL(options.url);
            if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || url.protocol !== "ws:") {
                throw new Error("Sideband accepts only a local ws:// Codex endpoint.");
            }
            socket = new WebSocket(options.url, { handshakeTimeout: options.timeoutMs ?? 10_000 });
        }
        else {
            child = spawn(options.command ?? process.env.CODEX_BIN ?? "codex", [
                "app-server", "proxy", ...(options.socketPath ? ["--sock", options.socketPath] : []),
            ], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
            // A raw WebSocket upgrade runs over the proxy's stdio, not a JSONL stream.
            const stream = Duplex.from({ writable: child.stdin, readable: child.stdout });
            child.stderr.resume();
            socket = new WebSocket("ws://localhost/rpc", {
                createConnection: () => stream,
                handshakeTimeout: options.timeoutMs ?? 10_000,
            });
        }
        const connection = new CodexRpc(socket, child);
        try {
            await new Promise((resolve, reject) => {
                socket.once("open", resolve);
                socket.once("error", reject);
                child?.once("error", reject);
            });
            await connection.request("initialize", {
                clientInfo: { name: "sideband", title: "Sideband", version: "0.3.0" },
                capabilities: { experimentalApi: true },
            });
            socket.send(JSON.stringify({ method: "initialized" }));
            return connection;
        }
        catch (error) {
            await connection.close();
            throw error;
        }
    }
    request(method, params = {}) {
        if (this.socket.readyState !== WebSocket.OPEN)
            return Promise.reject(new Error("Codex connection is not open."));
        const id = this.nextId++;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                // A timeout has ambiguous delivery status. Never automatically resubmit the input.
                reject(new Error(`Codex ${method} timed out; delivery status is unknown.`));
            }, 10_000);
            this.pending.set(id, { resolve: (value) => resolve(value), reject, timer });
            this.socket.send(JSON.stringify({ id, method, params }), (error) => {
                if (error) {
                    clearTimeout(timer);
                    this.pending.delete(id);
                    reject(error);
                }
            });
        });
    }
    fail(error) {
        for (const request of this.pending.values()) {
            clearTimeout(request.timer);
            request.reject(error);
        }
        this.pending.clear();
    }
    async close() {
        this.fail(new Error("Codex connection closed."));
        this.socket.terminate();
        this.child?.stdin.end();
        this.child?.kill();
    }
}
//# sourceMappingURL=rpc.js.map