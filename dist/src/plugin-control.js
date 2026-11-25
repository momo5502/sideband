import { createServer, connect } from "node:net";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readLocal, writeLocal } from "./local-wire.js";
import { REQUEST_TIMEOUT_MS } from "./timeouts.js";
export function pluginEndpoint(value) {
    return value && Number.isInteger(value.port) && value.port > 0 && value.port <= 65535 && typeof value.token === "string" && /^[A-Za-z0-9_-]{43}$/.test(value.token) ? { port: value.port, token: value.token } : undefined;
}
/** Loopback only; the bearer token stays in the user's private presence file. */
export class PluginControl {
    command;
    token = randomBytes(32).toString("base64url");
    server;
    sockets = new Set();
    prompting = false;
    launches = [];
    constructor(command) {
        this.command = command;
    }
    async start() {
        const server = this.server = createServer(socket => {
            if (this.sockets.size >= 16) {
                socket.destroy();
                return;
            }
            this.sockets.add(socket);
            socket.once("close", () => this.sockets.delete(socket));
            socket.setTimeout(REQUEST_TIMEOUT_MS, () => socket.destroy());
            let received = false;
            readLocal(socket, packet => {
                if (received) {
                    socket.destroy();
                    return;
                }
                received = true;
                void (async () => {
                    let prompt = false;
                    try {
                        if (typeof packet.token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(packet.token) || !timingSafeEqual(Buffer.from(packet.token), Buffer.from(this.token)))
                            throw new Error("Unauthenticated plugin request.");
                        if (packet.type !== "request" || !/^[a-f0-9]{64}$/.test(packet.key) || !["prompt", "logs"].includes(packet.action))
                            throw new Error("Invalid plugin request.");
                        if (packet.action === "prompt") {
                            if (typeof packet.text !== "string" || !packet.text.trim() || packet.text.length > 16000)
                                throw new Error("Invalid instructions.");
                            this.launches = this.launches.filter(at => Date.now() - at < 10000);
                            if (this.prompting || this.launches.length >= 10)
                                throw new Error("This session is accepting another instruction. Try again shortly.");
                            this.launches.push(Date.now());
                            this.prompting = prompt = true;
                        }
                        else if (packet.after !== undefined && (!Number.isSafeInteger(packet.after) || packet.after < 0))
                            throw new Error("Invalid output position.");
                        const result = await this.command({ key: packet.key, action: packet.action, ...(packet.action === "prompt" ? { text: packet.text } : { after: packet.after ?? 0 }) });
                        writeLocal(socket, { type: "reply", result });
                    }
                    catch (error) {
                        writeLocal(socket, { type: "reply", error: error instanceof Error ? error.message.slice(0, 2048) : "Plugin request failed." });
                    }
                    finally {
                        if (prompt)
                            this.prompting = false;
                        socket.end();
                    }
                })();
            });
        });
        await new Promise((resolve, reject) => { server.once("error", reject); server.listen({ host: "127.0.0.1", port: 0 }, resolve); });
        return { port: server.address().port, token: this.token };
    }
    async close() { for (const socket of this.sockets)
        socket.destroy(); if (this.server)
        await new Promise(resolve => this.server.close(() => resolve())); }
}
export function requestPlugin(endpoint, command, signal) {
    return new Promise((resolve, reject) => {
        const socket = connect({ host: "127.0.0.1", port: endpoint.port });
        let settled = false;
        const finish = (error, result) => { if (settled)
            return; settled = true; clearTimeout(timer); signal?.removeEventListener("abort", abort); socket.destroy(); error ? reject(error) : resolve(result); };
        const abort = () => finish(new Error("Plugin request cancelled; acceptance is unknown."));
        const timer = setTimeout(() => finish(new Error("Plugin request timed out; acceptance is unknown. Check the terminal before resending.")), REQUEST_TIMEOUT_MS);
        socket.once("error", () => finish(new Error("The session's plugin is no longer reachable.")));
        socket.once("close", () => finish(new Error("Plugin connection lost; acceptance is unknown. Check the terminal before resending.")));
        socket.once("connect", () => { if (!writeLocal(socket, { type: "request", token: endpoint.token, ...command }))
            finish(new Error("Could not send plugin request.")); });
        readLocal(socket, packet => { if (packet.type !== "reply")
            finish(new Error("Invalid plugin response."));
        else
            finish(packet.error ? new Error(String(packet.error).slice(0, 2048)) : undefined, packet.result); });
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted)
            abort();
    });
}
//# sourceMappingURL=plugin-control.js.map