import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { lock } from "proper-lockfile";
import { claudeConfigFile, trustClaudeWorkspaces } from "../src/claude-trust.js";
import { RoomProfiles } from "../src/room-profiles.js";
import { RoomServer } from "../src/room-server.js";
import { RoomClient } from "../src/room-client.js";
import { BrowserRoomClient } from "../src/browser-protocol.js";
import NodeWebSocket from "ws";
import { browserPage, until } from "./browser-fixture.js";
import { testTimeout } from "./waits.js";

test("Claude trust merges only the canonical workspace root and preserves profile settings", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sideband-claude-trust-")), file = join(directory, ".claude.json"), root = join(directory, "workspaces");
  try {
    assert.equal(claudeConfigFile(directory, "", ""), file);
    assert.equal(claudeConfigFile("unused", directory, ""), file);
    assert.equal(claudeConfigFile("unused", directory, "https://fixture.invalid"), join(directory, ".claude-custom-oauth.json"));
    await mkdir(root);
    const key = (await realpath(root)).replaceAll("\\", "/");
    const config = { theme: "dark", oauthAccount: { fixture: "keep-private" }, projects: { [key]: { allowedTools: ["Read"], custom: 42 }, "/unrelated": { hasTrustDialogAccepted: false } } };
    await writeFile(file, JSON.stringify(config));
    const results = await Promise.all([trustClaudeWorkspaces(root, file), trustClaudeWorkspaces(root, file)]);
    assert.deepEqual(results, [{ root: key }, { root: key }]);
    const saved = JSON.parse(await readFile(file, "utf8"));
    assert.deepEqual(saved, { ...config, projects: { ...config.projects, [key]: { ...config.projects[key], hasTrustDialogAccepted: true } } });
    assert.deepEqual((await readdir(directory)).sort(), [".claude.json", "workspaces"]);
    if (process.platform !== "win32") assert.equal((await stat(file)).mode & 0o777, 0o600);
    const before = await readFile(file, "utf8"); await trustClaudeWorkspaces(root, file); assert.equal(await readFile(file, "utf8"), before);
    for (const bad of ["{bad", "[]", '{"projects":[]}', JSON.stringify({ projects: { [key]: "broken" } })]) {
      await writeFile(file, bad); await assert.rejects(trustClaudeWorkspaces(root, file), /invalid|valid JSON/); assert.equal(await readFile(file, "utf8"), bad);
    }
  } finally { assert.ok(directory.startsWith(join(tmpdir(), "sideband-claude-trust-"))); await rm(directory, { recursive: true, force: true }); }
});

test("recording Claude trust refuses missing profiles and respects profile and workspace symlinks", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sideband-claude-trust-create-"));
  try {
    const file = join(directory, "custom-profile", ".claude.json"), root = join(directory, "root");
    await assert.rejects(trustClaudeWorkspaces(root, file), /Run Claude once/);
    await mkdir(join(directory, "custom-profile")); await writeFile(file, "{}");
    const result = await trustClaudeWorkspaces(root, file);
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")), { projects: { [result.root]: { hasTrustDialogAccepted: true } } });
    if (process.platform !== "win32") {
      const link = join(directory, "profile-link.json"); await symlink(file, link);
      const second = join(directory, "second-root"); await symlink(root, second, "dir"); await trustClaudeWorkspaces(second, link);
      const projects = JSON.parse(await readFile(file, "utf8")).projects;
      assert.equal(Object.keys(projects).length, 2); assert.equal(projects[second].hasTrustDialogAccepted, true);
      assert.equal((await realpath(link)), file);
    }
  } finally { assert.ok(directory.startsWith(join(tmpdir(), "sideband-claude-trust-create-"))); await rm(directory, { recursive: true, force: true }); }
});

