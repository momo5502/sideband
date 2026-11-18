// Optional Windows integration smoke: opens only an owned fake TUI, never another terminal.
import { mkdtemp, writeFile, readFile, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import assert from "node:assert/strict";
import { NativeView } from "../dist/src/native-view.js";
if (process.platform !== "win32") throw Error("This integration check requires Windows.");
const directory = await mkdtemp(join(tmpdir(), "sideband-console-check-")), script = join(directory, "fake-tui.mjs"), ready = join(directory, "ready"), result = join(directory, "result.json");
await writeFile(script, `import{writeFileSync}from'node:fs';if(!process.stdin.isTTY)throw Error('no real terminal');process.stdin.setRawMode(true);writeFileSync(${JSON.stringify(ready)},'ready');let data='';process.stdin.on('data',chunk=>{data+=chunk.toString('utf8');if(data.endsWith('\\r')){writeFileSync(${JSON.stringify(result)},JSON.stringify(data));process.exit(0);}});`);
let closed;
const exited = new Promise((resolve2) => {
  closed = resolve2;
});
const view = new NativeView(directory, resolve("dist/src/cli.js"), { event() {
}, state() {
}, exit() {
}, tool: async () => ({}) }, (error) => closed(error));
try {
  await view.start({ command: process.execPath }, [script], directory);
  const end = Date.now() + 8e3;
  while (true) {
    try {
      await access(ready);
      break;
    } catch {
      if (Date.now() > end) throw Error("test terminal did not become ready");
      await new Promise((r) => setTimeout(r, 25));
    }
  }
  const text = "Hello\nWorld: " + String.fromCodePoint(228, 128512) + " $() `literal`";
  await view.input("", true);
  await view.input(text);
  await Promise.race([exited, new Promise((_, reject) => setTimeout(() => reject(Error("input not received")), 5e3))]);
  const actual = JSON.parse(await readFile(result, "utf8"));
  assert.equal(actual, "\x1B\x1B[200~" + text + "\x1B[201~\r");
  console.log("Real Windows console: owned terminal, Escape, bracketed multiline paste, Unicode and Enter passed.");
} finally {
  await view.stop();
  if (!directory.startsWith(join(tmpdir(), "sideband-console-check-"))) throw Error("Unsafe cleanup");
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
