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
import { CodexMembership } from "./codex-membership.js";
import { PluginPresence } from "./plugin-presence.js";
import { randomUUID } from "node:crypto";
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
    const profiles = new RoomProfiles(undefined, nativeProfile);
    const presence = new PluginPresence(harness);
    // Claude gives each interactive session its own MCP process. It does not
    // provide a session ID in the MCP startup handshake.
    const claudeSession = `claude-mcp:${randomUUID()}`;
    const recovery = harness === "codex" ? await CodexMembership.open(profiles, { report: message => console.error(message), presence: threads => presence.replace(threads.map(thread => ({ session: thread.id, workspace: thread.cwd, name: thread.name, identityId: thread.identityId }))) }) : undefined;
    const tools = recovery?.tools ?? new RoomTools(async (key, profile, name) => {
        const adapter = harness === "claude" ? new ClaudeAdapter(server) : new CodexAdapter(await CodexRpc.connect(), key);
        try {
            const session = new RoomSession(profile, adapter, name);
            session.client.onEvent(event => { if (harness === "claude" && event === "identity.changed")
                presence.replace([{ session: claudeSession, workspace: process.cwd(), name: session.client.identity.name, identityId: session.client.identity.id }]); });
            return session;
        }
        catch (error) {
            await adapter.close();
            throw error;
        }
    }, profiles);
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: sidebandTools }));
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
        try {
            const key = callerKey(harness, request.params._meta), result = await (recovery ?? tools).call(key, request.params.name, request.params.arguments);
            if (harness === "claude")
                presence.replace([{ session: claudeSession, workspace: process.cwd(), name: tools.status(key).identity?.name, identityId: tools.status(key).identity?.id }]);
            return result;
        }
        catch (error) {
            return toolError(error);
        }
    });
    let closing = false;
    const close = async () => { if (closing)
        return; closing = true; const gone = presence.close(); await (recovery ?? tools).close(); await gone; await server.close(); };
    server.onclose = () => { void close(); };
    process.stdin.once("end", () => { void close(); });
    process.once("SIGINT", () => { void close(); });
    process.once("SIGTERM", () => { void close(); });
    await server.connect(new StdioServerTransport());
    if (harness === "claude")
        presence.replace([{ session: claudeSession, workspace: process.cwd() }]);
    recovery?.start();
}
//# sourceMappingURL=room-mcp.js.map