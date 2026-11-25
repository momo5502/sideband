import { Type } from "typebox";
import sideband from "./omp-extension.js";
import { isMainThread } from "node:worker_threads";
const key = Symbol.for("sideband.managed.pi.root");
const roots = globalThis;
/** PI supplies TypeBox. Never use OMP's zod API or its masked-password dialog here. */
export function piSchema(schema) {
    const shape = {};
    for (const [name, raw] of Object.entries(schema.properties ?? {})) {
        const field = raw, types = Array.isArray(field.type) ? field.type : [field.type];
        const metadata = Object.fromEntries(Object.entries(field).filter(([name]) => !["type"].includes(name)));
        const value = types.includes("integer") ? Type.Integer(metadata) : Type.String(metadata);
        shape[name] = schema.required?.includes(name) ? value : Type.Optional(value);
    }
    return Type.Object(shape, { additionalProperties: false });
}
export default function piSideband(api) {
    let commandContext, context, reloading = false;
    const performReload = async (ctx, hooks) => {
        if (reloading) {
            hooks?.failed(new Error("PI reload is already in progress."));
            return;
        }
        reloading = true;
        try {
            await ctx.waitForIdle();
            hooks?.before();
            await ctx.reload();
            return;
        }
        catch (error) {
            hooks?.failed(error);
            if (!hooks) {
                try {
                    ctx.ui.notify("PI reload failed. Try /reload or restart PI.", "error");
                }
                catch {
                    process.stderr.write("Sideband: PI reload failed after runtime teardown; restart PI.\n");
                }
            }
        }
        finally {
            reloading = false;
        }
    };
    api.on("session_start", (_event, ctx) => { context = ctx; });
    api.registerCommand("sideband-reload", { description: "Reload PI resources after a Sideband update, once idle", async handler(_args, ctx) {
            commandContext = ctx;
            await performReload(ctx);
            return;
        } });
    if (isMainThread && process.env.SIDEBAND_MANAGED_BRIDGE && !roots[key]?.active)
        roots[key] = { bootstrap: JSON.parse(process.env.SIDEBAND_MANAGED_BRIDGE), active: true };
    else if (isMainThread && roots[key] && !roots[key].active) {
        roots[key].active = true;
        process.env.SIDEBAND_MANAGED_BRIDGE = JSON.stringify(roots[key].bootstrap);
    }
    const adapter = {
        schema: piSchema,
        registerTool(tool) { const { loadMode: _loadMode, ...definition } = tool; api.registerTool({ ...definition, promptSnippet: `${tool.name}: ${tool.description}` }); },
        registerCommand(name, command) {
            api.registerCommand(name, { ...command, async handler(args, ctx) {
                    commandContext = ctx;
                    if (/^login(?:\s|$)/i.test(args.trim())) {
                        ctx.ui.notify("Use sideband login HOST:PORT in a separate terminal. PI does not provide masked password input.", "info");
                        return;
                    }
                    return command.handler(args, ctx);
                } });
        },
        on(event, handler) {
            api.on(event, async (value, ctx) => {
                const incoming = event === "before_agent_start" ? { ...value, systemPrompt: typeof value.systemPrompt === "string" ? [value.systemPrompt] : value.systemPrompt } : value;
                const result = await handler(incoming, ctx);
                if (event === "before_agent_start" && Array.isArray(result?.systemPrompt))
                    return { ...result, systemPrompt: result.systemPrompt.filter((text) => !text.startsWith("On oh-my-pi,")).concat("On PI, enter server credentials only through sideband login in a separate terminal; never ask for passwords in chat.").join("\n\n") };
                return result;
            });
        },
        sendMessage(message, options) { const { attribution: _attribution, ...content } = message; api.sendMessage(content, { ...options, deliverAs: "steer" }); },
        async sendUserMessage(text) { await api.sendUserMessage(text, { deliverAs: "steer" }); },
        requestReload(hooks) {
            // PI 0.79.1's sendUserMessage skips command dispatch despite its docs.
            // A user-invoked command grants a context valid until runtime replacement.
            if (!commandContext) {
                context?.ui.notify("Sideband updated. Run /sideband-reload (or /reload) to load it; this reloads all PI resources.", "info");
                return;
            }
            void performReload(commandContext, hooks);
        },
        canReload: () => !!commandContext,
        getActiveTools: () => api.getActiveTools(), getAllTools: () => api.getAllTools(), async setActiveTools(names) { await api.setActiveTools(names); },
    };
    sideband(adapter, undefined, { pi: true, onToken: token => { if (roots[key])
            roots[key].bootstrap.token = token; }, onRetire: (token, reason) => {
            if (!roots[key])
                return;
            if (reason === "quit")
                delete roots[key];
            else {
                roots[key].bootstrap.token = token;
                roots[key].active = false;
            }
        } });
}
//# sourceMappingURL=pi-extension.js.map