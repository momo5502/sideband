import { createHmac, createPrivateKey, createPublicKey, randomUUID, sign, timingSafeEqual } from "node:crypto";
import { stringify } from "yaml";
import { agentName, identityFor, MAX_TEXT_BYTES, messageProof, RoomError, text } from "./room-protocol.js";
export const MAX_WEBHOOK_BYTES = 256 * 1024;
/** Capabilities are derived from the existing server secret; no webhook registry or saved tokens. */
export class Webhooks {
    secret;
    constructor(secret) {
        this.secret = secret;
    }
    target(room, sender) {
        const name = text(room, "webhook room", 100).trim().toLowerCase();
        if (!name || /[\x00-\x1f\x7f]/.test(name))
            throw new RoomError("INVALID_ARGUMENT", "Invalid webhook room.");
        const persona = agentName(sender);
        if (!persona)
            throw new RoomError("INVALID_ARGUMENT", "A webhook sender name is required.");
        return { room: name, sender: persona };
    }
    digest(purpose, target) {
        return createHmac("sha256", this.secret).update(JSON.stringify([purpose, target.room, target.sender])).digest();
    }
    create(room, sender) {
        const target = this.target(room, sender);
        const token = `wh1.${this.digest("sideband.webhook.authorization.v1", target).toString("base64url")}`;
        return { path: `/webhooks?${new URLSearchParams({ ...target, token })}` };
    }
    authorize(url) {
        try {
            const params = url.searchParams;
            if ([...params.keys()].length !== 3 || !["room", "sender", "token"].every(key => params.getAll(key).length === 1))
                return;
            const target = this.target(params.get("room"), params.get("sender"));
            const token = params.get("token");
            if (!/^wh1\.[A-Za-z0-9_-]{43}$/.test(token))
                return;
            const expected = `wh1.${this.digest("sideband.webhook.authorization.v1", target).toString("base64url")}`;
            return timingSafeEqual(Buffer.from(token), Buffer.from(expected)) ? target : undefined;
        }
        catch {
            return;
        }
    }
    message(target, roomId, body) {
        // A separate HMAC domain keeps the visible URL token from revealing this signing key.
        const seed = this.digest("sideband.webhook.identity.v1", target);
        const key = createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]), type: "pkcs8", format: "der" });
        const sender = identityFor(createPublicKey(key).export({ type: "spki", format: "der" }).toString("base64url"), target.sender);
        const message = { id: randomUUID(), roomId, sender, text: body, signature: "", createdAt: Date.now() };
        message.signature = sign(null, Buffer.from(messageProof(message)), key).toString("base64url");
        return message;
    }
}
/** JSON only: bounded depth, readable YAML, and a fence that payload strings cannot close. */
export function webhookText(json) {
    const pending = [[json, 0]];
    while (pending.length) {
        const [value, depth] = pending.pop();
        if (depth > 32)
            throw new RoomError("INVALID_ARGUMENT", "Webhook JSON is nested too deeply.");
        if (value && typeof value === "object")
            for (const item of Object.values(value))
                pending.push([item, depth + 1]);
    }
    let yaml = stringify(json, { lineWidth: 100, aliasDuplicateObjects: false });
    let truncated = false;
    const cut = (limit) => { yaml = new TextDecoder().decode(Buffer.from(yaml).subarray(0, Math.max(0, limit - 3))).replace(/\uFFFD$/, ""); truncated = true; };
    if (Buffer.byteLength(yaml) > MAX_TEXT_BYTES - 128)
        cut(MAX_TEXT_BYTES - 128);
    for (;;) {
        const fenceFor = (char) => char.repeat(Math.max(2, ...[...yaml.matchAll(new RegExp(`${char}+`, "g"))].map(match => match[0].length)) + 1);
        const backticks = fenceFor("`"), tildes = fenceFor("~"), fence = backticks.length <= tildes.length ? backticks : tildes;
        const body = `${fence}yaml\n${yaml.trimEnd()}\n${fence}${truncated ? "\nPayload truncated to fit the message limit." : ""}`;
        const bytes = Buffer.byteLength(body);
        if (bytes <= MAX_TEXT_BYTES)
            return body;
        cut(Buffer.byteLength(yaml) - (bytes - MAX_TEXT_BYTES));
    }
}
//# sourceMappingURL=webhooks.js.map