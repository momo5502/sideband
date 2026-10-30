import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { CodexRpc } from "./rpc.js";
import { CodexAdapter } from "./adapters/codex.js";
import { ClaudeAdapter } from "./adapters/claude.js";
import { RoomProfiles } from "./room-profiles.js";
import { callerKey } from "./room-registry.js";
import { RoomSession } from "./room-session.js";
import { RoomTools, sidebandTools, sidebandInstructions, SIDEBAND_VERSION, toolError } from "./room-tools.js";
export async function runMcp(harness) {
    const server = new Server({ name: "sideband", version: SIDEBAND_VERSION }, {
        capabilities: { tools: {}, ...(harness === "claude" ? { experimental: { "claude/channel": {} } } : {}) },
        instructions: sidebandInstructions,
    });
    // Native Claude configuration reaches only this subprocess, not model/tool input.
    const endpoint = process.env.SIDEBAND_CLAUDE_SERVER;
    const password = process.env.SIDEBAND_CLAUDE_PASSWORD;
    const nativeProfile = harness === "claude" && endpoint && password && !endpoint.startsWith("${") && !password.startsWith("${")
        ? { server: endpoint, password } : undefined;
    const tools = new RoomTools(async (key, profile, name) => {
        const adapter = harness === "claude" ? new ClaudeAdapter(server) : new CodexAdapter(await CodexRpc.connect(), key);
        try {
            return new RoomSession(profile, adapter, name);
        }
        catch (error) {
            await adapter.close();
            throw error;
        }
    }, new RoomProfiles(undefined, nativeProfile));
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: sidebandTools }));
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
        try {
            return await tools.call(callerKey(harness, request.params._meta), request.params.name, request.params.arguments);
        }
        catch (error) {
            return toolError(error);
        }
    });
    let closing = false;
    const close = async () => { if (closing)
        return; closing = true; await tools.close(); await server.close(); };
    server.onclose = () => { void close(); };
    process.once("SIGINT", () => { void close(); });
    process.once("SIGTERM", () => { void close(); });
    await server.connect(new StdioServerTransport());
}
//# sourceMappingURL=room-mcp.js.map