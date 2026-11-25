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