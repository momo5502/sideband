import { RoomTools, sidebandTools, sidebandInstructions } from "./room-tools.js";
import { RoomProfiles } from "./room-profiles.js";
import { RoomSession } from "./room-session.js";
import { agentName, serverUrl } from "./room-protocol.js";
import { formatDelivery } from "./protocol.js";
import { loginAndSave } from "./terminal-login.js";
import { managedOmp } from "./omp-managed.js";
import { PluginPresence } from "./plugin-presence.js";
import { isMainThread } from "node:worker_threads";
import { OutputBuffer } from "./orchestration-protocol.js";
import { emitOmpEvent } from "./managed-omp.js";
export function toolParameters(api, schema) {
    if (api.schema)
        return api.schema(schema);
    const shape = {};
    for (const [name, field] of Object.entries(schema.properties ?? {})) {
        const types = Array.isArray(field.type) ? field.type : [field.type];
        let value;
        if (types.includes("integer")) {
            let number = api.zod.number().int();
            if (field.minimum !== undefined)
                number = number.min(field.minimum);
            if (field.maximum !== undefined)
                number = number.max(field.maximum);
            value = number;
        }
        else {
            let string = api.zod.string();
            if (field.minLength !== undefined)
                string = string.min(field.minLength);
            if (field.maxLength !== undefined)
                string = string.max(field.maxLength);
            if (field.pattern)
                string = string.regex(new RegExp(field.pattern));
            value = string;
        }
        if (types.includes("null"))
            value = value.nullable();
        if (field.description)
            value = value.describe(field.description);
        shape[name] = schema.required?.includes(name) ? value : value.optional();
    }
    return api.zod.object(shape).strict();
}
export class OmpAdapter {
    api;
    isCurrent;
    closed = false;
    constructor(api, isCurrent) {
        this.api = api;
        this.isCurrent = isCurrent;
    }
    assertCurrent() {
        if (this.closed || !this.isCurrent())
            throw new Error("The oh-my-pi session changed; join again in the current session.");
    }
    async prepare() { this.assertCurrent(); }
    async deliver(message) {
        this.assertCurrent();
        // Native aside delivery reaches the next step boundary without aborting the tool batch.
        this.api.sendMessage({ customType: "sideband", content: formatDelivery(message), display: true, attribution: "agent" }, { deliverAs: "aside", triggerTurn: true });
    }
    async close() { this.closed = true; }
}
function unwrap(result) {
    if (result.isError)
        throw new Error(result.content[0]?.text ?? "Sideband request failed.");
    return JSON.parse(result.content[0].text);
}
/** Each factory binding owns its own client. Subagents never inherit a connection. */
export default function sideband(api, profiles = new RoomProfiles(), managed) {
    if (managedOmp(api, managed))
        return;
    const presenceOwner = Symbol.for("sideband.plugin.presence.owner"), owners = globalThis, claim = {};
    let output = new OutputBuffer(), reportedSession;
    const presence = isMainThread && !owners[presenceOwner] ? new PluginPresence(managed?.pi ? "pi" : "omp", undefined, api.sendUserMessage ? async (_session, request) => {
        if (!active || stopped)
            throw new Error("This session is changing or closed. Try again once it is ready.");
        if (request.action === "logs")
            return output.snapshot(request.after);
        const instructions = request.text;
        output.append("user", instructions);
        const errors = output;
        let timer;
        try {
            // OMP may resolve only when the entire turn finishes; PI may return void.
            // Acknowledge handoff without blocking later steering for a whole run.
            const operation = Promise.resolve(api.sendUserMessage(instructions, { deliverAs: "steer", attribution: "user" })).catch(error => {
                errors.append("error", error instanceof Error ? error.message : "Instructions failed after handoff.");
                throw error;
            });
            await Promise.race([operation, new Promise(resolve => { timer = setTimeout(resolve, 1000); })]);
        }
        finally {
            if (timer)
                clearTimeout(timer);
        }
        return { accepted: true };
    } : undefined) : undefined;
    if (presence)
        owners[presenceOwner] = claim;
    const report = (ctx, name) => {
        const session = ctx.sessionManager.getSessionFile?.() ?? ctx.sessionManager.getSessionId();
        if (session !== reportedSession) {
            output = new OutputBuffer();
            reportedSession = session;
        }
        presence?.replace([{ session, workspace: ctx.cwd, name }]);
    };
    let active;
    let epoch = 0;
    let stopped = false;
    let streamed = false;
    if (presence)
        for (const event of ["message_start", "message_update", "message_end", "tool_execution_start", "tool_execution_update", "tool_execution_end", "agent_start", "agent_end", "extension_error"])
            api.on(event, value => {
                const frame = { ...value, type: event };
                if (event === "message_start")
                    streamed = false;
                if (event === "message_update" && frame.assistantMessageEvent?.type === "text_delta")
                    streamed = true;
                if (event === "extension_error") {
                    output.append("error", String(frame.error ?? frame.message ?? "Harness extension failed."));
                    return;
                }
                emitOmpEvent({ event: (kind, text) => output.append(kind, text), state: () => { } }, frame);
                if (event === "message_end" && !streamed && frame.message?.role === "assistant") {
                    const content = frame.message.content;
                    const text = typeof content === "string" ? content : Array.isArray(content) ? content.filter((part) => part.type === "text").map((part) => part.text).join("") : "";
                    if (text)
                        output.append("assistant", text);
                }
            });
    let transition = Promise.resolve();
    const dialogs = new Set();
    const sessionId = (ctx) => {
        const id = ctx.sessionManager.getSessionId();
        if (typeof id !== "string" || !id.trim())
            throw new Error("oh-my-pi did not supply the current session ID.");
        return id;
    };
    const retire = () => {
        ++epoch;
        for (const dialog of dialogs)
            dialog.abort();
        const previous = active;
        active = undefined;
        const closing = transition.then(() => previous?.tools.close());
        transition = closing.then(() => { }, () => { });
        return closing;
    };
    const binding = (ctx) => {
        const id = sessionId(ctx), generation = epoch;
        const ready = transition.then(async () => {
            const assertCurrent = () => {
                if (stopped || generation !== epoch || sessionId(ctx) !== id)
                    throw new Error("The oh-my-pi session changed; join again in the current session.");
            };
            assertCurrent();
            if (active?.id !== id) {
                const previous = active;
                active = undefined;
                await previous?.tools.close();
                assertCurrent();
                const next = { id, context: ctx, tools: undefined };
                next.tools = new RoomTools(async (key, profile, name) => new RoomSession(profile, new OmpAdapter(api, () => active === next && !stopped && sessionId(next.context) === key), name), profiles);
                active = next;
            }
            active.context = ctx;
            return active;
        });
        transition = ready.then(() => { }, () => { });
        return ready;
    };
    for (const event of ["session_switch", "session_branch", "session_tree"])
        api.on(event, async (_event, ctx) => { await retire(); report(ctx); });
    api.on("session_start", async (_event, ctx) => { await retire(); await binding(ctx); report(ctx); });
    api.on("session_shutdown", async () => {
        stopped = true;
        const gone = presence?.close();
        try {
            await retire();
        }
        finally {
            await gone;
            if (owners[presenceOwner] === claim)
                delete owners[presenceOwner];
        }
    });
    api.on("before_agent_start", async (event, ctx) => {
        await binding(ctx);
        return { systemPrompt: [...(event.systemPrompt ?? []).filter(line => line !== sidebandInstructions), sidebandInstructions,
                "On oh-my-pi, /sideband login HOST:PORT opens a masked native password dialog outside the agent context. Never request passwords in chat. Sideband uses native aside delivery: messages arrive at the next step boundary and wake idle agents without polling."] };
    });
    for (const tool of sidebandTools) {
        api.registerTool({ name: tool.name, label: tool.name, description: tool.description ?? "Sideband room operation", loadMode: "essential",
            parameters: toolParameters(api, tool.inputSchema),
            async execute(_id, args, signal, _update, ctx) {
                if (signal?.aborted)
                    throw new Error("Sideband request cancelled.");
                const current = await binding(ctx);
                if (signal?.aborted)
                    throw new Error("Sideband request cancelled.");
                const result = await current.tools.call(current.id, tool.name, args);
                if (result.isError)
                    unwrap(result);
                report(ctx, current.tools.status(current.id).identity?.name);
                return { content: result.content, details: {} };
            },
        });
    }
    api.registerCommand("sideband", {
        description: "Sideband: login HOST:PORT [PROFILE], join ROOM, rooms, leave, off, status",
        async handler(args, ctx) {
            const dialog = new AbortController();
            dialogs.add(dialog);
            const id = sessionId(ctx);
            const current = () => !stopped && !dialog.signal.aborted && sessionId(ctx) === id;
            const input = async (title, secret = false) => {
                if (!ctx.hasUI || ctx.mode !== "tui")
                    throw new Error("This command needs the interactive oh-my-pi terminal. Use sideband login in your terminal for credentials, or the sideband tools for room operations.");
                const value = await ctx.ui.input(title, undefined, { secret, signal: dialog.signal });
                return current() ? value : undefined;
            };
            try {
                const match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(args.trim());
                const command = match?.[1]?.toLowerCase() ?? "status", argument = match?.[2]?.trim() ?? "";
                if (command === "login") {
                    const parts = argument.split(/\s+/).filter(Boolean);
                    if (!parts.length || parts.length > 2)
                        throw new Error("Use /sideband login HOST:PORT [PROFILE]. Enter the password only in the masked dialog.");
                    const server = serverUrl(parts[0]);
                    const names = await profiles.names();
                    const name = parts[1] ?? (names.length === 1 ? names[0] : "default");
                    const password = await input("Sideband server password", true);
                    if (password === undefined || !current())
                        return;
                    await loginAndSave(name, { server, password }, profiles);
                    if (current())
                        ctx.ui.notify(`Saved Sideband login '${name}'. Use /sideband join ROOM.`, "info");
                    return;
                }
                const owner = await binding(ctx);
                const call = async (name, values = {}) => {
                    if (!current() || active !== owner)
                        throw new Error("The oh-my-pi session changed.");
                    const result = unwrap(await owner.tools.call(owner.id, name, values));
                    report(ctx, owner.tools.status(owner.id).identity?.name);
                    return result;
                };
                if (command === "join" || command === "rooms") {
                    if (command === "join" && !argument)
                        throw new Error("Use /sideband join ROOM.");
                    const status = owner.tools.status(id);
                    const name = status.identity?.name ?? await input("Choose your Sideband username");
                    if (name === undefined || !current())
                        return;
                    if (!agentName(name))
                        throw new Error("A username is required.");
                    let profile;
                    if (!status.identity) {
                        const names = await profiles.names();
                        if (names.length > 1) {
                            if (!ctx.hasUI || ctx.mode !== "tui")
                                throw new Error("Choose a profile using the sideband tools.");
                            profile = await ctx.ui.select("Sideband server", names, { signal: dialog.signal });
                            if (!profile || !current())
                                return;
                        }
                    }
                    if (command === "join") {
                        const room = await call("sideband_join_room", { room: argument, name, ...(profile ? { profile } : {}) });
                        if (current())
                            ctx.ui.notify(`Joined ${room.name} as ${name}.`, "info");
                    }
                    else {
                        const rooms = await call("sideband_rooms", { name, ...(profile ? { profile } : {}) });
                        if (current())
                            ctx.ui.notify(rooms.length ? rooms.map(room => `${room.name} (${room.members})`).join("\n") : "No rooms yet. Use /sideband join ROOM.", "info");
                    }
                }
                else if (command === "leave" || command === "off" || command === "disconnect") {
                    if (argument)
                        throw new Error("This command takes no arguments.");
                    await call(command === "leave" ? "sideband_leave_room" : "sideband_deactivate");
                    if (current())
                        ctx.ui.notify(command === "leave" ? "Left the Sideband room." : "Sideband disconnected.", "info");
                }
                else if (command === "status") {
                    if (argument)
                        throw new Error("Use /sideband status.");
                    const status = owner.tools.status(id);
                    ctx.ui.notify(`Sideband: ${status.state}${status.identity?.name ? ` as ${status.identity.name}` : ""}${status.room ? ` in ${status.room.name}` : ""}.`, "info");
                }
                else
                    throw new Error("Use /sideband login HOST:PORT [PROFILE], join ROOM, rooms, leave, off, or status.");
            }
            catch (error) {
                if (current())
                    ctx.ui.notify(error instanceof Error ? error.message : "Sideband command failed.", "error");
            }
            finally {
                dialogs.delete(dialog);
            }
        },
    });
}
//# sourceMappingURL=omp-extension.js.map