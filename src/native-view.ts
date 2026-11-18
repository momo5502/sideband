import { createServer, type Socket } from "node:net";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { readLocal, writeLocal } from "./local-wire.js";
import { privateJson } from "./update-runtime.js";
import { launchTerminal, shellQuote, terminalLauncher } from "./terminal-launch.js";
import type { Executable, OmpHost } from "./managed-omp.js";
import { consoleInput } from "./console-input.js";
import { runUpdateCommand } from "./update-runtime.js";

/** A real native TUI window; Sideband observes lifecycle without emulating a terminal. */
export class NativeView {
  private owner?: Socket;
  private ownerPid?: number;
  private tmux?: { command: string; target: string };
  private readonly sockets = new Set<Socket>();
  private readonly token = randomBytes(32).toString("base64url");
  private readonly server = createServer(socket => {
    if (this.sockets.size >= 8) { socket.destroy(); return; }
    this.sockets.add(socket); const timer = setTimeout(() => socket.destroy(), 5000);
    socket.once("close", () => { clearTimeout(timer); this.sockets.delete(socket); if (this.owner === socket && !this.stopped) this.closed(); });
    readLocal(socket, packet => {
      if (socket !== this.owner) {
        if (this.owner || packet.type !== "hello" || packet.role !== "owner" || typeof packet.token !== "string" || packet.token.length !== this.token.length || !timingSafeEqual(Buffer.from(packet.token), Buffer.from(this.token))) { socket.destroy(); return; }
        this.owner = socket; if (Number.isSafeInteger(packet.pid) && packet.pid > 0) this.ownerPid = packet.pid; clearTimeout(timer); writeLocal(socket, { type: "start", ...this.runtime }); void unlink(this.bootstrap).catch(() => {}); return;
      }
      if (packet.type === "spawned") this.ready?.resolve();
      if (packet.type === "exit" && !this.stopped) this.closed(packet.code ? new Error(`Terminal exited (${packet.code}).`) : undefined);
    });
  });
  private ready?: { resolve(): void; reject(error: Error): void };
  private stopped = false;
  private closing?: Promise<void>;
  private exited = false;
  private bootstrap = "";
  private script = "";
  private runtime?: object;
  constructor(private readonly directory: string, private readonly entry: string, private readonly host: OmpHost, private readonly onExit: (error?: Error) => void) {}
  private closed(error?: Error): void {
    if (this.exited) return; this.exited = true; this.ready?.reject(error ?? new Error("Terminal closed during startup.")); this.onExit(error);
    void this.cleanup();
  }
  async start(executable: Executable, args: string[], cwd: string, env: NodeJS.ProcessEnv = process.env): Promise<void> {
    const launcher = terminalLauncher(); if (!launcher) throw new Error("No local terminal launcher is available. Choose Background mode.");
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await new Promise<void>((resolve, reject) => { this.server.once("error", reject); this.server.listen(0, "127.0.0.1", () => { this.server.off("error", reject); resolve(); }); });
    const id = randomUUID(); this.bootstrap = join(this.directory, `view-${id}.json`); this.script = join(this.directory, `view-${id}${process.platform === "win32" ? ".cmd" : process.platform === "darwin" ? ".command" : ".sh"}`);
    if (launcher.kind === "tmux") this.tmux = { command: launcher.command, target: `sb-${id}` };
    this.runtime = { executable: executable.command, args: [...(executable.args ?? []), ...args], cwd, env };
    await privateJson(this.bootstrap, { port: (this.server.address() as { port: number }).port, token: this.token });
    const command = [process.execPath, realpathSync(this.entry), "terminal-agent", this.bootstrap];
    if (process.platform === "win32" && command.some(value => /[\r\n%!"]/.test(value))) throw new Error("Unsupported characters in the native terminal path.");
    await writeFile(this.script, process.platform === "win32" ? `@echo off\r\n@chcp 65001 >nul\r\nsetlocal DisableDelayedExpansion\r\n${command.map(value => `"${value}"`).join(" ")}\r\n` : `#!/bin/sh\nexec ${command.map(shellQuote).join(" ")}\n`, { flag: "wx", mode: 0o700 });
    const ready = new Promise<void>((resolve, reject) => { this.ready = { resolve, reject }; });
    const timer = setTimeout(() => this.ready?.reject(new Error("Native terminal did not start within 60 seconds. Check desktop access.")), 60000);
    try {
      const child = launchTerminal(launcher, this.script, id); child.on("error", error => this.ready?.reject(error)); child.stderr?.on("data", chunk => this.host.event("terminal", String(chunk))); child.unref();
      this.host.event("terminal", launcher.kind === "tmux" ? `Attach locally: tmux attach -t sb-${id}` : "Opening the native harness terminal on this machine.");
      await ready;
    } finally { clearTimeout(timer); }
  }
  private async cleanup(): Promise<void> { for (const file of [this.bootstrap, this.script]) if (file) await unlink(file).catch(() => {}); }
  async input(text: string, escape = false): Promise<void> {
    if (this.stopped || this.exited || !this.owner || this.owner.destroyed) throw new Error("The native terminal is disconnected.");
    if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text) || text.length > 16000) throw new Error("Terminal input cannot contain control characters.");
    if (process.platform === "win32" && this.ownerPid) { await consoleInput(this.ownerPid, text, escape); return; }
    if (!this.tmux) throw new Error("Native input requires Windows or tmux. Choose Background mode.");
    const { command, target } = this.tmux;
    if (!escape) await runUpdateCommand(command, ["send-keys", "-t", target, "-l", "--", `\x1b[200~${text.replace(/\r\n?/g, "\n")}\x1b[201~`], { timeout: 5000 });
    await runUpdateCommand(command, ["send-keys", "-t", target, escape ? "Escape" : "Enter"], { timeout: 5000 });
  }
  stop(): Promise<void> { return this.closing ??= this.close(); }
  private async close(): Promise<void> {
    this.stopped = true; this.ready?.reject(new Error("Native terminal stopped."));
    if (this.owner && !this.owner.destroyed) await new Promise<void>(resolve => {
      const timer = setTimeout(resolve, 5000); this.owner!.once("close", () => { clearTimeout(timer); resolve(); }); writeLocal(this.owner, { type: "kill" }); this.owner!.end();
    });
    for (const socket of this.sockets) socket.destroy(); await new Promise<void>(resolve => this.server.close(() => resolve())); await this.cleanup();
  }
}
