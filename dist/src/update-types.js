export const validCommit = (value) => typeof value === "string" && /^[a-f0-9]{40}$/.test(value);
export function parseBuild(value) {
    if (!value || typeof value.version !== "string" || value.version.length > 128 || (value.commit !== undefined && !validCommit(value.commit)))
        throw new Error("Invalid build information.");
    return { version: value.version, ...(value.commit ? { commit: value.commit } : {}) };
}
export function parseUpdate(value) {
    if (!value || !["idle", "installing", "plugins", "restarting", "done", "failed"].includes(value.phase) || typeof value.message !== "string" || value.message.length > 2048 ||
        !Number.isFinite(value.at) || (value.attempt !== undefined && (typeof value.attempt !== "string" || !/^[a-f0-9-]{36}$/.test(value.attempt))) || (value.target !== undefined && !validCommit(value.target)) || !Array.isArray(value.plugins) || value.plugins.length > 3)
        throw new Error("Invalid update status.");
    const plugins = value.plugins.map((plugin) => {
        if (!["codex", "claude", "omp"].includes(plugin.harness) || !["updated", "skipped", "failed"].includes(plugin.state) || typeof plugin.message !== "string" || plugin.message.length > 2048)
            throw new Error("Invalid plugin update status.");
        return { harness: plugin.harness, state: plugin.state, message: plugin.message, ...(typeof plugin.from === "string" ? { from: plugin.from.slice(0, 128) } : {}), ...(typeof plugin.to === "string" ? { to: plugin.to.slice(0, 128) } : {}), restartRequired: plugin.restartRequired === true };
    });
    return { phase: value.phase, message: value.message, at: value.at, plugins, ...(value.attempt ? { attempt: value.attempt } : {}), ...(value.target ? { target: value.target } : {}) };
}
//# sourceMappingURL=update-types.js.map