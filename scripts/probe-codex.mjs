// Read-only live probe using the actual adapter. Never starts/resumes a thread or sends model input.
import { CodexRpc } from "../dist/src/rpc.js";
import { CodexAdapter } from "../dist/src/adapters/codex.js";

let rpc;
try {
  rpc = await CodexRpc.connect();
  const loaded = await rpc.request("thread/loaded/list");
  const target = process.env.CODEX_THREAD_ID || process.env.CODEX_SESSION_ID;
  const report = { proxyConnected: true, sessionIdAvailable: Boolean(target), loadedThreadCount: loaded.data.length, currentSessionLoaded: loaded.data.includes(target) };
  if (report.currentSessionLoaded) {
    await new CodexAdapter(rpc, target).prepare();
    const result = await rpc.request("thread/read", { threadId: target, includeTurns: true });
    report.currentSessionStatus = result.thread.status;
    report.activeTurnCount = result.thread.turns.filter((turn) => turn.status === "inProgress").length;
    report.adapterPreflightPassed = true;
  }
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally { await rpc?.close(); }
