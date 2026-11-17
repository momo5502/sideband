import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";
import { spawn } from "node:child_process";
function available(command) {
    for (const directory of (process.env.PATH ?? "").split(delimiter))
        try {
            const path = join(directory, command);
            accessSync(path, constants.X_OK);
            return path;
        }
        catch { /* Try the next directory. */ }
    return undefined;
}
export function terminalLauncher() {
    if (process.platform === "win32")
        return process.env.SESSIONNAME?.toLowerCase() === "services" || process.env.USERNAME?.toUpperCase() === "SYSTEM" ? undefined : { kind: "window", command: join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe") };
    if (process.platform === "darwin")
        return { kind: "window", command: "/usr/bin/open" };
    if (process.env.DISPLAY || process.env.WAYLAND_DISPLAY) {
        for (const [name, prefix] of [["x-terminal-emulator", "-e"], ["gnome-terminal", "--"], ["konsole", "-e"], ["xterm", "-e"]]) {
            const command = available(name);
            if (command)
                return { kind: "window", command, prefix: [prefix] };
        }
    }
    const tmux = available("tmux");
    return tmux ? { kind: "tmux", command: tmux } : undefined;
}
const ps = (text) => `'${text.replace(/'/g, "''")}'`;
export const shellQuote = (text) => `'${text.replace(/'/g, `'"'"'`)}'`;
/** Only trusted executable/script paths enter launcher syntax; prompts/names never enter it. */
export function launchTerminal(launcher, script, id) {
    let args;
    if (process.platform === "win32") {
        const code = `$ProgressPreference='SilentlyContinue'; Start-Process -FilePath $env:ComSpec -ArgumentList @('/d','/c',${ps(`""${script}""`)}) -WindowStyle Normal`;
        args = ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(code, "utf16le").toString("base64")];
    }
    else if (process.platform === "darwin")
        args = ["-a", "Terminal", script];
    else if (launcher.kind === "tmux")
        args = ["new-session", "-d", "-s", `sb-${id}`, "/bin/sh", script];
    else
        args = [...(launcher.prefix ?? ["-e"]), script];
    return spawn(launcher.command, args, { windowsHide: true, stdio: ["ignore", "ignore", "pipe"], detached: process.platform !== "win32" });
}
//# sourceMappingURL=terminal-launch.js.map