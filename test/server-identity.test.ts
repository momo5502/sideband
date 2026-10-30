import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { RoomServer } from "../src/room-server.js";
import { RoomClient } from "../src/room-client.js";
import { createServerIdentity, loadServerIdentity, saveServerIdentity } from "../src/server-identity.js";

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "sideband-server-state-"));
  const credentialsFile = join(directory, "server-credentials.json");
  const servers = new Set<RoomServer>(); const clients: RoomClient[] = [];
  return { directory, credentialsFile,
    async start(rotatePassword = false, port = 0) {
      const server = await RoomServer.start({ host: "127.0.0.1", port, credentialsFile, rotatePassword }); servers.add(server); return server;
    },
    async stop(server: RoomServer) { servers.delete(server); await server.close(); },
    async client(server: RoomServer, password = server.password) {
      const client = new RoomClient({ server: `127.0.0.1:${server.port}`, password }); clients.push(client); await client.connect(); return client;
    },
    async close() {
      await Promise.all(clients.map(client => client.close())); await Promise.all([...servers].map(server => server.close()));
      assert.ok(directory.startsWith(join(tmpdir(), "sideband-server-state-"))); await rm(directory, { recursive: true, force: true });
    },
  };
}

test("persisted server password and certificate survive restarts, but rooms/history do not", async () => {
  const f = await fixture();
  try {
    const first = await f.start(); const password = first.password; const fingerprint = first.fingerprint;
    const bytes = await readFile(f.credentialsFile, "utf8");
    if (process.platform !== "win32") assert.equal((await stat(f.credentialsFile)).mode & 0o777, 0o600);
    const a = await f.client(first); await a.joinRoom("old-room"); await a.send("old history");
    await f.stop(first); await a.close();
    const next = await f.start();
    assert.ok(next.password === password); assert.equal(next.fingerprint, fingerprint);
    assert.ok((await readFile(f.credentialsFile, "utf8")) === bytes, "normal startup never rewrites the identity file");
    const b = await f.client(next, password); assert.deepEqual(await b.listRooms(), []);
    await b.joinRoom("old-room"); assert.deepEqual(await b.history(), []);
  } finally { await f.close(); }
});

test("explicit rotation replaces credentials, rejects the old password and persists the replacement", async () => {
  const f = await fixture();
  try {
    const first = await f.start(); const password = first.password; await f.stop(first);
    const rotated = await f.start(true); const replacement = rotated.password;
    assert.ok(replacement !== password);
    await assert.rejects(f.client(rotated, password), /certificate|Password/);
    const client = await f.client(rotated); await client.close(); await f.stop(rotated);
    const restarted = await f.start(); assert.ok(restarted.password === replacement);
    await f.client(restarted, replacement);
  } finally { await f.close(); }
});

test("invalid saved credentials fail closed, without leaking file contents or replacing them", async () => {
  const f = await fixture(); const invalid = "do-not-log-this-fixture";
  try {
    await writeFile(f.credentialsFile, invalid);
    await assert.rejects(f.start(), error => error instanceof Error && /--rotate-password/.test(error.message) && !error.message.includes(invalid));
    assert.equal(await readFile(f.credentialsFile, "utf8"), invalid);
    const recovered = await f.start(true); await f.client(recovered);
    const identity = await loadServerIdentity(f.credentialsFile); assert.equal(identity?.version, 1);
    const wrongKey = await createServerIdentity();
    await writeFile(f.credentialsFile, JSON.stringify({ ...identity, privateKey: wrongKey.privateKey }));
    await assert.rejects(loadServerIdentity(f.credentialsFile), /Invalid server credentials/);
  } finally { await f.close(); }
});

test("failed startup on an occupied port cannot rotate a running server's saved credentials", async () => {
  const f = await fixture();
  try {
    const running = await f.start(); const bytes = await readFile(f.credentialsFile, "utf8");
    await assert.rejects(f.start(true, running.port), (error: NodeJS.ErrnoException) => error.code === "EADDRINUSE");
    assert.ok((await readFile(f.credentialsFile, "utf8")) === bytes);
    await f.client(running);
  } finally { await f.close(); }
});

test("racing first writes cannot overwrite a complete identity and clean up private temporary files", async () => {
  const f = await fixture();
  try {
    const identities = await Promise.all([createServerIdentity(), createServerIdentity()]);
    const results = await Promise.allSettled(identities.map(identity => saveServerIdentity(f.credentialsFile, identity, false)));
    assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
    const winner = results.findIndex(result => result.status === "fulfilled");
    assert.ok((await loadServerIdentity(f.credentialsFile))?.secret === identities[winner]!.secret);
    assert.deepEqual(await readdir(f.directory), ["server-credentials.json"]);
  } finally { await f.close(); }
});

test("occupied HTTP status port fails startup without rotating credentials or leaving the HTTPS port bound", async () => {
  const f = await fixture();
  const blocker = await RoomServer.start({ host: "127.0.0.1", port: 0 });
  const available = await RoomServer.start({ host: "127.0.0.1", port: 0 });
  const port = available.port; await available.close();
  try {
    const original = await f.start(); const password = original.password; await f.stop(original);
    const bytes = await readFile(f.credentialsFile, "utf8");
    await assert.rejects(RoomServer.start({ host: "127.0.0.1", port, statusPort: blocker.port,
      credentialsFile: f.credentialsFile, rotatePassword: true }), { code: "EADDRINUSE" });
    assert.ok(await readFile(f.credentialsFile, "utf8") === bytes);
    const retry = await f.start(false, port); assert.ok(retry.password === password);
  } finally { await blocker.close(); await f.close(); }
});

test("packaged server CLI reuses its default state file and rotates only with --rotate-password", { timeout: 20_000 }, async () => {
  const f = await fixture(); const children = new Set<ChildProcess>();
  const start = async (rotate = false) => {
    const child = spawn(process.execPath, [resolve("dist/sideband.cjs"), "server", "--host", "127.0.0.1", "--port", "0", "--status-port", "0", ...(rotate ? ["--rotate-password"] : [])],
      { env: { ...process.env, SIDEBAND_STATE_DIR: f.directory }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    children.add(child);
    let timer: NodeJS.Timeout;
    const password = await new Promise<string>((resolvePassword, reject) => {
      let output = "";
      timer = setTimeout(() => reject(new Error("Server CLI startup timed out.")), 5000);
      child.once("error", reject); child.once("exit", () => reject(new Error("Server CLI exited before startup.")));
      child.stdout!.on("data", chunk => {
        output += chunk;
        const match = /Password: (sb1\.[A-Za-z0-9_.-]+)/.exec(output);
        if (match) { output = ""; resolvePassword(match[1]!); }
      });
      child.stderr!.resume();
    }).finally(() => clearTimeout(timer));
    return { password, async stop() { const exited = once(child, "exit"); child.kill(); await exited; children.delete(child); } };
  };
  try {
    const first = await start(); const password = first.password; await first.stop();
    const next = await start(); assert.ok(next.password === password); await next.stop();
    const rotated = await start(true); const replacement = rotated.password; assert.ok(replacement !== password); await rotated.stop();
    const last = await start(); assert.ok(last.password === replacement); await last.stop();
  } finally {
    await Promise.all([...children].map(async child => { if (child.exitCode !== null) return; const exited = once(child, "exit"); child.kill(); await exited; }));
    await f.close();
  }
});
