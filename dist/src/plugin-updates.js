import { REQUEST_TIMEOUT_MS, COMMAND_TIMEOUT_MS } from "./timeouts.js";
import { dirname, join } from "node:path";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { runUpdateCommand } from "./update-runtime.js";
export function officialSidebandSource(value) {
    if (typeof value !== "string")
        return false;
    const source = value.toLowerCase().split("#")[0].replace(/^git\+/, "").replace(/\.git$/, "").replace(/\/$/, "");
    return ["https://github.com/momo5502/sideband", "git@github.com:momo5502/sideband", "ssh://git@github.com/momo5502/sideband", "github:momo5502/sideband", "momo5502/sideband"].includes(source);
}
const missing = (error) => error.code === "ENOENT";
const listingTimeout = REQUEST_TIMEOUT_MS;
const failure = (error) => (error instanceof Error ? error.message : "Plugin update failed.").slice(0, 2048);
export async function ompSource(path) {
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
        const listArgs = harness === "codex" ? ["plugin", "list", "--marketplace", "sideband", "--json"] : ["plugin", "list", "--json"];
        const invoke = (command, args, options) => run(command, command === "codex" ? ["--no-daemon", ...args] : args, { ...options, ...(command === "codex" ? { killTree: false } : {}) });
        try {
            const listing = JSON.parse(await invoke(harness, listArgs, { timeout: listingTimeout }));
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
                const raw = JSON.parse(await invoke("claude", ["plugin", "marketplace", "list", "--json"], { timeout: listingTimeout }));
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
            const refreshed = JSON.parse(await invoke(harness, listArgs, { timeout: listingTimeout }));
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
    results.push(await updatePiPlugin(run));
    progress([...results]);
    return results;
}
/** PI's bare update also upgrades PI itself. Refresh only an existing, unpinned Sideband extension. */
export async function updatePiPlugin(run = runUpdateCommand, directory = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent")) {
    directory = resolve(directory.replace(/^~(?=[/\\]|$)/, homedir()));
    const skipped = (message) => ({ harness: "pi", state: "skipped", message });
    let from;
    const version = async () => { const value = JSON.parse(await readFile(join(directory, "git", "github.com", "momo5502", "sideband", "package.json"), "utf8")).version; return typeof value === "string" && value.length <= 128 ? value : undefined; };
    try {
        let settings;
        try {
            settings = JSON.parse(await readFile(join(directory, "settings.json"), "utf8"));
        }
        catch {
            return skipped("No PI package settings found.");
        }
        const sources = Array.isArray(settings.packages) ? settings.packages.map((entry) => typeof entry === "string" ? entry : entry?.source).filter((source) => typeof source === "string") : [];
        const source = sources.map((source) => /^(?:git:)?(?:https:\/\/github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:|github\.com\/)momo5502\/sideband(?:\.git)?(?:@([^@\s]+))?$/.exec(source)).find((match) => match);
        if (!source)
            return skipped("Sideband is not installed from its official Git source in PI.");
        if (source[1] && source[1] !== "main")
            return skipped("The PI package uses a pinned ref. Update it explicitly in PI to change that pin.");
        if (process.env.PI_OFFLINE && !["0", "false"].includes(process.env.PI_OFFLINE.toLowerCase()))
            return skipped("PI is offline; refresh its package when online.");
        from = await version().catch(() => undefined);
        await run("pi", ["update", "--extension", "git:github.com/momo5502/sideband", "--no-approve"], { timeout: COMMAND_TIMEOUT_MS, cwd: homedir() });
        const to = await version();
        if (!to)
            throw new Error("Could not verify the refreshed PI package.");
        return { harness: "pi", from, to, state: "updated", restartRequired: from !== to, message: from === to ? "Already current." : "Sideband extension refreshed. Reload PI or restart its session to apply it." };
    }
    catch (error) {
        return { harness: "pi", from, state: missing(error) ? "skipped" : "failed", message: missing(error) ? "PI or its installed package is unavailable." : failure(error) };
    }
}
//# sourceMappingURL=plugin-updates.js.map