test("trust waits for Claude's shared config lock and merges the document saved by its holder", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sideband-claude-trust-lock-")), file = join(directory, ".claude.json"), root = join(directory, "workspaces");
  let release: (() => Promise<void>) | undefined, operation: Promise<unknown> | undefined;
  try {
    await writeFile(file, "{}"); release = await lock(file, { realpath: false, lockfilePath: `${file}.lock` });
    let finished = false; operation = trustClaudeWorkspaces(root, file).finally(() => { finished = true; });
    await new Promise(resolve => setTimeout(resolve, 200)); assert.equal(finished, false);
    await writeFile(file, JSON.stringify({ writtenWhileLocked: true, projects: { "/unrelated": { hasTrustDialogAccepted: false } } }));
    await release(); release = undefined; await operation;
    const saved = JSON.parse(await readFile(file, "utf8"));
    assert.equal(saved.writtenWhileLocked, true); assert.equal(saved.projects["/unrelated"].hasTrustDialogAccepted, false);
    assert.equal(saved.projects[resolve(root).replaceAll("\\", "/")].hasTrustDialogAccepted, true);
    assert.deepEqual((await readdir(directory)).sort(), [".claude.json", "workspaces"]);
  } finally {
    await release?.(); await operation?.catch(() => {});
    assert.ok(directory.startsWith(join(tmpdir(), "sideband-claude-trust-lock-"))); await rm(directory, { recursive: true, force: true });
  }
});

test("web trust action requires explicit confirmation and records only the selected worker's own root", { timeout: testTimeout(45000) }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "sideband-claude-trust-web-")), root = join(directory, "workspaces"), config = join(directory, "claude-profile"), state = join(directory, "state");
  const server = await RoomServer.start({ host: "127.0.0.1", port: 0, statusPort: 0 });
  const profile = { server: `127.0.0.1:${server.port}`, password: server.password }, native = new RoomClient(profile);
  const origin = `http://127.0.0.1:${server.statusPort}`;
  const web = new BrowserRoomClient(`ws://127.0.0.1:${server.statusPort}/browser-ws`, server.password, "control-test", undefined, url => new NodeWebSocket(url, { origin }) as unknown as WebSocket);
  await new RoomProfiles(state).save("default", profile); await mkdir(config);
  const file = join(config, ".claude.json"); await writeFile(file, "{broken");
  const child = spawn(process.execPath, [resolve("dist/src/cli.js"), "worker", "--directory", root, "--omp", process.execPath, "--claude", process.execPath, "--codex", process.execPath], {
    windowsHide: true, env: { ...process.env, SIDEBAND_STATE_DIR: state, CLAUDE_CONFIG_DIR: config }, stdio: ["ignore", "pipe", "pipe"],
  });
  let log = ""; child.stdout!.on("data", chunk => { log += chunk; }); child.stderr!.on("data", chunk => { log += chunk; });
  const exited = new Promise<void>(resolve => child.once("exit", () => resolve()));
  let page: Awaited<ReturnType<typeof browserPage>> | undefined;
  try {
    await until(() => log.includes("connected and registered"), "Trust fixture worker did not register.");
    await native.connect();
    await assert.rejects(native.request("control.claude_trust", { machineId: "ignored", confirm: true }), /authenticated web panel/);
    await web.connect();
    const snapshot = await web.request<{ machines: { id: string }[] }>("control.list"), machineId = snapshot.machines[0]!.id;
    await assert.rejects(web.request("control.claude_trust", { machineId }), /Confirm trusting/);
    await assert.rejects(web.request("control.claude_trust", { machineId, confirm: false }), /Confirm trusting/);
    await assert.rejects(web.request("control.claude_trust", { machineId, confirm: true, root: directory }), /Unexpected field/);
    page = await browserPage(server); await page.login(); await page.settings(); page.click(page.button("Machines", "tab"));
    await until(() => !!page!.doc.querySelector("[data-claude-trust]"));
    assert.equal(await readFile(file, "utf8"), "{broken", "opening settings must not record trust");
    page.click(page.button("Trust Claude workspaces"));
    await until(() => page!.doc.querySelector("[data-claude-trust]")!.textContent!.includes("not valid JSON"));
    await writeFile(file, JSON.stringify({ theme: "dark", projects: { "/other-project": { hasTrustDialogAccepted: false } } }));
    page.click(page.button("Trust Claude workspaces"));
    await until(() => !!page!.doc.querySelector("[data-claude-trust] [role=status]"));
    const key = (await realpath(root)).replaceAll("\\", "/");
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")), { theme: "dark", projects: { "/other-project": { hasTrustDialogAccepted: false }, [key]: { hasTrustDialogAccepted: true } } });
    assert.match(page.get("[data-claude-trust] [role=status]").textContent!, /Start or resume/);
    assert.deepEqual(page.errors, []);
  } finally {
    await page?.close(); web.disconnect(); await native.close(); if (child.exitCode === null && child.signalCode === null) child.kill(); await exited; await server.close();
    assert.ok(directory.startsWith(join(tmpdir(), "sideband-claude-trust-web-"))); await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});
