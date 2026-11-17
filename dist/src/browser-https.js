import { AsyncLocalStorage } from "node:async_hooks";
import { createPrivateKey, randomUUID, X509Certificate } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { isIP } from "node:net";
import { dirname, join } from "node:path";
import { createSecureContext } from "node:tls";
import { domainToASCII } from "node:url";
import * as acme from "acme-client";
import { NATIVE_TLS_SERVERNAME } from "./room-protocol.js";
export function browserDomain(value) {
    if (/[\s/:\\?#@]/.test(value))
        throw new Error("--domain requires a DNS hostname, without a scheme, port or path.");
    const domain = domainToASCII(value.toLowerCase());
    if (!domain || domain.length > 253 || isIP(domain) || !domain.includes(".") ||
        !domain.split(".").every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) {
        throw new Error("--domain requires a DNS hostname, such as sideband.example.com (no scheme, port or path).");
    }
    return domain;
}
/** Scope cancellation to this issuance, including the ACME library's verification requests. */
const issuanceSignal = new AsyncLocalStorage();
// acmeSettings is a documented library extension not included in its Axios type declaration.
acme.axios.defaults.acmeSettings.retryMaxAttempts = 0;
acme.axios.interceptors.request.use(config => {
    const signal = issuanceSignal.getStore();
    if (signal) {
        config.signal = signal;
        config.timeout = 15_000;
    }
    return config;
});
export async function issueBrowserCertificate(request) {
    return issuanceSignal.run(request.signal, async () => {
        const client = new acme.Client({ directoryUrl: request.directoryUrl ?? (request.staging ? acme.directory.letsencrypt.staging : acme.directory.letsencrypt.production),
            accountKey: request.accountKey, backoffAttempts: 5, backoffMin: 1000, backoffMax: 5000 });
        const key = await acme.crypto.createPrivateEcdsaKey();
        const [, csr] = await acme.crypto.createCsr({ commonName: request.domain, altNames: [request.domain] }, key);
        const cert = await client.auto({ csr, email: request.email, termsOfServiceAgreed: true, challengePriority: ["http-01"],
            challengeCreateFn: async (_authorization, challenge, authorization) => {
                request.signal.throwIfAborted();
                if (challenge.type !== "http-01")
                    throw new Error("Only HTTP-01 certificate validation is supported.");
                request.challenges.set(challenge.token, authorization);
            },
            challengeRemoveFn: async (_authorization, challenge) => { request.challenges.delete(challenge.token); },
        });
        return { key: key.toString(), cert };
    });
}
async function readJson(path) {
    try {
        return JSON.parse(await readFile(path, "utf8"));
    }
    catch (error) {
        if (error.code === "ENOENT")
            return undefined;
        throw new Error(`Cannot read HTTPS state at ${path}.`);
    }
}
async function writePrivate(path, value) {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${randomUUID()}.tmp`, file = await open(temporary, "wx", 0o600);
    try {
        await file.writeFile(JSON.stringify(value));
        await file.sync();
        await file.close();
        await rename(temporary, path);
    }
    finally {
        await file.close().catch(() => { });
        await unlink(temporary).catch(() => { });
    }
}
function validateCertificate(value, domain) {
    const pair = value;
    if (!pair || typeof pair.key !== "string" || typeof pair.cert !== "string")
        throw new Error("Invalid stored HTTPS certificate.");
    const certificate = new X509Certificate(pair.cert);
    if (!certificate.checkPrivateKey(createPrivateKey(pair.key)) || !certificate.checkHost(domain) || !Number.isFinite(Date.parse(certificate.validTo))) {
        throw new Error("HTTPS certificate does not match its domain or private key.");
    }
    createSecureContext(pair); // Also validate the complete chain before persisting or hot-swapping it.
    return pair;
}
export function listenerError(error, port) {
    const code = error.code;
    if (code === "EACCES" || code === "EPERM")
        return new Error(`Cannot bind HTTPS setup port ${port}: permission denied. Use a service allowed to bind ports 80/443, or --http-port/--https-port with port forwarding.`);
    if (code === "EADDRINUSE")
        return new Error(`HTTPS setup port ${port} is already in use. Stop the other listener, or use --http-port/--https-port with port forwarding.`);
    return error instanceof Error ? error : new Error("Cannot start browser HTTPS.");
}
/** A separate browser certificate must never replace the native agent's stable TLS pin. */
export class BrowserHttps {
    options;
    http;
    https;
    domain;
    challenges = new Map();
    sockets = new Set();
    abort = new AbortController();
    directory;
    certificate;
    browserContext;
    timer;
    running;
    failures = 0;
    constructor(options, nativeCertificate, handler) {
        this.options = options;
        this.domain = browserDomain(options.domain);
        this.directory = join(options.directory, options.staging ? "staging" : "production", this.domain);
        this.http = createHttpServer((req, res) => {
            const token = /^\/\.well-known\/acme-challenge\/([A-Za-z0-9_-]+)$/.exec(req.url ?? "")?.[1];
            const authorization = token && this.challenges.get(token);
            const headers = { "Cache-Control": "no-store", "Content-Type": "text/plain; charset=utf-8", Connection: "close" };
            if (token) {
                res.writeHead(authorization && (req.method === "GET" || req.method === "HEAD") ? 200 : 404, headers);
                res.end(req.method === "HEAD" ? undefined : authorization || "Not found.\n");
            }
            else {
                let requested;
                try {
                    requested = new URL(req.url ?? "/", this.url);
                }
                catch {
                    res.writeHead(400, headers);
                    res.end("Bad request.\n");
                    req.resume();
                    return;
                }
                const path = requested.origin === this.url && requested.pathname !== "/" ? `${requested.pathname}${requested.search}` : "/chat";
                res.writeHead(308, { ...headers, Location: `${this.url}${path}` });
                res.end();
            }
            req.resume();
        });
        const nativeContext = createSecureContext(nativeCertificate);
        this.https = createHttpsServer({ ...nativeCertificate, minVersion: "TLSv1.2", SNICallback: (servername, callback) => {
                const context = servername === NATIVE_TLS_SERVERNAME ? nativeContext : this.browserContext;
                context ? callback(null, context) : callback(new Error("Browser HTTPS certificate setup is pending."));
            } }, (req, res) => {
            // No includeSubDomains: enabling Sideband must not change unrelated services' browser policies.
            if (!options.staging)
                res.setHeader("Strict-Transport-Security", "max-age=31536000");
            handler(req, res);
        });
        for (const listener of [this.http, this.https]) {
            listener.headersTimeout = 10_000;
            listener.requestTimeout = 10_000;
            listener.maxConnections = 2048;
            listener.on("connection", socket => { this.sockets.add(socket); socket.once("close", () => this.sockets.delete(socket)); });
        }
    }
    get url() { const address = this.https.address(); const port = address && typeof address === "object" ? address.port : this.options.httpsPort ?? 443; return `https://${this.domain}${port === 443 ? "" : `:${port}`}`; }
    get port() { const address = this.https.address(); if (!address || typeof address === "string")
        throw new Error("Browser HTTPS is not listening."); return address.port; }
    get httpPort() { const address = this.http.address(); if (!address || typeof address === "string")
        throw new Error("ACME HTTP is not listening."); return address.port; }
    async listen(host) {
        try {
            const stored = await readJson(join(this.directory, "certificate.json"));
            if (stored) {
                this.certificate = validateCertificate(stored, this.domain);
                this.useCertificate(this.certificate);
            }
        }
        catch (error) {
            this.options.log?.(`Cannot use cached browser certificate: ${error instanceof Error ? error.message : "Invalid certificate"}. A replacement will be requested; native credentials are unchanged.`);
        }
        for (const [listener, port] of [[this.http, this.options.httpPort ?? 80], [this.https, this.options.httpsPort ?? 443]]) {
            try {
                await new Promise((resolve, reject) => {
                    listener.once("error", reject);
                    listener.listen(port, host, () => { listener.off("error", reject); resolve(); });
                });
            }
            catch (error) {
                throw listenerError(error, port);
            }
        }
    }
    /** Called only after all listeners bind and the native identity has been committed. */
    start() {
        this.options.log?.(`Browser HTTPS: ${this.url}/chat${this.options.staging ? " (ACME staging; certificate will not be browser-trusted)" : ""}`);
        void this.renew();
    }
    useCertificate(certificate) {
        this.browserContext = createSecureContext(certificate);
        // Leave the no-SNI default pinned too. Updating this pointer hot-swaps only browser handshakes.
    }
    renew() {
        if (this.abort.signal.aborted)
            return Promise.resolve();
        if (this.running)
            return this.running;
        if (this.timer)
            clearTimeout(this.timer);
        this.running = this.update().finally(() => { this.running = undefined; });
        return this.running;
    }
    async update() {
        let delay = 12 * 60 * 60 * 1000;
        try {
            const now = this.options.now?.() ?? Date.now();
            const certificate = this.certificate && new X509Certificate(this.certificate.cert);
            // Also accommodate future shorter-lived certificates: renew at two thirds of their lifetime.
            const renewBefore = certificate ? Math.min(30 * 86400_000, (Date.parse(certificate.validTo) - Date.parse(certificate.validFrom)) / 3) : 0;
            if (!certificate || Date.parse(certificate.validTo) - now <= renewBefore) {
                this.options.log?.(`Obtaining ${certificate ? "renewed " : ""}HTTPS certificate for ${this.domain}; DNS must point here and public TCP port 80 must be reachable.`);
                const accountPath = join(this.directory, "account.json");
                let account = await readJson(accountPath);
                this.abort.signal.throwIfAborted();
                if (!account) {
                    account = { key: (await acme.crypto.createPrivateEcdsaKey()).toString() };
                    this.abort.signal.throwIfAborted();
                    await writePrivate(accountPath, account);
                }
                createPrivateKey(account.key);
                const issued = validateCertificate(await (this.options.issue ?? issueBrowserCertificate)({ domain: this.domain, email: this.options.email,
                    staging: this.options.staging, accountKey: account.key, signal: this.abort.signal, challenges: this.challenges }), this.domain);
                this.abort.signal.throwIfAborted();
                if (Date.parse(new X509Certificate(issued.cert).validTo) <= now)
                    throw new Error("Certificate authority returned an expired certificate.");
                await writePrivate(join(this.directory, "certificate.json"), issued);
                if (this.abort.signal.aborted)
                    return;
                this.useCertificate(issued);
                this.certificate = issued;
                this.options.log?.(`HTTPS ready. Open ${this.url}/chat`);
            }
            this.failures = 0;
        }
        catch (error) {
            if (this.abort.signal.aborted)
                return;
            delay = Math.min(12 * 60 * 60 * 1000, 10 * 60_000 * 2 ** Math.min(this.failures++, 10));
            const retryAfter = error?.response?.headers?.["retry-after"];
            if (typeof retryAfter === "string" || typeof retryAfter === "number") {
                const requested = Number.isFinite(Number(retryAfter)) ? Number(retryAfter) * 1000 : Date.parse(String(retryAfter)) - Date.now();
                if (Number.isFinite(requested))
                    delay = Math.max(delay, Math.min(requested, 7 * 86400_000));
            }
            this.options.log?.(`HTTPS certificate setup failed: ${error instanceof Error ? error.message : "Unknown ACME error"}. Retrying in ${Math.round(delay / 60_000)} min. Native agents and the existing HTTP interface remain available.`);
        }
        finally {
            this.challenges.clear();
            if (!this.abort.signal.aborted) {
                this.timer = setTimeout(() => { void this.renew(); }, delay);
                this.timer.unref();
            }
        }
    }
    async close() {
        this.abort.abort();
        if (this.timer)
            clearTimeout(this.timer);
        this.challenges.clear();
        for (const socket of this.sockets)
            socket.destroy();
        await Promise.all([this.http, this.https].map(listener => new Promise(resolve => listener.close(() => resolve()))));
    }
}
//# sourceMappingURL=browser-https.js.map