import { HttpsProxyAgent } from "https-proxy-agent";
import { RoomError } from "./room-protocol.js";
const envValue = (env, name) => (env[name.toLowerCase()] || env[name.toUpperCase()] || "").trim();
function bypassProxy(target, entries) {
    const hostname = target.hostname.toLowerCase();
    const port = Number(target.port || 443);
    return entries.toLowerCase().split(/[,\s]+/).some(entry => {
        if (!entry)
            return false;
        if (entry === "*")
            return true;
        const match = /^(\[[^\]]+\]|[^:]+):(\d+)$/.exec(entry);
        if (match && Number(match[2]) !== port)
            return false;
        const host = match ? match[1] : entry;
        if (host.startsWith("*"))
            return hostname.endsWith(host.slice(1));
        if (host.startsWith("."))
            return hostname.endsWith(host);
        // Bracketed IPv6 is also accepted without brackets when no port is specified.
        return hostname === host || hostname.replace(/^\[|\]$/g, "") === host;
    });
}
/** WSS uses HTTPS_PROXY, then HTTP_PROXY / ALL_PROXY; NO_PROXY always wins. */
export function roomProxyUrl(endpoint, env = process.env) {
    const target = new URL(endpoint);
    if (bypassProxy(target, envValue(env, "no_proxy")))
        return undefined;
    const configured = envValue(env, "https_proxy") || envValue(env, "http_proxy") || envValue(env, "all_proxy");
    if (!configured)
        return undefined;
    try {
        const proxy = new URL(configured.includes("://") ? configured : `http://${configured}`);
        if (!["http:", "https:"].includes(proxy.protocol) || !proxy.hostname || proxy.hash || proxy.search || !["", "/"].includes(proxy.pathname))
            throw new Error();
        decodeURIComponent(proxy.username);
        decodeURIComponent(proxy.password);
        return proxy;
    }
    catch {
        // Never include the configured URL: it may contain a username/password.
        throw new RoomError("PROXY_CONFIG", "Invalid proxy configuration. Use an HTTP or HTTPS proxy URL in HTTPS_PROXY or HTTP_PROXY. SOCKS/PAC proxies are not supported.");
    }
}
export function roomProxyAgent(proxy, signal) {
    const address = new URL(proxy);
    const auth = address.username || address.password ? Buffer.from(`${decodeURIComponent(address.username)}:${decodeURIComponent(address.password)}`).toString("base64") : undefined;
    // Keep credentials out of the agent's debug URL. The header is for CONNECT only.
    address.username = "";
    address.password = "";
    return new HttpsProxyAgent(address, { signal, ...(auth ? { headers: { "Proxy-Authorization": `Basic ${auth}` } } : {}) });
}
//# sourceMappingURL=room-proxy.js.map