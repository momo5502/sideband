import { randomUUID, createHash } from "node:crypto";
import { basename, join } from "node:path";
import { mkdir, open, rename, unlink, readdir, lstat, readFile } from "node:fs/promises";
import { processStamp } from "./persistence.js";
import { execFile } from "node:child_process";
import { REQUEST_TIMEOUT_MS } from "./timeouts.js";
import { hostname, homedir } from "node:os";
import { stateDirectory } from "./room-profiles.js";
import { PluginControl, pluginEndpoint } from "./plugin-control.js";
export const presenceDirectory = process.env.SIDEBAND_PRESENCE_DIR ?? join(stateDirectory, "presence");
export const PRESENCE_TTL_MS = 90_000;
const hostScope = createHash("sha256").update(JSON.stringify([hostname(), homedir()])).digest("hex");
export const presenceKey = (harness, session) => createHash("sha256").update(`${hostScope}\0${harness}\0${session}`).digest("hex");
const alive = (pid) => { try {
    process.kill(pid, 0);
    return true;
}
catch {
    return false;
} };
let ownStamp;
const verified = new Map();
/** Public rows contain metadata only. Control credentials stay in the private local file. */
export class PluginPresence {
    harness;
    directory;
    command;
    options;
    file;
    born = Date.now();
    rows = [];
    timer;
    writing;
    dirty = false;
    closed = false;
    stamp;
    abort = new AbortController();
    sessions = new Map();
    control;
    endpoint;
    constructor(harness, directory = presenceDirectory, command, options) {
        this.harness = harness;
        this.directory = directory;
        this.command = command;
        this.options = options;
        this.file = join(directory, `${process.pid}-${randomUUID()}.json`);
    }
    replace(sessions) {
        if (this.closed)
            return;
        this.sessions = new Map(sessions.slice(0, 128).map(session => [presenceKey(this.harness, session.session), session.session]));
        this.rows = sessions.slice(0, 128).map(session => {
            const workspace = session.workspace ? basename(session.workspace.replace(/\\/g, "/")).slice(0, 128) : undefined;
            const name = session.name?.replace(/[\x00-\x1f]/g, " ").slice(0, 128) || ({ omp: "oh-my-pi", pi: "PI", claude: "Claude", codex: "Codex" })[this.harness];
            return { key: presenceKey(this.harness, session.session), harness: this.harness, name, pid: process.pid, createdAt: session.createdAt ?? this.born, ...(workspace ? { workspace } : {}) };
        });
        if (!this.timer) {
            this.timer = setInterval(() => this.queue(), 15000);
            this.timer.unref();
        }
        this.queue();
    }
    queue() {
        if (this.closed)
            return;
        this.dirty = true;
        if (this.writing)
            return;
        this.writing = (async () => {
            // Do not block harness startup on this auxiliary process or filesystem I/O.
            const stamp = await (this.stamp ??= ownStamp ? Promise.resolve(ownStamp) : processStamp(process.pid, this.abort.signal).then(value => { if (value)
                ownStamp = value; return value; }));
            if (!stamp) {
                this.stamp = undefined;
                this.dirty = false;
                return;
            }
            if (this.command && !this.control && !this.closed) {
                this.control = new PluginControl(async (request) => {
                    const session = this.sessions.get(request.key);
                    if (this.closed || !session)
                        throw new Error("This session has changed or closed. Select it again before sending.");
                    if (request.action === "reload") {
                        if (!this.options || this.harness !== "pi")
                            throw new Error("This plugin requires a manual restart.");
                        return { queued: this.options.canReload?.() ?? true };
                    }
                    return this.command(session, request);
                }, request => {
                    if (request.action === "reload" && !this.closed && this.sessions.has(request.key))
                        this.options?.reload();
                });
                try {
                    this.endpoint = { ...await this.control.start(), ...(this.options && this.harness === "pi" ? { reload: true, version: this.options.version } : {}) };
                }
                catch {
                    await this.control.close();
                }
            }
            while (this.dirty && !this.closed) {
                this.dirty = false;
                if (!this.rows.length) {
                    await unlink(this.file).catch(() => { });
                    continue;
                }
                await mkdir(this.directory, { recursive: true, mode: 0o700 });
                const temporary = `${this.file}.${randomUUID()}.tmp`, handle = await open(temporary, "wx", 0o600);
                try {
                    const frame = { version: 1, pid: process.pid, stamp, at: Date.now(), sessions: this.rows, ...(this.endpoint ? { control: this.endpoint } : {}) };
                    await handle.writeFile(JSON.stringify(frame));
                    await handle.close();
                    if (!this.closed)
                        await rename(temporary, this.file);
                }
                finally {
                    await handle.close().catch(() => { });
                    await unlink(temporary).catch(() => { });
                }
            }
        })().catch(() => { }).finally(() => { this.writing = undefined; if (this.dirty && !this.closed)
            this.queue(); });
    }
    async idle() { await this.writing; }
    async close() { this.closed = true; this.abort.abort(); if (this.timer)
        clearInterval(this.timer); await this.writing; await this.control?.close(); await unlink(this.file).catch(() => { }); }
}
async function reportedProcessStamps(pids, signal) {
    if (process.platform === "linux")
        return new Map(await Promise.all(pids.map(async (pid) => [pid, await processStamp(pid, signal)])));
    if (!pids.length)
        return new Map();
    const command = process.platform === "win32" ? "powershell.exe" : "ps";
    const args = process.platform === "win32" ? ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", `Get-Process -Id ${pids.join(",")} -ErrorAction SilentlyContinue | ForEach-Object { try { "$($_.Id) $($_.StartTime.ToUniversalTime().Ticks)" } catch {} }`]
        : ["-p", pids.join(","), "-o", "pid=,lstart="];
    const output = await new Promise((resolve, reject) => execFile(command, args, { signal, windowsHide: true, timeout: REQUEST_TIMEOUT_MS, maxBuffer: 128 * 1024, env: { ...process.env, LC_ALL: "C", TZ: "UTC" } }, (error, stdout) => error && !stdout ? reject(new Error("Could not verify plugin processes.")) : resolve(stdout)));
    return new Map(output.split(/\r?\n/).flatMap(line => { const match = /^\s*(\d+)\s+(.+?)\s*$/.exec(line); return match ? [[Number(match[1]), match[2]]] : []; }));
}
/** Worker reads only this private registry, not arbitrary processes or session histories. */
export async function readPluginPresence(directory = presenceDirectory, verify, signal, endpoints) {
    for (const [pid, value] of verified)
        if (Date.now() - value.at > 120000 || !alive(pid))
            verified.delete(pid);
    let entries;
    try {
        entries = await readdir(directory, { withFileTypes: true });
    }
    catch (error) {
        if (error.code === "ENOENT")
            return [];
        throw new Error("Could not read plugin presence.");
    }
    const result = new Map(), frames = [];
    for (const entry of entries.filter(entry => entry.isFile() && /^\d+-[a-f0-9-]{36}\.json$/.test(entry.name)).slice(0, 2048)) {
        try {
            const file = join(directory, entry.name), info = await lstat(file);
            if (!info.isFile() || info.isSymbolicLink() || info.size > 128 * 1024)
                continue;
            const frame = JSON.parse(await readFile(file, "utf8"));
            if (frame.version === 1 && Number.isFinite(frame.at) && Date.now() - frame.at > PRESENCE_TTL_MS * 4 && Date.now() - info.mtimeMs > PRESENCE_TTL_MS * 4) {
                await unlink(file).catch(() => { });
                continue;
            }
            if (frame.version !== 1 || !Number.isSafeInteger(frame.pid) || frame.pid < 1 || !Number.isFinite(frame.at) || Date.now() - frame.at > PRESENCE_TTL_MS || frame.at > Date.now() + 30000 || !Array.isArray(frame.sessions) || frame.sessions.length > 128 || typeof frame.stamp !== "string" || !frame.stamp || frame.stamp.length > 128 || !alive(frame.pid))
                continue;
            frames.push(frame);
        }
        catch { /* Incomplete, stale or incompatible metadata is not a running session. */ }
    }
    const pids = [...new Set(frames.filter(frame => frame.stamp).map(frame => frame.pid))];
    let stamps;
    if (verify)
        stamps = new Map(await Promise.all(pids.map(async (pid) => [pid, await verify(pid)])));
    else {
        const changed = pids.filter(pid => !verified.has(pid) || Date.now() - verified.get(pid).at > 60000 || frames.some(frame => frame.pid === pid && frame.stamp !== verified.get(pid).stamp));
        for (const pid of changed)
            verified.delete(pid);
        for (const [pid, stamp] of await reportedProcessStamps(changed, signal))
            if (stamp)
                verified.set(pid, { stamp, at: Date.now() });
        stamps = new Map(pids.map(pid => [pid, verified.get(pid)?.stamp]));
    }
    for (const frame of frames.sort((a, b) => b.at - a.at)) {
        if (frame.stamp && stamps.get(frame.pid) !== frame.stamp)
            continue;
        for (const row of frame.sessions)
            try {
                const session = discoveredSession(row);
                if (session.pid !== frame.pid)
                    continue;
                if (!result.has(session.key)) {
                    const endpoint = pluginEndpoint(frame.control);
                    delete session.interactive;
                    if (endpoint && ["pi", "omp"].includes(session.harness))
                        session.interactive = true;
                    result.set(session.key, session);
                    if (endpoint && session.interactive)
                        endpoints?.set(session.key, endpoint);
                }
                if (result.size >= 128)
                    return [...result.values()];
            }
            catch { /* A bad row cannot suppress the other sessions. */ }
    }
    return [...result.values()];
}
export function discoveredSession(input) {
    const v = input;
    if (!v || typeof v !== "object" || Object.keys(v).some(key => !["key", "harness", "name", "pid", "createdAt", "workspace", "interactive"].includes(key)) || !/^[a-f0-9]{64}$/.test(v.key) || !["omp", "pi", "claude", "codex"].includes(v.harness) || typeof v.name !== "string" || !v.name || v.name.length > 128 || /[\x00-\x1f]/.test(v.name) || !Number.isSafeInteger(v.pid) || v.pid < 1 || !Number.isFinite(v.createdAt) || v.interactive !== undefined && typeof v.interactive !== "boolean" || v.workspace !== undefined && (typeof v.workspace !== "string" || v.workspace.length > 128 || /[\/\\\x00-\x1f]/.test(v.workspace)))
        throw new Error("Invalid discovered session.");
    return { key: v.key, harness: v.harness, name: v.name, pid: v.pid, createdAt: v.createdAt, ...(v.workspace ? { workspace: v.workspace } : {}), ...(v.interactive ? { interactive: true } : {}) };
}
//# sourceMappingURL=plugin-presence.js.map