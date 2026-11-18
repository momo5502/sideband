import { dirname, join } from "node:path";
import { readFile } from "node:fs/promises";
import { runUpdateCommand } from "./update-runtime.js";
export function officialSidebandSource(value) {
    if (typeof value !== "string")
        return false;
    const source = value.toLowerCase().split("#")[0].replace(/^git\+/, "").replace(/\.git$/, "").replace(/\/$/, "");
    return ["https://github.com/momo5502/sideband", "git@github.com:momo5502/sideband", "ssh://git@github.com/momo5502/sideband", "github:momo5502/sideband", "momo5502/sideband"].includes(source);
}
const missing = (error) => error.code === "ENOENT";
const failure = (error) => (error instanceof Error ? error.message : "Plugin update failed.").slice(0, 2048);
async function ompSource(path) {
    if (typeof path !== "string")
        return false;
    let directory = dirname(path);
    for (let i = 0; i < 4; i++, directory = dirname(directory))
        try {
            const pkg = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
            if (pkg.dependencies?.sideband !== undefined)
                return officialSidebandSource(pkg.dependencies.sideband);
        }
        catch { /* Try the plugin manager's package root. */ }
    return false;
}
/** Updates only existing Sideband installations; never installs a new harness or plugin. */
export async function updateHarnessPlugins(run = runUpdateCommand, progress = () => { }) {
    const results = [];
    for (const harness of ["omp", "claude", "codex"]) {
        let from;
        let step = "List installed plugins";
        const invoke = (command, args, options) => run(command, command === "codex" ? ["--no-daemon", ...args] : args, { ...options, ...(command === "codex" ? { killTree: false } : {}) });
        try {
            const listing = JSON.parse(await invoke(harness, ["plugin", "list", "--json"], { timeout: 30_000 }));
            const installed = harness === "omp" ? listing.npm?.find((plugin) => plugin.name === "sideband")
                : harness === "claude" ? (Array.isArray(listing) ? listing : listing.installed ?? []).find((plugin) => plugin.id?.toLowerCase() === "sideband@sideband")
                    : listing.installed?.find((plugin) => plugin.pluginId?.toLowerCase() === "sideband@sideband");
            if (!installed) {
                results.push({ harness, state: "skipped", message: "Sideband is not installed in this harness." });
                progress([...results]);
                continue;
            }
            from = installed.version;
            let official = false;
            if (harness === "omp")
                official = await ompSource(installed.path);
            else if (harness === "codex")
                official = installed.marketplaceSource?.sourceType === "git" && officialSidebandSource(installed.marketplaceSource.source);
            else {
                step = "Inspect marketplace source";
                const raw = JSON.parse(await invoke("claude", ["plugin", "marketplace", "list", "--json"], { timeout: 30_000 }));
                const marketplace = (Array.isArray(raw) ? raw : raw.marketplaces ?? []).find((item) => item.name?.toLowerCase() === "sideband");
                const source = marketplace?.source;
                official = officialSidebandSource(marketplace?.repo ?? marketplace?.url ?? (typeof source === "string" ? source : source?.repo ?? source?.url));
            }
            if (!official) {
                results.push({ harness, from, state: "skipped", message: "Local or unrecognized Sideband source; update it manually." });
                progress([...results]);
                continue;
            }
            step = "Refresh Sideband plugin";
            if (harness === "omp")
                await invoke("omp", ["plugin", "upgrade", "sideband"]);
            else if (harness === "claude") {
                step = "Refresh marketplace";
                await invoke("claude", ["plugin", "marketplace", "update", "sideband"]);
                const scope = installed.scope;
                step = "Refresh Sideband plugin";
                await invoke("claude", ["plugin", "update", "sideband@sideband", "--json", "-y", ...(["user", "project", "local"].includes(scope) ? ["--scope", scope] : [])]);
            }
            else {
                step = "Refresh marketplace";
                await invoke("codex", ["plugin", "marketplace", "upgrade", "sideband"]);
            }
            step = "Verify refreshed plugin";
            const refreshed = JSON.parse(await invoke(harness, ["plugin", "list", "--json"], { timeout: 30_000 }));
            const updated = harness === "omp" ? refreshed.npm?.find((item) => item.name === "sideband")
                : harness === "claude" ? (Array.isArray(refreshed) ? refreshed : refreshed.installed ?? []).find((item) => item.id?.toLowerCase() === "sideband@sideband")
                    : refreshed.installed?.find((item) => item.pluginId?.toLowerCase() === "sideband@sideband");
            if (!updated)
                throw new Error("Sideband was not found after updating.");
            results.push({ harness, from, to: updated.version, state: "updated", message: from === updated.version ? "Version unchanged after refresh. Restart running harness sessions to load refreshed files." : "Updated. Running harness sessions load the new plugin after restart.", restartRequired: true });
        }
        catch (error) {
            results.push({ harness, from, state: missing(error) ? "skipped" : "failed", message: missing(error) ? "Harness CLI is not installed." : `${step}: ${failure(error)}` });
        }
        progress([...results]);
    }
    return results;
}
//# sourceMappingURL=plugin-updates.js.map