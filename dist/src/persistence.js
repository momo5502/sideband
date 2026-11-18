import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { chmodSync, closeSync, mkdirSync, openSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { REQUEST_TIMEOUT_MS } from "./timeouts.js";
export function requireNodeVersion(version = process.versions.node) {
    const [major = 0, minor = 0] = version.split(".").map(Number);
    if (!Number.isSafeInteger(major) || !Number.isSafeInteger(minor) || major < 22 || major === 22 && minor < 13 || major === 23 && minor < 4)
        throw new Error("Sideband requires Node.js 22.13 or newer for SQLite persistence. Upgrade Node before updating Sideband.");
}
let sqlite;
function loadSqlite() {
    requireNodeVersion();
    return sqlite ??= (async () => {
        const original = process.emitWarning;
        // Suppress only Node 22's SQLite maturity notice, during the builtin's load.
        // Other experimental/deprecation warnings retain their normal behaviour.
        const filtered = function (...args) {
            if (typeof args[0] === "string" && args[0] === "SQLite is an experimental feature and might change at any time" && args[1] === "ExperimentalWarning")
                return;
            Reflect.apply(original, this, args);
        };
        process.emitWarning = filtered;
        try {
            return await import("node:sqlite");
        }
        finally {
            if (process.emitWarning === filtered)
                process.emitWarning = original;
        }
    })();
}
const thisReader = (db) => Number(db.prepare("SELECT min_reader FROM schema_compat WHERE id=1").get().min_reader);
const busy = (error) => /database (?:is )?(?:locked|busy)|SQLITE_BUSY|SQLITE_LOCKED/i.test(error instanceof Error ? error.message : "");
/** Small versioned metadata store. No transcripts, output buffers or server passwords. */
export class Registry {
    db;
    scope;
    pending = Promise.resolve();
    closed = false;
    constructor(db, scope) {
        this.db = db;
        this.scope = scope;
    }
    static async open(file, scope) {
        const { DatabaseSync } = await loadSqlite();
        if (file !== ":memory:") {
            file = resolve(file);
            mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
            // On Windows these files inherit the worker/server account's directory ACL.
            closeSync(openSync(file, "a", 0o600));
            chmodSync(file, 0o600);
        }
        const db = new DatabaseSync(file), registry = new Registry(db, scope);
        try {
            db.exec("PRAGMA busy_timeout=250");
            const version = Number(db.prepare("PRAGMA user_version").get().user_version);
            if (version > 1) {
                let reader = Infinity;
                try {
                    reader = Number(db.prepare("SELECT min_reader FROM schema_compat WHERE id=1").get().min_reader);
                }
                catch { /* Unknown future format. */ }
                if (reader > 1)
                    throw new Error(`Sideband database schema ${version} requires a newer runtime. Reinstall that runtime; the database was not changed.`);
            }
            await registry.retry(() => { db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL"); });
            await registry.change(() => {
                const lockedVersion = Number(db.prepare("PRAGMA user_version").get().user_version);
                if (lockedVersion > 1) {
                    const reader = thisReader(db);
                    if (reader > 1)
                        throw new Error("This Sideband database requires a newer runtime; no schema changes were made.");
                    return;
                }
                const application = Number(db.prepare("PRAGMA application_id").get().application_id);
                if (application !== 0 && application !== 0x53424431)
                    throw new Error("This database does not belong to Sideband.");
                db.exec("CREATE TABLE IF NOT EXISTS records (scope TEXT NOT NULL, kind TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(scope,kind,id)); CREATE TABLE IF NOT EXISTS schema_compat (id INTEGER PRIMARY KEY CHECK(id=1), min_reader INTEGER NOT NULL); INSERT OR IGNORE INTO schema_compat VALUES(1,1); PRAGMA application_id=1396851761; PRAGMA user_version=1");
            });
            return registry;
        }
        catch (error) {
            db.close();
            throw error;
        }
    }
    get(kind, id) {
        const row = this.db.prepare("SELECT data FROM records WHERE scope=? AND kind=? AND id=?").get(this.scope, kind, id);
        return row ? JSON.parse(row.data) : undefined;
    }
    all(kind) {
        return this.db.prepare("SELECT id,data FROM records WHERE scope=? AND kind=? ORDER BY id").all(this.scope, kind).map(row => [row.id, JSON.parse(row.data)]);
    }
    put(kind, id, value) {
        this.db.prepare("INSERT INTO records(scope,kind,id,data) VALUES(?,?,?,?) ON CONFLICT(scope,kind,id) DO UPDATE SET data=excluded.data").run(this.scope, kind, id, JSON.stringify(value));
    }
    remove(kind, id) { this.db.prepare("DELETE FROM records WHERE scope=? AND kind=? AND id=?").run(this.scope, kind, id); }
    async retry(operation) {
        const end = Date.now() + REQUEST_TIMEOUT_MS;
        for (;;) {
            try {
                return operation();
            }
            catch (error) {
                if (!busy(error) || Date.now() >= end)
                    throw error;
                await delay(100);
            }
        }
    }
    change(operation) {
        if (this.closed)
            return Promise.reject(new Error("Sideband database is closed."));
        const task = this.pending.then(() => this.retry(() => {
            this.db.exec("BEGIN IMMEDIATE");
            try {
                const result = operation();
                this.db.exec("COMMIT");
                return result;
            }
            catch (error) {
                try {
                    this.db.exec("ROLLBACK");
                }
                catch { /* Keep the original failure. */ }
                throw error;
            }
        }));
        this.pending = task.then(() => { }, () => { });
        return task;
    }
    async close() { if (this.closed)
        return; this.closed = true; await this.pending; this.db.close(); }
}
export class LeaseLost extends Error {
    constructor() { super("Agent controller no longer owns its session."); }
}
async function processStamp(pid) {
    try {
        if (process.platform === "linux") {
            const [source, boot] = await Promise.all([readFile(`/proc/${pid}/stat`, "utf8"), readFile("/proc/sys/kernel/random/boot_id", "utf8")]);
            const fields = source.slice(source.lastIndexOf(")") + 2).split(" ");
            return fields[0] === "Z" ? "exited" : `${boot.trim()}:${fields[19]}`;
        }
        const command = process.platform === "win32" ? "powershell.exe" : "ps";
        const args = process.platform === "win32" ? ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`] : ["-p", String(pid), "-o", "lstart="];
        return await new Promise((resolve, reject) => execFile(command, args, { windowsHide: true, timeout: REQUEST_TIMEOUT_MS, maxBuffer: 4096, env: { ...process.env, LC_ALL: "C", TZ: "UTC" } }, (error, stdout) => error ? reject(error) : resolve(stdout.trim())));
    }
    catch {
        return undefined;
    }
}
let ownStamp;
export const processAlive = (pid) => { if (!Number.isSafeInteger(pid) || pid <= 0)
    return false; try {
    process.kill(pid, 0);
    return true;
}
catch (error) {
    return error.code !== "ESRCH";
} };
export class AgentStore {
    registry;
    constructor(registry) {
        this.registry = registry;
    }
    static async open(root, _profile) {
        return new AgentStore(await Registry.open(join(root, "agents.sqlite"), "worker"));
    }
    get(id) { return this.registry.get("agent", id); }
    all() { return this.registry.all("agent").map(([, record]) => record); }
    async live(id) {
        const lease = this.registry.get("lease", id);
        if (!lease || !processAlive(lease.pid))
            return false;
        if (Date.now() - lease.at < 30000)
            return true;
        // Controllers run as the worker's OS user. A stale PID that is now protected
        // by another account is not that controller (common after Windows reboots).
        try {
            process.kill(lease.pid, 0);
        }
        catch (error) {
            if (error.code === "EPERM")
                return false;
        }
        // A stale heartbeat is not permission to duplicate a sleeping/loaded controller.
        // Compare OS process birth identity so a reused PID after reboot is recoverable.
        const current = await processStamp(lease.pid);
        return current !== "exited" && (!current || !lease.started || current === lease.started);
    }
    heartbeat(id, owner) {
        return this.registry.change(() => { const lease = this.registry.get("lease", id); if (lease?.owner !== owner)
            throw new LeaseLost(); this.registry.put("lease", id, { ...lease, at: Date.now() }); });
    }
    async claim(record, owner, recover) {
        const before = this.registry.get("lease", record.agent.id), alive = await this.live(record.agent.id), started = await (ownStamp ??= processStamp(process.pid));
        if (!started)
            ownStamp = undefined;
        return this.registry.change(() => {
            if (JSON.stringify(this.registry.get("lease", record.agent.id)) !== JSON.stringify(before) || alive)
                throw new Error("This agent still has a running controller. Wait for it to reconnect before resuming.");
            const saved = this.get(record.agent.id);
            if (saved && !recover)
                throw new Error("This agent already has a saved session. Resume it instead of launching it again.");
            this.registry.put("lease", record.agent.id, { owner, pid: process.pid, started: started ?? "", at: Date.now() });
            const value = saved ?? record;
            this.registry.put("agent", record.agent.id, value);
            return value;
        });
    }
    checkpoint(record, owner, desired) {
        return this.registry.change(() => {
            if (this.registry.get("lease", record.agent.id)?.owner !== owner)
                throw new LeaseLost();
            const current = this.get(record.agent.id);
            const next = current?.desired === "archived" ? "archived" : desired ?? current?.desired ?? record.desired;
            this.registry.put("agent", record.agent.id, { ...record, desired: next, updatedAt: Date.now() });
            return next;
        });
    }
    desired(id, desired) {
        return this.registry.change(() => {
            const record = this.get(id);
            if (!record)
                throw new Error("No saved session exists for this agent on this machine.");
            this.registry.put("agent", id, { ...record, desired, updatedAt: Date.now() });
        });
    }
    release(id, owner) {
        return this.registry.change(() => { if (this.registry.get("lease", id)?.owner === owner)
            this.registry.remove("lease", id); });
    }
    close() { return this.registry.close(); }
}
//# sourceMappingURL=persistence.js.map