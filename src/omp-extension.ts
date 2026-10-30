import type * as zod from "zod/v4";
import { RoomTools, sidebandTools, sidebandInstructions, type ToolResult } from "./room-tools.js";
import { RoomProfiles } from "./room-profiles.js";
import { RoomSession } from "./room-session.js";
import { agentName, serverUrl } from "./room-protocol.js";
import { formatDelivery, type Delivery } from "./protocol.js";
import type { DeliveryAdapter } from "./adapters/codex.js";
import { loginAndSave } from "./terminal-login.js";

/** The host API subset used here. Schema builders come from OMP, with no runtime host imports. */
export interface OmpContext {
  mode: string;
  hasUI: boolean;
  sessionManager: { getSessionId(): string };
  ui: {
    input(title: string, placeholder?: string, options?: { secret?: boolean; signal?: AbortSignal }): Promise<string | undefined>;
    select(title: string, options: string[], dialog?: { signal?: AbortSignal }): Promise<string | undefined>;
    notify(message: string, level?: "info" | "warning" | "error"): void;
  };
}
export interface OmpTool {
  name: string;
  label: string;
  description: string;
  parameters: zod.ZodType;
  loadMode: "essential";
  execute(id: string, args: Record<string, unknown>, signal: AbortSignal | undefined, update: unknown, ctx: OmpContext): Promise<{ content: ToolResult["content"]; details: object }>;
}
export interface OmpApi {
  zod: typeof zod;
  registerTool(tool: OmpTool): void;
  registerCommand(name: string, command: { description: string; handler(args: string, ctx: OmpContext): Promise<void> }): void;
  on(event: string, handler: (event: { systemPrompt?: string[] }, ctx: OmpContext) => unknown): void;
  sendMessage(message: { customType: string; content: string; display: boolean; attribution: "agent" }, options: { deliverAs: "aside"; triggerTurn: boolean }): void;
}

export class OmpAdapter implements DeliveryAdapter {
  private closed = false;
  constructor(private readonly api: Pick<OmpApi, "sendMessage">, private readonly isCurrent: () => boolean) {}
  private assertCurrent(): void {
    if (this.closed || !this.isCurrent()) throw new Error("The oh-my-pi session changed; join again in the current session.");
  }
  async prepare(): Promise<void> { this.assertCurrent(); }
  async deliver(message: Delivery): Promise<void> {
    this.assertCurrent();
    // Native aside delivery reaches the next step boundary without aborting the tool batch.
    this.api.sendMessage({ customType: "sideband", content: formatDelivery(message), display: true, attribution: "agent" },
      { deliverAs: "aside", triggerTurn: true });
  }
  async close(): Promise<void> { this.closed = true; }
}

function unwrap(result: ToolResult): any {
  if (result.isError) throw new Error(result.content[0]?.text ?? "Sideband request failed.");
  return JSON.parse(result.content[0]!.text);
}

