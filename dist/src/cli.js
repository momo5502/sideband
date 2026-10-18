#!/usr/bin/env node
import { parseArgs } from "node:util";
import { createInterface } from "node:readline/promises";
import { emitKeypressEvents } from "node:readline";
import { RoomProfiles } from "./room-profiles.js";
export async function hiddenInput(prompt) {
    if (!process.stdin.isTTY || !process.stdout.isTTY)
        throw new Error("Use an interactive terminal, or the sideband_setup browser form. Never put passwords in chat or command arguments.");
    process.stdout.write(prompt);
    emitKeypressEvents(process.stdin);
    const wasRaw = process.stdin.isRaw;
    process.stdin.setRawMode(true);
    process.stdin.resume();
    return new Promise((resolve, reject) => {
        let secret = "";
        const finish = (error) => {
            process.stdin.off("keypress", handler);
            process.stdin.setRawMode(wasRaw);
            process.stdin.pause();
            process.stdout.write("\n");
            if (error)
                reject(error);
            else
                resolve(secret);
            secret = "";
        };
        const handler = (value, key) => {
            if (key.ctrl && key.name === "c")
                return finish(new Error("Cancelled."));
            if (key.name === "return" || key.name === "enter")
                return finish();
            if (key.name === "backspace") {
                secret = secret.slice(0, -1);
                return;
            }
            if (!key.ctrl && value && !/[\x00-\x1f\x7f]/.test(value))
                secret += value;
        };
        process.stdin.on("keypress", handler);
    });
}
async function main() {
    const command = process.argv[2];
    if (!command || ["help", "--help", "-h"].includes(command)) {
        console.log("Sideband\n\n  sideband server [--host 0.0.0.0] [--port 8765]\n  sideband configure [--profile default] [--server IP:port]\n  sideband mcp --harness codex|claude\n\nThe server prints a generated password and keeps no persistent state.\nClients can also configure a profile through the sideband_setup MCP browser form.");
        return;
    }
    if (command === "server") {
        const { values } = parseArgs({ args: process.argv.slice(3), options: { host: { type: "string", default: "0.0.0.0" }, port: { type: "string", default: "8765" } } });
        const port = Number(values.port);
        if (!Number.isInteger(port) || port < 0 || port > 65535)
            throw new Error("Invalid port.");
        const { RoomServer } = await import("./room-server.js");
        const server = await RoomServer.start({ host: values.host, port });
        console.log(`Sideband listening on ${values.host}:${server.port}\n\nClient address: <your-VPS-IP>:${server.port}\nPassword: ${server.password}\n\nTLS and certificate pinning are enabled. Keep this password private.\nAll rooms, history and this password disappear when the server stops.`);
        let closing = false;
        const close = () => { if (closing)
            return; closing = true; void server.close(); };
        process.once("SIGINT", close);
        process.once("SIGTERM", close);
        return;
    }
    if (command === "mcp") {
        const { values } = parseArgs({ args: process.argv.slice(3), options: { harness: { type: "string" } } });
        if (values.harness !== "codex" && values.harness !== "claude")
            throw new Error("Use --harness codex or --harness claude.");
        await (await import("./room-mcp.js")).runMcp(values.harness);
        return;
    }
    if (command === "configure") {
        const { values } = parseArgs({ args: process.argv.slice(3), options: { profile: { type: "string", default: "default" }, server: { type: "string" } } });
        if (!process.stdin.isTTY || !process.stdout.isTTY)
            throw new Error("Configure needs an interactive terminal. Use sideband_setup for an in-harness browser form.");
        let endpoint = values.server;
        if (!endpoint) {
            const reader = createInterface({ input: process.stdin, output: process.stdout });
            try {
                endpoint = await reader.question("Server IP:port: ");
            }
            finally {
                reader.close();
            }
        }
        await new RoomProfiles().save(values.profile, { server: endpoint, password: await hiddenInput("Server password (hidden): ") });
        console.log(`Saved profile '${values.profile}'. Activate it inside your agent; no session was connected by setup.`);
        return;
    }
    throw new Error("Unknown command. Run sideband --help.");
}
main().catch((error) => { process.stderr.write(`${error instanceof Error ? error.message : "Command failed."}\n`); process.exitCode = 1; });
//# sourceMappingURL=cli.js.map