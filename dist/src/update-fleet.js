import { setTimeout as sleep } from "node:timers/promises";
export class UpdateFleet {
    updater;
    machines;
    updateWorker;
    latest;
    state;
    changed = () => { };
    abort = new AbortController();
    constructor(updater, machines, updateWorker, latest = () => updater.latest()) {
        this.updater = updater;
        this.machines = machines;
        this.updateWorker = updateWorker;
        this.latest = latest;
        this.state = { current: updater.build, checking: false, available: false, phase: "idle", message: "Check for updates to Sideband.", workers: [] };
        updater.onChange(() => { this.state.message = updater.state.message; if (updater.state.phase === "failed")
            this.state.phase = "failed"; this.changed(); });
        if (updater.state.phase === "done" || updater.state.phase === "failed") {
            this.state.phase = updater.state.phase;
            this.state.message = updater.state.message;
        }
    }
    onChange(listener) { this.changed = listener; }
    close() { this.abort.abort(); this.changed = () => { }; }
    async check() {
        if (this.state.checking || this.state.phase === "workers" || this.state.phase === "server")
            throw new Error("An update is already running.");
        this.state.checking = true;
        this.changed();
        try {
            this.state.latest = await this.latest();
            const target = this.state.latest.commit;
            this.state.available = this.updater.build.commit !== target || this.machines().some(machine => machine.online && (machine.build?.commit !== target || machine.update?.plugins.some(plugin => plugin.state === "failed")));
            this.state.message = this.state.available ? "An update is available." : "Sideband is up to date.";
            return this.state;
        }
        finally {
            this.state.checking = false;
            this.changed();
        }
    }
    start() {
        if (!this.state.latest)
            throw new Error("Check for updates first.");
        if (this.state.checking || this.state.phase === "workers" || this.state.phase === "server")
            throw new Error("An update is already running.");
        const target = this.state.latest.commit;
        this.state.phase = "workers";
        this.state.message = "Updating workers and their installed Sideband plugins";
        this.state.workers = this.machines().map(machine => {
            const current = machine.build?.commit === target && !machine.update?.plugins.some(plugin => plugin.state === "failed");
            return { id: machine.id, name: machine.name, state: !machine.online ? "skipped" : current ? "current" : !machine.updater ? "unsupported" : "pending",
                message: !machine.online ? "Offline; update when connected." : current ? "Already on this version." : !machine.updater ? "Install the updater-enabled worker manually once." : "Waiting" };
        });
        this.changed();
        void this.rollout(target).catch(error => { this.state.phase = "failed"; this.state.message = error instanceof Error ? error.message : "Update failed."; this.changed(); });
        return { accepted: true };
    }
    async rollout(target) {
        await Promise.all(this.state.workers.filter(row => row.state === "pending").map(async (row) => {
            try {
                const accepted = await this.updateWorker(row.id, target);
                if (!accepted?.attempt)
                    throw new Error("Worker did not identify its update attempt. Update it manually once.");
                const deadline = Date.now() + 20 * 60_000;
                while (true) {
                    const machine = this.machines().find(machine => machine.id === row.id);
                    this.abort.signal.throwIfAborted();
                    const current = machine?.update?.attempt === accepted.attempt && machine.update.target === target;
                    if (current && machine?.online && machine.build?.commit === target && machine.update?.phase === "done") {
                        row.state = "done";
                        row.message = machine.update.message;
                        break;
                    }
                    if (current && machine?.update?.phase === "failed")
                        throw new Error(machine.update.message);
                    if (Date.now() > deadline)
                        throw new Error("Worker update timed out. Check its console before retrying.");
                    row.state = current ? machine.update.phase : "reconnecting";
                    row.message = current ? machine.update.message : "Waiting for the worker to reconnect";
                    this.changed();
                    await sleep(500, undefined, { signal: this.abort.signal });
                }
            }
            catch (error) {
                row.state = "failed";
                row.message = error instanceof Error ? error.message : "Worker update failed.";
            }
            this.changed();
        }));
        this.abort.signal.throwIfAborted();
        if (this.state.workers.some(row => row.state === "failed" || row.state === "unsupported"))
            throw new Error("Some workers could not update. Resolve the listed errors and retry; the server was not restarted.");
        if (this.updater.build.commit === target) {
            this.state.phase = "done";
            this.state.message = "All connected machines are up to date.";
            this.state.available = false;
            this.changed();
            return;
        }
        this.state.phase = "server";
        this.state.message = "Workers finished. Updating the server";
        this.changed();
        this.updater.start(target);
    }
}
//# sourceMappingURL=update-fleet.js.map