/** Each factory binding owns its own client. Subagents never inherit a connection. */
export default function sideband(api: OmpApi, profiles = new RoomProfiles()): void {
  type Binding = { id: string; context: OmpContext; tools: RoomTools };
  let active: Binding | undefined;
  let epoch = 0;
  let stopped = false;
  let transition = Promise.resolve();
  const dialogs = new Set<AbortController>();
  const sessionId = (ctx: OmpContext) => {
    const id = ctx.sessionManager.getSessionId();
    if (typeof id !== "string" || !id.trim()) throw new Error("oh-my-pi did not supply the current session ID.");
    return id;
  };
  const retire = () => {
    ++epoch;
    for (const dialog of dialogs) dialog.abort();
    const previous = active; active = undefined;
    const closing = transition.then(() => previous?.tools.close());
    transition = closing.then(() => {}, () => {});
    return closing;
  };
  const binding = (ctx: OmpContext): Promise<Binding> => {
    const id = sessionId(ctx), generation = epoch;
    const ready = transition.then(async () => {
      const assertCurrent = () => {
        if (stopped || generation !== epoch || sessionId(ctx) !== id) throw new Error("The oh-my-pi session changed; join again in the current session.");
      };
      assertCurrent();
      if (active?.id !== id) {
        const previous = active; active = undefined;
        await previous?.tools.close(); assertCurrent();
        const next: Binding = { id, context: ctx, tools: undefined as unknown as RoomTools };
        next.tools = new RoomTools(async (key, profile, name) => new RoomSession(profile,
          new OmpAdapter(api, () => active === next && !stopped && sessionId(next.context) === key), name), profiles);
        active = next;
      }
      active.context = ctx;
      return active;
    });
    transition = ready.then(() => {}, () => {});
    return ready;
  };
  for (const event of ["session_switch", "session_branch", "session_tree"]) api.on(event, () => retire());
  api.on("session_start", async (_event, ctx) => { await retire(); await binding(ctx); });
  api.on("session_shutdown", async () => { stopped = true; await retire(); });
  api.on("before_agent_start", async (event, ctx) => {
    await binding(ctx);
    return { systemPrompt: [...(event.systemPrompt ?? []).filter(line => line !== sidebandInstructions), sidebandInstructions,
      "On oh-my-pi, /sideband login HOST:PORT opens a masked native password dialog outside the agent context. Never request passwords in chat. Sideband uses native aside delivery: messages arrive at the next step boundary and wake idle agents without polling."] };
  });

  for (const tool of sidebandTools) {
    const shape: Record<string, zod.ZodType> = {};
    for (const [name, raw] of Object.entries(tool.inputSchema.properties ?? {})) {
      const field = raw as { type: string; minLength?: number; maxLength?: number; pattern?: string; minimum?: number; maximum?: number; description?: string };
      let schema: zod.ZodType;
      if (field.type === "integer") {
        let number = api.zod.number().int();
        if (field.minimum !== undefined) number = number.min(field.minimum);
        if (field.maximum !== undefined) number = number.max(field.maximum);
        schema = number;
      } else {
        let string = api.zod.string();
        if (field.minLength !== undefined) string = string.min(field.minLength);
        if (field.maxLength !== undefined) string = string.max(field.maxLength);
        if (field.pattern) string = string.regex(new RegExp(field.pattern));
        schema = string;
      }
      if (field.description) schema = schema.describe(field.description);
      shape[name] = tool.inputSchema.required?.includes(name) ? schema : schema.optional();
    }
    api.registerTool({ name: tool.name, label: tool.name, description: tool.description ?? "Sideband room operation", loadMode: "essential",
      parameters: api.zod.object(shape).strict(),
      async execute(_id, args, signal, _update, ctx) {
        if (signal?.aborted) throw new Error("Sideband request cancelled.");
        const current = await binding(ctx);
        if (signal?.aborted) throw new Error("Sideband request cancelled.");
        const result = await current.tools.call(current.id, tool.name, args);
        if (result.isError) unwrap(result);
        return { content: result.content, details: {} };
      },
    });
  }

  api.registerCommand("sideband", {
    description: "Sideband: login HOST:PORT [PROFILE], join ROOM, rooms, leave, off, status",
    async handler(args, ctx) {
      const dialog = new AbortController(); dialogs.add(dialog);
      const id = sessionId(ctx);
      const current = () => !stopped && !dialog.signal.aborted && sessionId(ctx) === id;
      const input = async (title: string, secret = false) => {
        if (!ctx.hasUI || ctx.mode !== "tui") throw new Error("This command needs the interactive oh-my-pi terminal. Use sideband login in your terminal for credentials, or the sideband tools for room operations.");
        const value = await ctx.ui.input(title, undefined, { secret, signal: dialog.signal });
        return current() ? value : undefined;
      };
      try {
        const match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(args.trim());
        const command = match?.[1]?.toLowerCase() ?? "status", argument = match?.[2]?.trim() ?? "";
        if (command === "login") {
          const parts = argument.split(/\s+/).filter(Boolean);
          if (!parts.length || parts.length > 2) throw new Error("Use /sideband login HOST:PORT [PROFILE]. Enter the password only in the masked dialog.");
          const server = serverUrl(parts[0]!);
          const names = await profiles.names();
          const name = parts[1] ?? (names.length === 1 ? names[0]! : "default");
          const password = await input("Sideband server password", true);
          if (password === undefined || !current()) return;
          await loginAndSave(name, { server, password }, profiles);
          if (current()) ctx.ui.notify(`Saved Sideband login '${name}'. Use /sideband join ROOM.`, "info");
          return;
        }
        const owner = await binding(ctx);
        const call = async (name: string, values: Record<string, unknown> = {}) => {
          if (!current() || active !== owner) throw new Error("The oh-my-pi session changed.");
          return unwrap(await owner.tools.call(owner.id, name, values));
        };
        if (command === "join" || command === "rooms") {
          if (command === "join" && !argument) throw new Error("Use /sideband join ROOM.");
          const status = owner.tools.status(id) as { identity?: { name?: string } };
          const name = status.identity?.name ?? await input("Choose your Sideband username");
          if (name === undefined || !current()) return;
          if (!agentName(name)) throw new Error("A username is required.");
          let profile: string | undefined;
          if (!status.identity) {
            const names = await profiles.names();
            if (names.length > 1) {
              if (!ctx.hasUI || ctx.mode !== "tui") throw new Error("Choose a profile using the sideband tools.");
              profile = await ctx.ui.select("Sideband server", names, { signal: dialog.signal });
              if (!profile || !current()) return;
            }
          }
          if (command === "join") {
            const room = await call("sideband_join_room", { room: argument, name, ...(profile ? { profile } : {}) });
            if (current()) ctx.ui.notify(`Joined ${room.name} as ${name}.`, "info");
          } else {
            const rooms = await call("sideband_rooms", { name, ...(profile ? { profile } : {}) }) as { name: string; members: number }[];
            if (current()) ctx.ui.notify(rooms.length ? rooms.map(room => `${room.name} (${room.members})`).join("\n") : "No rooms yet. Use /sideband join ROOM.", "info");
          }
        } else if (command === "leave" || command === "off" || command === "disconnect") {
          if (argument) throw new Error("This command takes no arguments.");
          await call(command === "leave" ? "sideband_leave_room" : "sideband_deactivate");
          if (current()) ctx.ui.notify(command === "leave" ? "Left the Sideband room." : "Sideband disconnected.", "info");
        } else if (command === "status") {
          if (argument) throw new Error("Use /sideband status.");
          const status = owner.tools.status(id) as { state: string; identity?: { name?: string }; room?: { name: string } };
          ctx.ui.notify(`Sideband: ${status.state}${status.identity?.name ? ` as ${status.identity.name}` : ""}${status.room ? ` in ${status.room.name}` : ""}.`, "info");
        } else throw new Error("Use /sideband login HOST:PORT [PROFILE], join ROOM, rooms, leave, off, or status.");
      } catch (error) { if (current()) ctx.ui.notify(error instanceof Error ? error.message : "Sideband command failed.", "error"); }
      finally { dialogs.delete(dialog); }
    },
  });
}
