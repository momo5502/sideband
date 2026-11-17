import { spawn, type ChildProcess } from "node:child_process";

/** Forced fallback after graceful harness shutdown, including still-running tool subprocesses. */
export function terminateTree(child: ChildProcess): void {
  const pid = child.pid; if (!pid) return;
  if (process.platform === "win32") {
    const killer = spawn("taskkill.exe", ["/pid", String(pid), "/t", "/f"], { windowsHide: true, stdio: "ignore" });
    killer.on("error", () => { child.kill(); }); killer.unref();
  } else {
    // Harness/Git processes are launched as their own process groups on Unix.
    try { process.kill(-pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
  }
}
