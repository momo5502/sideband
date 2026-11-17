import { spawn, type ChildProcess } from "node:child_process";

/** Forced fallback after graceful harness shutdown, including still-running tool subprocesses. */
export function terminateTree(child: ChildProcess, processGroup = true): void {
  const pid = child.pid; if (!pid) return;
  if (process.platform === "win32") {
    const killer = spawn("taskkill.exe", ["/pid", String(pid), "/t", "/f"], { windowsHide: true, stdio: "ignore" });
    killer.on("error", () => { child.kill(); }); killer.unref();
  } else if (processGroup) {
    // Harness/Git processes are launched as their own process groups on Unix.
    try { process.kill(-pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
  } else {
    // Interactive children share their terminal's foreground group. Kill only their subtree.
    const listing = spawn("ps", ["-A", "-o", "pid=,ppid="], { stdio: ["ignore", "pipe", "ignore"] });
    let output = "";
    listing.stdout.setEncoding("utf8"); listing.stdout.on("data", chunk => { output += chunk; if (output.length > 1024 * 1024) listing.kill(); });
    listing.once("error", () => child.kill("SIGKILL"));
    listing.once("close", () => {
      const entries = output.split("\n").map(line => line.trim().split(/\s+/).map(Number));
      const selected = new Set([pid]), descendants: number[] = [];
      for (let pass = 0; pass < entries.length; pass++) {
        let added = false;
        for (const [candidate, parent] of entries) if (candidate && parent && selected.has(parent) && !selected.has(candidate)) { selected.add(candidate); descendants.push(candidate); added = true; }
        if (!added) break;
      }
      for (const candidate of descendants.reverse()) try { process.kill(candidate, "SIGKILL"); } catch { /* Already exited. */ }
      child.kill("SIGKILL");
    });
  }
}
