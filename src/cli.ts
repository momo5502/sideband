#!/usr/bin/env node
import { requireNodeVersion } from "./persistence.js";
import { parseArgs } from "node:util";
import { createInterface } from "node:readline/promises";
import { dirname, join, resolve } from "node:path";
import { RoomProfiles, stateDirectory } from "./room-profiles.js";
import { hiddenInput, terminalLogin } from "./terminal-login.js";
import { buildInfo } from "./update-runtime.js";
import { RuntimeUpdater } from "./updater.js";
import { forwardRuntime, supervise, UPDATE_RESTART } from "./update-supervisor.js";
import { LocalRun, openBrowser } from "./local-run.js";
import { ServerWorker, requestWorkerBootstrap } from "./server-worker.js";
async function main(): Promise<void> {
  requireNodeVersion();
  const command = process.argv[2];
  const supervised = process.env.SIDEBAND_SUPERVISED === "1", selected = process.env.SIDEBAND_RUNTIME_SELECTED === "1";
  // These are one-hop bootstrap markers, not settings for agents or their shell tools.
  delete process.env.SIDEBAND_SUPERVISED; delete process.env.SIDEBAND_RUNTIME_SELECTED;
  const embedded = command === "worker" && process.argv.includes("--embedded") ? await requestWorkerBootstrap() : undefined;
  if (["server", "run", "worker"].includes(command ?? "") && !supervised) { process.exitCode = await supervise(resolve(process.argv[1]!), process.argv.slice(2), stateDirectory, embedded); if (embedded && process.connected) process.disconnect(); return; }
  if (!["server", "run", "worker", "mcp", "managed-mcp", "managed-hook", "agent-runner", "terminal-agent", "--runtime-version"].includes(command ?? "") && !selected) {
    const code = await forwardRuntime(resolve(process.argv[1]!), process.argv.slice(2)); if (code !== undefined) { process.exitCode = code; return; }
  }
  if (command === "--version" || command === "version" || command === "--runtime-version") { const info = buildInfo(process.argv[1]!); console.log(`sideband ${info.version}${info.commit ? ` ${info.commit}` : ""}`); return; }
  if (["help", "--help", "-h"].includes(command ?? "") || (!command && (!process.stdin.isTTY || !process.stdout.isTTY))) {
    console.log(`Sideband

Quick start: sideband run
Local server + worker, foreground, localhost only. First run offers plugin installation.

  sideband run [--port 8765] [--status-port 8766] [--no-browser]
  sideband server [--host ADDRESS] [--port 8765] [--status-port 8766]
    [--no-worker] [--worker-name NAME] [--worker-directory PATH]
    [--credentials-file PATH] [--rotate-password]
    [--domain HOST] [--email ADDRESS] [--http-port 80] [--https-port 443] [--acme-staging]
  sideband worker [--profile NAME] [--name NAME] [--directory PATH]
    [--omp PATH] [--codex PATH] [--claude PATH] [--pi PATH]
  sideband install [--harness codex,claude,omp,pi | --all]
  sideband [chat] [--profile NAME] [--name NAME]
  sideband login HOST[:PORT] [--profile default]
  sideband configure [--profile default] [--server HOST[:PORT]]
  sideband mcp --harness codex|claude
  sideband --version | version
  sideband --help | help

run always binds 127.0.0.1. --no-browser prints a single-use browser login link.
server includes a worker by default; --no-worker disables it (--worker is an explicit alias).
server listens on all interfaces unless --host is given; credentials persist across restarts.
--domain enables automatic browser HTTPS; ACME options require --domain.
--worker-directory defaults to <state>/workspaces; --worker-name defaults to the machine name.
worker --directory defaults to <state>/workspaces; harness paths override detected executables.
install prompts in a terminal; --all selects detected harnesses; --harness selects explicitly.
login/configure use a hidden password prompt. Never pass passwords as arguments.
chat and worker select the saved default profile, or the sole profile; use --profile to override.
State: SIDEBAND_STATE_DIR or ~/.sideband. See README for all defaults and advanced setup.
Ctrl+C stops the server/worker; detached agents keep running. Rooms/history are ephemeral.`); return;
  }
  if (!command || command === "chat" || command.startsWith("--")) {
    const { values } = parseArgs({ args: process.argv.slice(command === "chat" ? 3 : 2),
      options: { profile: { type: "string" }, name: { type: "string" } } });
    await (await import("./terminal-chat.js")).terminalChat(values); return;
  }
  if (command === "server" || command === "run") {
    const local = command === "run";
    const { values } = parseArgs({ args: process.argv.slice(3), options: { host: { type: "string" }, port: { type: "string", default: "8765" },
      "status-port": { type: "string", default: "8766" }, "rotate-password": { type: "boolean", default: false }, "credentials-file": { type: "string" },
      domain: { type: "string" }, email: { type: "string" }, "acme-staging": { type: "boolean" }, "http-port": { type: "string" }, "https-port": { type: "string" }, worker: { type: "boolean" }, "no-worker": { type: "boolean" }, "no-browser": { type: "boolean" }, "worker-directory": { type: "string" }, "worker-name": { type: "string" } } });
    if (local) {
      const forbidden = Object.keys(values).filter(key => !["port", "status-port", "no-browser", "rotate-password"].includes(key) || key === "rotate-password" && values[key]);
      if (forbidden.length) throw new Error("sideband run is localhost-only. Use sideband server for networking and worker options.");
    } else if (values["no-browser"]) throw new Error("--no-browser applies to sideband run.");
    if (values.worker && values["no-worker"]) throw new Error("Use --no-worker or --worker, not both.");
    if (values["no-worker"] && (values["worker-directory"] !== undefined || values["worker-name"] !== undefined)) throw new Error("Worker options cannot be used with --no-worker.");
    const workerEnabled = !values["no-worker"];
    const host = local ? "127.0.0.1" : values.host;
    const port = Number(values.port); if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Invalid port.");
    const statusPort = Number(values["status-port"]); if (!Number.isInteger(statusPort) || statusPort < 0 || statusPort > 65535) throw new Error("Invalid status port.");
    if (port !== 0 && port === statusPort) throw new Error("HTTP status and HTTPS need different ports. Use --status-port to choose another port.");
    const credentialsFile = resolve(values["credentials-file"] ?? join(stateDirectory, "server-credentials.json"));
    if (!values.domain && [values.email, values["acme-staging"], values["http-port"], values["https-port"]].some(value => value !== undefined)) throw new Error("HTTPS certificate options require --domain.");
    const httpPort = Number(values["http-port"] ?? 80), httpsPort = Number(values["https-port"] ?? 443);
    if (values.domain) {
      if (![httpPort, httpsPort].every(value => Number.isInteger(value) && value >= 0 && value <= 65535)) throw new Error("Invalid HTTP/HTTPS port.");
      const ports = [port, statusPort, httpPort, httpsPort].filter(value => value !== 0);
      if (new Set(ports).size !== ports.length) throw new Error("Native, status, ACME HTTP and browser HTTPS listeners need different ports.");
      if (values.email !== undefined && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.email)) throw new Error("Invalid --email address.");
    }
    const localRun = local ? await LocalRun.claim(stateDirectory, !!values["no-browser"]) : undefined;
    if (local && !localRun) return;
    let server: import("./room-server.js").RoomServer;
    let localWorker: ServerWorker | undefined;
    let closing = false, restarting = false;
    const close = async () => {
      if (closing) return; closing = true;
      const remaining = server?.runningAgentCount ?? 0;
      try { await localWorker?.close(); await server?.close(); }
      finally { await localRun?.close(); if (process.connected) process.disconnect(); }
      if (local && !restarting) console.log(`Stopped server and worker. ${remaining} managed agent(s) last reported running; they will reconnect when this server starts again. Stop agents in the web panel before closing Sideband if you want them to exit.`);
    };
    const updater = process.send ? new RuntimeUpdater("server", resolve(process.argv[1]!), stateDirectory, async () => {
      const args = process.argv.slice(2).filter(value => value !== "--rotate-password");
      const set = (key: string, value: string) => { const i = args.findIndex(arg => arg === key || arg.startsWith(`${key}=`)); if (i < 0) args.push(key, value); else if (args[i]!.includes("=")) args[i] = `${key}=${value}`; else args[i + 1] = value; };
      if (!local) set("--credentials-file", credentialsFile); set("--port", String(server.port)); set("--status-port", String(server.statusPort));
      if (values.domain) { set("--https-port", String(server.nativePort)); set("--http-port", String(server.acmePort)); }
      restarting = true; process.send?.({ type: "sideband.restart", args }); process.exitCode = UPDATE_RESTART; await close();
    }) : undefined;
    process.on("message", (message: any) => { if (message?.type === "sideband.shutdown") void close(); });
    process.once("disconnect", () => { void close(); });
    process.once("SIGINT", () => { void close(); }); process.once("SIGTERM", () => { void close(); });
    try {
      await updater?.restore();
      if (closing) return;
      const build = updater?.build ?? buildInfo(process.argv[1]!);
      console.log(`Sideband server v${build.version} (${build.commit?.slice(0, 8) ?? "bootstrap"}) starting...`);
      const { RoomServer } = await import("./room-server.js"); server = await RoomServer.start({ host, port, statusPort, localMode: local,
        updater, credentialsFile, databaseFile: `${credentialsFile}.sqlite`, rotatePassword: values["rotate-password"], ...(values.domain ? { browserHttps: { domain: values.domain, directory: join(dirname(credentialsFile), "https"),
          httpPort, httpsPort, email: values.email, staging: values["acme-staging"], log: message => console.log(message) } } : {}) });
      if (closing) { await server.close(); return; }
      const browserUrl = `http://127.0.0.1:${server.statusPort}/chat`;
      if (localRun) {
        const profileName = await localRun.profile({ server: `127.0.0.1:${server.port}`, password: server.password });
        await localRun.ready(browserUrl, profileName);
        console.log(`Sideband is local to this machine.\nBrowser: ${browserUrl}\nKeep this terminal open. Ctrl+C stops the server and worker; agent sessions keep running.`);
        await localRun.offerPlugins();
        if (closing) return;
      } else {
        const address = server.browserUrl ? new URL(server.browserUrl).host : `<your-VPS-IP>:${server.port}`;
        console.log(`Sideband listening on ${host ?? "*"}:${server.nativePort}\n\nClient address: ${address}\nClient login: sideband login ${address}\nPassword: ${server.password}\n\nBrowser: ${server.browserUrl ?? `http://<your-VPS-IP>:${server.statusPort}`}/chat\nCredentials: ${credentialsFile}\nThe password and native TLS identity are reused on restart. Use --rotate-password to replace them.\nRooms and history disappear when the server stops.`);
        if (server.browserUrl) console.log(`Native agents and browsers share HTTPS port ${server.nativePort}. Existing ports ${server.port}/${server.statusPort} remain available.\nAutomatic certificates use Let's Encrypt. Setup and renewals require public port 80 to reach --http-port.`);
      }
      if (workerEnabled) {
        const workerHost = !host || ["0.0.0.0", "::"].includes(host) ? "127.0.0.1" : host;
        localWorker = new ServerWorker(resolve(process.argv[1]!), join(dirname(credentialsFile), "server-worker"), { profile: { server: `${workerHost.includes(":") ? `[${workerHost}]` : workerHost}:${server.port}`, password: server.password },
          directory: resolve(values["worker-directory"] ?? join(stateDirectory, "workspaces")), name: values["worker-name"] }); localWorker.start();
      }
      process.send?.({ type: "sideband.ready" });
      if (local) {
        const loginUrl = server.createLocalLogin();
        if (values["no-browser"]) console.log(`One-time browser login (single use, expires in 2 minutes): ${loginUrl}`);
        else await openBrowser(loginUrl).catch(() => console.error("Could not open the browser. Run sideband run --no-browser for a one-time login link."));
      }
    } catch (error) { const stopped = closing; await close(); if (stopped) return; if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") throw new Error("A Sideband port is already in use. Stop the other listener, or choose --port and --status-port. No connection was made to that listener."); throw error; }
    return;
  }
  if (command === "mcp") {
    const { values } = parseArgs({ args: process.argv.slice(3), options: { harness: { type: "string" } } });
    if (values.harness !== "codex" && values.harness !== "claude") throw new Error("Use --harness codex or --harness claude.");
    await (await import("./room-mcp.js")).runMcp(values.harness); return;
  }
  if (command === "install") {
    const { values } = parseArgs({ args: process.argv.slice(3), options: { harness: { type: "string", multiple: true }, all: { type: "boolean" } } });
    const { detectInstallHarnesses, installHarnessPlugin, selectedHarnesses } = await import("./plugin-install.js");
    if (values.all && values.harness) throw new Error("Use either --all or --harness, not both.");
    if (!values.all && !values.harness && (!process.stdin.isTTY || !process.stdout.isTTY)) throw new Error("Choose plugins explicitly: sideband install --harness codex,claude,omp,pi (or --all for detected harnesses).");
    const requested = values.harness ? selectedHarnesses(values.harness) : undefined;
    const detected = await detectInstallHarnesses(), available = detected.filter(item => item.version);
    let selected = requested ?? (values.all ? available.map(item => item.harness) : []);
    if (!values.harness && !values.all) {
      if (!available.length) throw new Error("No supported harness CLIs were detected. Install a harness and retry.");
      console.log("Installed harnesses:\n" + available.map((item, i) => `  ${i + 1}. ${item.harness}: ${item.version}`).join("\n"));
      const reader = createInterface({ input: process.stdin, output: process.stdout });
      try {
        const answer = (await reader.question("Install Sideband for which harnesses? Enter numbers separated by commas, all, or Enter to cancel: ")).trim();
        if (!answer) { console.log("Cancelled."); return; }
        if (answer.toLowerCase() === "all") selected = available.map(item => item.harness);
        else {
          const indexes = [...new Set(answer.split(/[\s,]+/))];
          if (indexes.some(value => !/^[1-9][0-9]*$/.test(value) || !available[Number(value) - 1])) throw new Error("Choose only numbers shown in the harness list.");
          selected = indexes.map(value => available[Number(value) - 1]!.harness);
        }
      } finally { reader.close(); }
    }
    if (!selected.length) throw new Error("No supported harness CLIs were detected.");
    for (const harness of selected) {
      const detectedHarness = detected.find(item => item.harness === harness)!;
      if (!detectedHarness.version) { console.error(`${harness}: ${detectedHarness.error}. Plugin was not installed.`); process.exitCode = 1; continue; }
      console.log(`${harness}: installing Sideband...`);
      const result = await installHarnessPlugin(harness); console.log(`${harness}: ${result.message}`);
      if (result.state === "failed") process.exitCode = 1;
    }
    return;
  }
  if (command === "worker") {
    const { values } = parseArgs({ args: process.argv.slice(3), options: { profile: { type: "string" }, name: { type: "string" }, omp: { type: "string" }, codex: { type: "string" }, claude: { type: "string" }, pi: { type: "string" }, directory: { type: "string" }, embedded: { type: "boolean" } } });
    const { name: profileName, profile } = embedded ? { name: undefined, profile: embedded.profile } : await new RoomProfiles().resolve(values.profile);
    const { Worker } = await import("./worker.js");
    let worker: import("./worker.js").Worker | undefined;
    let closing = false;
    const close = async () => { if (closing) return; closing = true; await worker?.close(); if (process.connected) process.disconnect(); };
    const updater = process.send ? new RuntimeUpdater("worker", resolve(process.argv[1]!), stateDirectory, async () => {
      const args = process.argv.slice(2); if (!embedded && !values.profile) args.push("--profile", profileName!);
      process.send?.({ type: "sideband.restart", args }); process.exitCode = UPDATE_RESTART; await close();
    }) : undefined;
    process.on("message", (message: any) => { if (message?.type === "sideband.shutdown") void close(); });
    process.once("disconnect", () => { void close(); });
    process.once("SIGINT", () => { void close(); }); process.once("SIGTERM", () => { void close(); });
    await updater?.restore();
    if (closing) return;
    const build = updater?.build ?? buildInfo(process.argv[1]!);
    console.log(`Sideband worker v${build.version} (${build.commit?.slice(0, 8) ?? "bootstrap"}) starting...`);
    worker = new Worker({ profile, updater, entry: resolve(process.argv[1]!), name: embedded?.name ?? values.name, root: embedded?.directory ?? values.directory, ...(values.omp ? { omp: { command: values.omp } } : {}), ...(values.codex ? { codex: { command: values.codex } } : {}), ...(values.claude ? { claude: { command: values.claude } } : {}), ...(values.pi ? { pi: { command: values.pi } } : {}),
      onError: error => console.error(`Worker connection: ${error.message}`),
      onConnection: change => {
        if (change.state === "on") { console.error("Worker connected and registered."); }
        else if (change.state === "reconnecting") console.error(`Worker disconnected; retrying in ${change.retryInMs! / 1000}s.`);
        else if (change.state === "disconnected") {
          console.error(`Worker cannot reconnect: ${change.error?.message}\nCheck the server address and proxy settings. If credentials changed, run sideband login again.`);
          process.exitCode = 1; void close();
        }
      } });
    await worker.start(); if (closing) return; process.send?.({ type: "sideband.ready" });
    console.log(`Sideband worker '${worker.machine.name}' started. Open /chat on your server and select New agent to launch a harness.\nAgent runners keep running when this worker stops. Stop agents from the web panel.`);
    return;
  }
  if (command === "managed-hook") { if (process.argv.length !== 4) throw new Error("Invalid managed hook launch."); await (await import("./managed-room-tools.js")).runManagedHook(process.argv[3]!); return; }
  if (command === "managed-mcp") { if (process.argv.length !== 4) throw new Error("Invalid managed MCP launch."); await (await import("./managed-room-tools.js")).runManagedMcp(process.argv[3]!); return; }
  if (command === "agent-runner") { await (await import("./agent-runner.js")).runAgentRunner(); return; }
  if (command === "terminal-agent") { if (process.argv.length !== 4) throw new Error("Invalid private terminal launch."); await (await import("./managed-terminal.js")).runTerminalAgent(process.argv[3]!); return; }
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
    console.log(`Saved profile '${values.profile}'. Ask your agent to join a room; it connects automatically.`); return;
  }
  throw new Error("Unknown command. Run sideband --help.");
}
main().catch((error) => { process.stderr.write(`${error instanceof Error ? error.message : "Command failed."}\n`); process.exitCode = 1; if (process.connected) process.disconnect(); });
