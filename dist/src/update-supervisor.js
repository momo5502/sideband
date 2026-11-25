import { STARTUP_TIMEOUT_MS, SHUTDOWN_TIMEOUT_MS } from "./timeouts.js";
import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { activeRuntime, privateJson, runtimeDirectory, runtimeEntry } from "./update-runtime.js";
import { stateDirectory } from "./room-profiles.js";
export const UPDATE_RESTART = 75;
/** New public invocations use the selected runtime; existing runner entry paths stay immutable. */
export async function forwardRuntime(entry, args, directory = stateDirectory) {
    const active = await activeRuntime(directory);
    if (!active)
        return;
    const selected = runtimeEntry(directory, active.commit);
    if (resolve(selected) === realpathSync(entry))
        return;
    return new Promise((resolvePromise, reject) => {
        const child = spawn(process.execPath, [selected, ...args], { stdio: "inherit", windowsHide: true, env: { ...process.env, SIDEBAND_RUNTIME_SELECTED: "1" } });
        const stop = () => { child.kill(); };
        process.on("SIGINT", stop);
        process.on("SIGTERM", stop);
        const clean = () => { process.off("SIGINT", stop); process.off("SIGTERM", stop); };
        child.once("error", error => { clean(); reject(error); });
        child.once("exit", code => { clean(); resolvePromise(code ?? 1); });
    });
}
/** The stable bootstrap stays in the original console; per-agent helpers are never supervised. */
export async function supervise(entry, args, directory = stateDirectory, bootstrap) {
    const base = realpathSync(entry);
    let switched = false, stopping = false, attemptedRollback = false;
    let stopCurrent;
    const parentStop = () => { stopping = true; stopCurrent?.(); };
    const parentMessage = (message) => { if (message?.type === "sideband.shutdown")
        parentStop(); };
    process.on("message", parentMessage);
    process.once("disconnect", parentStop);
    try {
        while (true) {
            const role = args[0] === "server" ? "server" : "worker";
            const active = await activeRuntime(directory, role);
            const selected = active ? runtimeEntry(directory, active.commit) : base;
            if (stopping)
                return 0;
            let ready = false, requested = false;
            const child = spawn(process.execPath, [selected, ...args], { stdio: ["inherit", "inherit", "inherit", "ipc"], windowsHide: true,
                env: { ...process.env, SIDEBAND_SUPERVISED: "1", SIDEBAND_STATE_DIR: resolve(directory) } });
            let stopTimer;
            const stop = () => { stopping = true; if (child.connected)
                child.send({ type: "sideband.shutdown" });
            else
                child.kill(); stopTimer ??= setTimeout(() => child.kill(), SHUTDOWN_TIMEOUT_MS); };
            stopCurrent = stop;
            process.on("SIGINT", stop);
            process.on("SIGTERM", stop);
            const timer = switched ? setTimeout(() => { if (!ready)
                child.kill(); }, STARTUP_TIMEOUT_MS) : undefined;
            let nextArgs = args;
            child.on("message", (message) => {
                if (message?.type === "sideband.worker.bootstrap.request" && bootstrap && child.connected)
                    child.send({ type: "sideband.worker.bootstrap", value: bootstrap });
                if (message?.type === "sideband.ready") {
                    ready = true;
                    if (timer)
                        clearTimeout(timer);
                    if (active)
                        void privateJson(join(runtimeDirectory(directory), "active.json"), active).catch(() => { });
                    if (bootstrap && process.connected)
                        process.send?.({ type: "sideband.worker.ready" });
                }
                if (message?.type === "sideband.restart") {
                    requested = true;
                    if (Array.isArray(message.args) && message.args[0] === args[0] && message.args.every((value) => typeof value === "string"))
                        nextArgs = message.args;
                }
            });
            const result = await new Promise(resolvePromise => {
                child.once("error", error => resolvePromise({ code: 1, error: error.message }));
                child.once("exit", code => resolvePromise({ code: code ?? (stopping ? 0 : 1) }));
            });
            if (timer)
                clearTimeout(timer);
            if (stopTimer)
                clearTimeout(stopTimer);
            process.off("SIGINT", stop);
            process.off("SIGTERM", stop);
            stopCurrent = undefined;
            if (stopping)
                return result.code;
            if (requested && result.code === UPDATE_RESTART) {
                args = nextArgs;
                switched = true;
                attemptedRollback = false;
                continue;
            }
            if (!ready && switched && !attemptedRollback && active) {
                attemptedRollback = true;
                await privateJson(join(runtimeDirectory(directory), `${role}-active.json`), active.previous ? { commit: active.previous, previous: null } : {});
                const status = join(runtimeDirectory(directory), `${role}-update.json`);
                let previous = {};
                try {
                    previous = JSON.parse(await readFile(status, "utf8"));
                }
                catch { /* No saved attempt. */ }
                await privateJson(status, { target: active.commit, ...(previous.attempt ? { attempt: previous.attempt } : {}), phase: "failed", message: "The new runtime did not become ready. The previous runtime was restored.", plugins: previous.plugins ?? [], at: Date.now() });
                console.error("Sideband update failed to start; restoring the previous runtime.");
                continue;
            }
            if (result.error)
                console.error(result.error);
            return result.code;
        }
    }
    finally {
        process.off("message", parentMessage);
        process.off("disconnect", parentStop);
    }
}
//# sourceMappingURL=update-supervisor.js.map