import { STARTUP_TIMEOUT_MS } from "./timeouts.js";

type Item = { content: string; display: boolean; triggerTurn: boolean };
type Saved = { id: string; file?: string; items: Item[]; timer: NodeJS.Timeout };
const key = Symbol.for("sideband.pi.pending.deliveries");
const saved = globalThis as typeof globalThis & { [key]?: Saved };
const MAX_BYTES = 256 * 1024;

/** PI defaults to one steer per assistant turn. Queue one room batch per boundary,
 * without changing the user's steering mode or blocking on an entire agent run. */
export function piRoomDelivery(api: any): { send(message: any, options: any): void; clear(): void } {
  let pending: Item[] = [], bytes = 0, context: any, busy = false, firstTurn = false, closed = false, timer: NodeJS.Timeout | undefined;
  const cancel = () => { if (timer) clearTimeout(timer); timer = undefined; };
  const isBusy = () => context?.isIdle ? !context.isIdle() : busy;
  const flush = () => {
    cancel(); if (closed || !pending.length) return;
    const batch = pending; pending = []; bytes = 0;
    api.sendMessage({ customType: "sideband", content: batch.map(item => item.content).join("\n\n"), display: batch.some(item => item.display) },
      { deliverAs: "steer", triggerTurn: batch.some(item => item.triggerTurn) });
  };
  const schedule = () => {
    if (closed || timer || !pending.length) return;
    timer = setTimeout(() => {
      timer = undefined;
      try { if (!isBusy()) flush(); else if (!busy) schedule(); }
      catch { try { context?.ui.notify("Sideband room delivery failed. Use room history for missed messages.", "error"); } catch { /* Retired runtime. */ } }
    }, 200);
    timer.unref();
  };
  api.on("session_start", (event: any, ctx: any) => {
    context = ctx; closed = false; busy = false;
    const previous = saved[key];
    if (previous) {
      delete saved[key]; clearTimeout(previous.timer);
      if (event.reason === "reload" && previous.id === ctx.sessionManager.getSessionId() && previous.file === ctx.sessionManager.getSessionFile?.()) {
        pending = previous.items; bytes = pending.reduce((sum, item) => sum + Buffer.byteLength(item.content) + 2, 0); schedule();
      }
    }
  });
  api.on("agent_start", () => { busy = true; firstTurn = true; cancel(); });
  api.on("turn_start", () => {
    // Only the first turn_start precedes PI's steering drain. Later starts run
    // after it; flushing there would stack another batch behind the current one.
    busy = true; if (firstTurn) flush(); firstTurn = false;
  });
  api.on("turn_end", (event: any) => {
    // Error/abort paths return without draining steers. Keep them outside PI's
    // queue until idle, instead of stranding them or restoring them into its editor.
    if (!["error", "aborted"].includes(event.message?.stopReason)) flush();
  });
  api.on("agent_end", () => { busy = false; schedule(); });
  api.on("session_shutdown", (event: any, ctx: any) => {
    closed = true; cancel();
    if (event.reason === "reload" && pending.length) {
      if (saved[key]) clearTimeout(saved[key]!.timer);
      const entry: Saved = { id: ctx.sessionManager.getSessionId(), file: ctx.sessionManager.getSessionFile?.(), items: pending, timer: undefined! };
      entry.timer = setTimeout(() => { if (saved[key] === entry) delete saved[key]; }, STARTUP_TIMEOUT_MS); entry.timer.unref(); saved[key] = entry;
    }
    pending = []; bytes = 0;
  });
  return { clear() { cancel(); pending = []; bytes = 0; }, send(message, options) {
    if (closed) throw new Error("The PI session has closed.");
    if (message.customType !== "sideband" || typeof message.content !== "string") { const { attribution: _attribution, ...content } = message; api.sendMessage(content, { ...options, deliverAs: "steer" }); return; }
    const size = Buffer.byteLength(message.content) + 2;
    if (pending.length >= 100 || bytes + size > MAX_BYTES) throw new Error("Sideband room delivery backlog is full; use room history for missed messages.");
    pending.push({ content: message.content, display: message.display, triggerTurn: options?.triggerTurn === true }); bytes += size;
    if (!isBusy()) schedule();
  } };
}
