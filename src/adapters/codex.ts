import { formatDelivery, type Delivery } from "../protocol.js";
import { RpcError, type RpcConnection } from "../rpc.js";

export interface DeliveryAdapter {
  prepare(): Promise<void>;
  deliver(message: Delivery): Promise<void>;
  close(): Promise<void>;
}
export class DeliveryUncertainError extends Error {
  constructor(message: string, options?: ErrorOptions) { super(message, options); this.name = "DeliveryUncertainError"; }
}
type ThreadRead = { thread: { id: string; status?: { type: string }; turns: { id: string; status: string }[] } };
const raceError = (error: unknown): boolean => error instanceof RpcError &&
  /no active turn|not active|expected.*turn|turn.*mismatch|turn.*in progress|turn.*already|active turn.*different/i.test(error.message);

export class CodexAdapter implements DeliveryAdapter {
  constructor(private readonly rpc: RpcConnection, readonly threadId: string) {
    if (!threadId) throw new Error("An exact Codex thread ID is required; session selection is never guessed.");
  }
  async prepare(): Promise<void> {
    const result = await this.rpc.request<{ data: string[] }>("thread/loaded/list");
    if (!result.data.includes(this.threadId)) {
      throw new Error("The current session is not loaded in this Codex server. Start Codex with its shared daemon; the plugin will not resume a second copy.");
    }
  }
  async deliver(message: Delivery): Promise<void> {
    const input = [{ type: "text", text: formatDelivery(message) }];
    for (let attempt = 0; attempt < 3; attempt++) {
      const read = await this.rpc.request<ThreadRead>("thread/read", { threadId: this.threadId, includeTurns: true });
      if (read.thread.id !== this.threadId || read.thread.status?.type === "notLoaded") {
        throw new Error("Codex session is no longer loaded; message was not delivered.");
      }
      const active = read.thread.status?.type === "idle" ? undefined :
        read.thread.turns.filter((turn) => turn.status === "inProgress").sort((a, b) => b.id.localeCompare(a.id))[0];
      try {
        if (active) {
          await this.rpc.request("turn/steer", { threadId: this.threadId, expectedTurnId: active.id, input });
        } else {
          // No permission, model, or sandbox overrides: inherit the existing session.
          await this.rpc.request("turn/start", { threadId: this.threadId, input });
        }
        return;
      } catch (error) {
        if (!raceError(error)) {
          if (error instanceof RpcError) throw error;
          throw new DeliveryUncertainError("Codex delivery status is unknown. Automatic retry is suppressed; check history before resending.", { cause: error });
        }
      }
    }
    throw new Error("The Codex turn changed repeatedly; message was not accepted.");
  }
  close(): Promise<void> { return this.rpc.close(); }
}
