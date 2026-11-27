import test from "node:test";
import assert from "node:assert/strict";
import { piRoomDelivery } from "../src/pi-delivery.js";

function fixture() {
  const handlers = new Map<string, Function[]>(), sent: any[] = [];
  let busy = false, session = "batch-session";
  const ctx = { isIdle: () => !busy, sessionManager: { getSessionId: () => session, getSessionFile: () => `${session}.jsonl` }, ui: { notify() {} } };
  let reenter: (() => void) | undefined;
  const delivery = piRoomDelivery({ on: (name: string, handler: Function) => handlers.set(name, [...(handlers.get(name) ?? []), handler]), sendMessage: (message: any, options: any) => { sent.push({ message, options }); reenter?.(); } });
  return { sent, delivery, busy(value: boolean) { busy = value; }, session(value: string) { session = value; }, reenter(fn: () => void) { reenter = fn; },
    async emit(name: string, event: object = {}) { for (const handler of handlers.get(name) ?? []) await handler(event, ctx); },
    push(text: string) { delivery.send({ customType: "sideband", content: text, display: true, attribution: "agent" }, { deliverAs: "aside", triggerTurn: true }); } };
}

test("PI delivers the entire waiting room burst at the next turn boundary, including a tool-free final turn", async () => {
  const f = fixture(); await f.emit("session_start"); f.busy(true); await f.emit("agent_start");
  for (let i = 1; i <= 5; i++) f.push(`<sideband sender="person-${i}">message ${i}</sideband>`);
  assert.equal(f.sent.length, 0, "busy room messages stay outside PI's one-at-a-time queue");
  await f.emit("turn_end", { message: { stopReason: "stop" }, toolResults: [] });
  assert.equal(f.sent.length, 1);
  for (let i = 1; i <= 5; i++) assert.ok(f.sent[0].message.content.includes(`person-${i}`));
  assert.equal(f.sent[0].message.content.split("\n\n").length, 5);
  assert.deepEqual(f.sent[0].options, { deliverAs: "steer", triggerTurn: true });
  assert.equal(f.sent[0].message.attribution, undefined);
  // Even a PI queue configured to drain one item now yields all five messages.
  const queue = [...f.sent]; assert.equal(queue.shift()!.message.content.match(/<sideband /g).length, 5); assert.equal(queue.length, 0);
  await f.emit("turn_end"); assert.equal(f.sent.length, 1, "a consumed batch is never sent twice");
  await f.emit("session_shutdown", { reason: "quit" });
});

test("PI coalesces idle bursts and wakes for late arrivals; errors and aborts flush only after idle", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture(); await f.emit("session_start");
  for (let i = 0; i < 5; i++) f.push(`idle-${i}`);
  assert.equal(f.sent.length, 0); t.mock.timers.tick(200); assert.equal(f.sent.length, 1);
  for (const reason of ["aborted", "error"]) {
    f.busy(true); await f.emit("agent_start"); f.push(reason);
    await f.emit("turn_end", { message: { stopReason: reason } }); assert.equal(f.sent.length, reason === "aborted" ? 1 : 2);
    await f.emit("agent_end"); t.mock.timers.tick(200);
    assert.equal(f.sent.length, reason === "aborted" ? 1 : 2, "agent_end listeners may still be running; do not queue into the retiring run");
    f.busy(false); t.mock.timers.tick(200);
    assert.equal(f.sent.at(-1).message.content, reason); assert.equal(f.sent.at(-1).options.triggerTurn, true);
  }
  f.busy(true); await f.emit("turn_end"); f.push("arrived after the last drain"); await f.emit("agent_end"); f.busy(false); t.mock.timers.tick(200);
  assert.equal(f.sent.at(-1).message.content, "arrived after the last drain");
  f.push("discard after off"); f.delivery.clear(); t.mock.timers.tick(200); assert.equal(f.sent.length, 4);
  await f.emit("session_shutdown", { reason: "quit" });
});

test("PI does not queue a second batch after a later turn's steering drain", async () => {
  const f = fixture(); await f.emit("session_start"); f.busy(true); await f.emit("agent_start"); await f.emit("turn_start");
  f.push("first response arrival"); await f.emit("turn_end"); assert.equal(f.sent.length, 1);
  // PI drains the first batch, then emits its next turn_start.
  f.push("after the drain"); await f.emit("turn_start"); assert.equal(f.sent.length, 1);
  f.push("during the next response"); await f.emit("turn_end"); assert.equal(f.sent.length, 2);
  assert.equal(f.sent[1].message.content, "after the drain\n\nduring the next response");
  await f.emit("session_shutdown", { reason: "quit" });
});

test("PI keeps reentrant pushes in the next batch and bounds the room backlog", async () => {
  const f = fixture(); await f.emit("session_start"); f.busy(true);
  f.push("first"); f.reenter(() => { if (f.sent.length === 1) f.push("arrived while flushing"); });
  await f.emit("turn_end"); assert.equal(f.sent.length, 1); await f.emit("turn_end");
  assert.equal(f.sent.length, 2); assert.equal(f.sent[1].message.content, "arrived while flushing");
  assert.throws(() => f.push("x".repeat(256 * 1024)), /backlog is full/);
  for (let i = 0; i < 100; i++) f.push(`item-${i}`);
  assert.throws(() => f.push("overflow"), /backlog is full/);
  await f.emit("session_shutdown", { reason: "quit" });
  assert.throws(() => f.push("old runtime"), /closed/);
});

test("PI transfers buffered room deliveries only to the same reloaded session", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const old = fixture(); await old.emit("session_start"); old.busy(true); old.push("buffered before reload");
  await old.emit("session_shutdown", { reason: "reload" }); old.delivery.clear();
  const fresh = fixture(); await fresh.emit("session_start", { reason: "reload" }); t.mock.timers.tick(200);
  assert.equal(old.sent.length, 0); assert.equal(fresh.sent[0].message.content, "buffered before reload");
  fresh.busy(true); fresh.push("must not reach a new session"); await fresh.emit("session_shutdown", { reason: "reload" });
  const other = fixture(); other.session("other-session"); await other.emit("session_start", { reason: "reload" }); t.mock.timers.tick(200);
  assert.equal(other.sent.length, 0); await other.emit("session_shutdown", { reason: "quit" });
});
