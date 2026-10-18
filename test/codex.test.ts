import test from "node:test";
import assert from "node:assert/strict";
import { CodexAdapter } from "../src/adapters/codex.js";
import { RpcError, type RpcConnection, CodexRpc } from "../src/rpc.js";
import { WebSocketServer } from "ws";
import type { Delivery } from "../src/protocol.js";

const delivery: Delivery = { messageId: "m", channelId: "c", sender: { id: "peer" }, senderAccountId: "bot", text: "Check CI", attachments: [], createdAt: 1000 };
class FakeRpc implements RpcConnection {
  calls: { method: string; params?: Record<string, unknown> }[] = [];
  loaded = ["current", "other"];
  status = "active";
  id = "current";
  turns = [{ id: "turn-001", status: "completed" }, { id: "turn-002", status: "inProgress" }];
  failure?: Error;
  async request<T>(method: string, params?: Record<string, unknown>): Promise<T> {
    this.calls.push({ method, params });
    if (method === "thread/loaded/list") return { data: this.loaded } as T;
    if (method === "thread/read") return { thread: { id: this.id, status: { type: this.status }, turns: this.turns } } as T;
    if (this.failure) { const failure = this.failure; this.failure = undefined; this.status = "idle"; throw failure; }
    return {} as T;
  }
  async close(): Promise<void> {}
}
test("binds only exact loaded session; never starts/resumes another thread", async () => {
  const rpc = new FakeRpc();
  await new CodexAdapter(rpc, "current").prepare();
  await assert.rejects(new CodexAdapter(rpc, "absent").prepare(), /not loaded/);
  assert.deepEqual(rpc.calls.map((call) => call.method), ["thread/loaded/list", "thread/loaded/list"]);
});
test("busy session gets turn/steer with exact expectedTurnId, not queue", async () => {
  const rpc = new FakeRpc();
  await new CodexAdapter(rpc, "current").deliver(delivery);
  const call = rpc.calls.at(-1)!;
  assert.equal(call.method, "turn/steer");
  assert.deepEqual(Object.keys(call.params!).sort(), ["expectedTurnId", "input", "threadId"]);
  assert.equal(call.params!.expectedTurnId, "turn-002");
  assert.equal(call.params!.threadId, "current");
  assert.equal((call.params!.input as { text: string }[])[0]!.text, '<sideband sender="#peer">\nCheck CI\n</sideband>');
});
test("idle wake inherits settings; stale inProgress turn is not steered", async () => {
  const rpc = new FakeRpc(); rpc.status = "idle";
  await new CodexAdapter(rpc, "current").deliver(delivery);
  const call = rpc.calls.at(-1)!;
  assert.equal(call.method, "turn/start");
  assert.deepEqual(Object.keys(call.params!).sort(), ["input", "threadId"]);
  assert.equal((call.params!.input as { text: string }[])[0]!.text, '<sideband sender="#peer">\nCheck CI\n</sideband>');
});
test("explicit turn race refreshes state and delivers once", async () => {
  const rpc = new FakeRpc(); rpc.failure = new RpcError("no active turn to steer", -32600);
  await new CodexAdapter(rpc, "current").deliver(delivery);
  assert.deepEqual(rpc.calls.map((call) => call.method), ["thread/read", "turn/steer", "thread/read", "turn/start"]);
});
test("timeouts/unknown errors are never retried (ambiguous acceptance)", async () => {
  const rpc = new FakeRpc(); rpc.failure = new Error("timeout; status unknown");
  await assert.rejects(new CodexAdapter(rpc, "current").deliver(delivery), /unknown/);
  assert.equal(rpc.calls.length, 2);
});
test("wrong or unloaded thread never receives input", async () => {
  for (const field of ["wrong", "unloaded"]) {
    const rpc = new FakeRpc();
    if (field === "wrong") rpc.id = "other"; else rpc.status = "notLoaded";
    await assert.rejects(new CodexAdapter(rpc, "current").deliver(delivery), /no longer loaded/);
    assert.equal(rpc.calls.length, 1);
  }
});
test("real WebSocket JSON-RPC handshake and correlated responses", async () => {
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const methods: string[] = [];
  const approvalReplies: unknown[] = [];
  server.on("connection", (socket) => {
    socket.send(JSON.stringify({ id: "approval-one", method: "item/commandExecution/requestApproval", params: {} }));
    socket.on("message", (data) => {
      const message = JSON.parse(data.toString());
      if (message.id === "approval-one") { approvalReplies.push(message); return; }
      methods.push(message.method);
      if (message.id) socket.send(JSON.stringify({ id: message.id, result: message.method === "thread/loaded/list" ? { data: ["current"] } : {} }));
    });
  });
  let rpc: CodexRpc | undefined;
  try {
    rpc = await CodexRpc.connect({ url: `ws://127.0.0.1:${address.port}` });
    assert.deepEqual(await rpc.request("thread/loaded/list"), { data: ["current"] });
    assert.deepEqual(methods, ["initialize", "initialized", "thread/loaded/list"]);
    assert.deepEqual(approvalReplies, [], "delivery-only connection must not consume harness approval prompts");
  } finally {
    await rpc?.close();
    for (const client of server.clients) client.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
test("remote unauthenticated endpoints rejected", async () => {
  await assert.rejects(CodexRpc.connect({ url: "ws://example.com" }), /only a local/);
});
