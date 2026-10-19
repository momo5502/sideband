#!/usr/bin/env node
import { parseArgs } from "node:util";
import { createInterface } from "node:readline/promises";
import { join, resolve } from "node:path";
import { RoomProfiles, stateDirectory } from "./room-profiles.js";
import { hiddenInput, terminalLogin } from "./terminal-login.js";
async function main(): Promise<void> {
  const command = process.argv[2];
  if (["help", "--help", "-h"].includes(command ?? "") || (!command && (!process.stdin.isTTY || !process.stdout.isTTY))) {
    console.log("Sideband\n\n  sideband [chat] [--profile NAME] [--name NAME]\n  sideband server [--host 0.0.0.0] [--port 8765] [--status-port 8766] [--rotate-password] [--credentials-file PATH]\n  sideband login IP:port [--profile default]\n  sideband configure [--profile default] [--server IP:port]\n  sideband mcp --harness codex|claude\n\nRun sideband in a terminal to browse rooms and chat with agents.\nLogin uses a hidden terminal password prompt; it does not activate an agent.\nClaude also supports /plugin configure sideband@sideband.\nThe server saves its password and TLS identity; only rooms and history are ephemeral.\nUse --rotate-password to explicitly replace saved server credentials."); return;
  }
  if (!command || command === "chat" || command.startsWith("--")) {
    const { values } = parseArgs({ args: process.argv.slice(command === "chat" ? 3 : 2),
      options: { profile: { type: "string" }, name: { type: "string" } } });
    await (await import("./terminal-chat.js")).terminalChat(values); return;
  }
  if (command === "server") {
    const { values } = parseArgs({ args: process.argv.slice(3), options: { host: { type: "string", default: "0.0.0.0" }, port: { type: "string", default: "8765" },
      "status-port": { type: "string", default: "8766" }, "rotate-password": { type: "boolean", default: false }, "credentials-file": { type: "string" } } });
    const port = Number(values.port); if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Invalid port.");
    const statusPort = Number(values["status-port"]); if (!Number.isInteger(statusPort) || statusPort < 0 || statusPort > 65535) throw new Error("Invalid status port.");
    if (port !== 0 && port === statusPort) throw new Error("HTTP status and HTTPS need different ports. Use --status-port to choose another port.");
    const credentialsFile = resolve(values["credentials-file"] ?? join(stateDirectory, "server-credentials.json"));
    const { RoomServer } = await import("./room-server.js"); const server = await RoomServer.start({ host: values.host, port, statusPort,
      credentialsFile, rotatePassword: values["rotate-password"] });
    console.log(`Sideband listening on ${values.host}:${server.port}\n\nClient address: <your-VPS-IP>:${server.port}\nPassword: ${server.password}\n\nPublic status: http://<your-VPS-IP>:${server.statusPort}/ or https://<your-VPS-IP>:${server.port}/\nTLS and certificate pinning are enabled. Keep this password private.\nCredentials: ${credentialsFile}\nThe password and TLS identity are reused on restart. Use --rotate-password to replace them.\nRooms and history disappear when the server stops.`);
    let closing = false;
    const close = () => { if (closing) return; closing = true; void server.close(); };
    process.once("SIGINT", close); process.once("SIGTERM", close); return;
  }
  if (command === "mcp") {
    const { values } = parseArgs({ args: process.argv.slice(3), options: { harness: { type: "string" } } });
    if (values.harness !== "codex" && values.harness !== "claude") throw new Error("Use --harness codex or --harness claude.");
    await (await import("./room-mcp.js")).runMcp(values.harness); return;
  }
  if (command === "login") {
    const { values, positionals } = parseArgs({ args: process.argv.slice(3), allowPositionals: true,
      options: { profile: { type: "string", default: "default" } } });
    if (positionals.length !== 1) throw new Error("Use sideband login IP:port [--profile NAME]. Do not supply a password as an argument.");
    await terminalLogin(positionals[0]!, values.profile!); return;
  }
  if (command === "configure") {
    const { values } = parseArgs({ args: process.argv.slice(3), options: { profile: { type: "string", default: "default" }, server: { type: "string" } } });
    if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("Configure needs an interactive terminal. Use sideband_setup for an in-harness browser form.");
    let endpoint = values.server;
    if (!endpoint) {
      const reader = createInterface({ input: process.stdin, output: process.stdout });
      try { endpoint = await reader.question("Server IP:port: "); } finally { reader.close(); }
    }
    await new RoomProfiles().save(values.profile!, { server: endpoint, password: await hiddenInput("Server password (hidden): ") });
    console.log(`Saved profile '${values.profile}'. Activate it inside your agent; no session was connected by setup.`); return;
  }
  throw new Error("Unknown command. Run sideband --help.");
}
main().catch((error) => { process.stderr.write(`${error instanceof Error ? error.message : "Command failed."}\n`); process.exitCode = 1; });
