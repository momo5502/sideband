// Run actual marketplace commands in an isolated harness home; never change a user's install.
import { mkdtemp, mkdir, copyFile, cp, readdir, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const harness = process.argv[2]; const executable = process.argv[3];
if (!["codex", "claude"].includes(harness) || !executable) throw new Error("Use node scripts/test-plugin-install.mjs codex|claude /path/to/harness-executable [marketplace-source].");
const root = resolve(import.meta.dirname, "..");
const directory = await mkdtemp(join(tmpdir(), "sideband-plugin-install-"));
const snapshot = join(directory, "marketplace"); const home = join(directory, "harness-home");
await mkdir(snapshot); await mkdir(home);
for (const part of [".agents", ".codex-plugin", ".claude-plugin", "skills"]) await cp(join(root, part), join(snapshot, part), { recursive: true });
await mkdir(join(snapshot, "dist"));
await copyFile(join(root, "dist/sideband.cjs"), join(snapshot, "dist/sideband.cjs"));
await copyFile(join(root, "dist/THIRD_PARTY_NOTICES.txt"), join(snapshot, "dist/THIRD_PARTY_NOTICES.txt"));
const env = { ...process.env, ...(harness === "codex" ? { CODEX_HOME: home } : { CLAUDE_CONFIG_DIR: home }),
  SIDEBAND_STATE_DIR: join(directory, "state"), SIDEBAND_CLAUDE_SERVER: "", SIDEBAND_CLAUDE_PASSWORD: "" };
function run(args) {
  const result = spawnSync(executable, args, { env, cwd: snapshot, encoding: "utf8", windowsHide: true, timeout: 120_000 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${harness} ${args.join(" ")} failed:\n${result.stderr}\n${result.stdout}`);
  return result.stdout;
}
async function bundles(path) {
  const result = [];
  for (const entry of await readdir(path, { withFileTypes: true })) {
    if (entry.isDirectory()) result.push(...await bundles(join(path, entry.name)));
    else if (entry.name === "sideband.cjs") result.push(join(path, entry.name));
  }
  return result;
}
let client;
try {
  const source = process.argv[4] ?? snapshot;
  run(["plugin", "marketplace", "add", source]);
  run(["plugin", harness === "codex" ? "add" : "install", "sideband@sideband"]);
  const cached = await bundles(home);
  if (cached.length !== 1) throw new Error(`Expected one standalone runtime in isolated plugin cache; found ${cached.length}.`);
  let command = process.execPath; let args = [cached[0], "mcp", "--harness", harness]; let cwd = snapshot;
  if (harness === "codex") {
    const configured = JSON.parse(run(["mcp", "list", "--json"]));
    const server = configured.find(entry => entry.name.includes("sideband"));
    if (!server) throw new Error("Installed Codex plugin did not register its MCP server.");
    const transport = server.transport ?? server;
    command = transport.command; args = transport.args; cwd = transport.cwd;
    if (!args.includes("dist/sideband.cjs") || !cwd) throw new Error("Plugin MCP runtime/cwd was not resolved.");
  } else {
    const manifest = JSON.parse(await readFile(join(resolve(cached[0], "../.."), ".claude-plugin/plugin.json"), "utf8"));
    if (manifest.userConfig.password.sensitive !== true) throw new Error("Native password field is not sensitive.");
  }
  client = new Client({ name: "marketplace-install-check", version: "1" });
  await client.connect(new StdioClientTransport({ command, args, cwd, env }));
  if ((await client.listTools()).tools.length !== 12) throw new Error("Installed plugin tool handshake failed.");
  const status = await client.callTool({ name: "sideband_status", arguments: {}, ...(harness === "codex" ? { _meta: { threadId: "install-check" } } : {}) });
  if (JSON.stringify(status.content) !== JSON.stringify([{ type: "text", text: '{"state":"off"}' }])) throw new Error("Installed plugin is not safely off by default.");
  console.log(`${harness}: actual marketplace install, cached standalone runtime and MCP tool handshake passed; live user configuration untouched.`);
} finally {
  await client?.close();
  if (!directory.startsWith(join(tmpdir(), "sideband-plugin-install-"))) throw new Error("Unsafe test directory.");
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
