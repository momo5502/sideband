import { createServer, type Server } from "node:http";
import { randomBytes } from "node:crypto";
import { RoomProfiles } from "./room-profiles.js";

const escape = (value: string) => value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
/** Local-only onboarding form: a secret never passes through MCP/chat/tool arguments. */
export class LocalSetup {
  private server?: Server;
  private readonly forms = new Map<string, { profile: string; server: string; expires: number }>();
  constructor(private readonly profiles: RoomProfiles) {}
  async start(profile: string, endpoint = ""): Promise<{ url: string; expiresInMinutes: number }> {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(profile)) throw new Error("Invalid profile name.");
    for (const [key, form] of this.forms) if (form.expires < Date.now()) this.forms.delete(key);
    if (this.forms.size >= 10) throw new Error("Too many open setup forms; finish one or wait for expiry.");
    if (!this.server) {
      this.server = createServer((req, res) => { void (async () => {
        const address = this.server!.address();
        if (!address || typeof address === "string") { res.writeHead(503).end(); return; }
        const origin = `http://127.0.0.1:${address.port}`;
        const key = (req.url ?? "").slice(1);
        const form = this.forms.get(key);
        res.setHeader("Cache-Control", "no-store");
        res.setHeader("Referrer-Policy", "no-referrer");
        res.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
        if (req.headers.host !== `127.0.0.1:${address.port}` || !form || form.expires < Date.now()) { res.writeHead(404).end("Setup link unavailable or expired."); return; }
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        if (req.method === "GET") {
          res.end(`<!doctype html><html><head><meta charset="utf-8"><title>Sideband setup</title><style>body{font:17px system-ui;max-width:560px;margin:60px auto;padding:24px;background:#15191f;color:#e5e9f0}input,button{box-sizing:border-box;display:block;width:100%;padding:12px;margin:10px 0 24px}small{color:#abb5c2}</style></head><body><h1>Connect your agents</h1><p>Save local profile <strong>${escape(form.profile)}</strong>. This form does not connect an agent.</p><form method="post"><label>Server IP:port<input name="server" required value="${escape(form.server)}" placeholder="203.0.113.10:8765" autocomplete="off"></label><label>Server password<input name="password" type="password" required placeholder="sb1.…" autocomplete="off"></label><button>Save connection</button></form><small>Credentials stay on this computer, outside the agent conversation. This one-use form expires in 10 minutes.</small></body></html>`); return;
        }
        if (req.method !== "POST" || req.headers.origin !== origin || !(req.headers["content-type"] ?? "").startsWith("application/x-www-form-urlencoded")) { res.writeHead(403).end("Rejected request."); return; }
        const chunks: Buffer[] = []; let size = 0;
        for await (const chunk of req) { size += chunk.length; if (size > 8192) { res.writeHead(413).end("Request too large."); return; } chunks.push(chunk); }
        const values = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
        try {
          await this.profiles.save(form.profile, { server: values.get("server") ?? "", password: values.get("password") ?? "" });
          this.forms.delete(key);
          res.end("<!doctype html><title>Connection saved</title><h1>Connection saved</h1><p>Return to your agent and join a room. You can close this tab.</p>");
        } catch { res.writeHead(400).end("Invalid address or password. Go back and copy the complete server password."); }
      })().catch(() => { if (!res.headersSent) res.writeHead(500); res.end("Setup failed."); }); });
      this.server.requestTimeout = 15_000; this.server.headersTimeout = 10_000; this.server.maxConnections = 10;
      await new Promise<void>((resolve, reject) => { this.server!.once("error", reject); this.server!.listen(0, "127.0.0.1", () => { this.server!.off("error", reject); resolve(); }); });
    }
    const nonce = randomBytes(24).toString("base64url");
    this.forms.set(nonce, { profile, server: endpoint, expires: Date.now() + 600_000 });
    const address = this.server.address(); if (!address || typeof address === "string") throw new Error("Setup server unavailable.");
    return { url: `http://127.0.0.1:${address.port}/${nonce}`, expiresInMinutes: 10 };
  }
  async close(): Promise<void> {
    this.forms.clear();
    if (this.server) { this.server.closeAllConnections(); await new Promise<void>((resolve) => this.server!.close(() => resolve())); this.server = undefined; }
  }
}
