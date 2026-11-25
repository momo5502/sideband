import { readPluginPresence, presenceDirectory } from "./plugin-presence.js";
import { requestPlugin } from "./plugin-control.js";
/** Only installed PI plugins advertise this. Managed companion plugins stay pinned. */
export async function reloadPiPlugins(version, signal, directory = presenceDirectory) {
    const endpoints = new Map();
    const sessions = (await readPluginPresence(directory, undefined, signal, endpoints)).filter(row => row.harness === "pi");
    let queued = 0, manual = 0, current = 0;
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(4, sessions.length) }, async () => {
        while (next < sessions.length) {
            const row = sessions[next++], endpoint = endpoints.get(row.key);
            if (signal?.aborted)
                throw new Error("Plugin reload cancelled.");
            if (endpoint?.version === version) {
                current++;
                continue;
            }
            if (!endpoint?.reload) {
                manual++;
                continue;
            }
            try {
                const result = await requestPlugin(endpoint, { key: row.key, action: "reload" }, signal);
                if (result?.queued === true)
                    queued++;
                else
                    manual++;
            }
            catch {
                if (signal?.aborted)
                    throw new Error("Plugin reload cancelled.");
                manual++;
            }
        }
    }));
    return { restartRequired: manual > 0, message: [
            queued ? `Reload queued for ${queued} PI session(s); all PI resources reload once idle.` : "",
            manual ? `${manual} PI session(s) need /sideband-reload or /reload in the terminal (command context unavailable, older plugin or unreachable session).` : "",
            current ? `${current} PI session(s) already loaded this version.` : "",
            !sessions.length ? "No running installed PI sessions to reload." : "",
        ].filter(Boolean).join(" ") };
}
//# sourceMappingURL=plugin-reload.js.map