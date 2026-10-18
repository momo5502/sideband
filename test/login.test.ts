import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { mkdtemp, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hiddenInput, loginAndSave } from "../src/terminal-login.js";
import { RoomProfiles } from "../src/room-profiles.js";
import { RoomServer } from "../src/room-server.js";
import { parsePassword } from "../src/room-protocol.js";

class Terminal extends PassThrough {
  isTTY = true; isRaw = false;
  setRawMode(mode: boolean): this { this.isRaw = mode; return this; }
}
test("hidden terminal login never echoes secrets and restores terminal state", async () => {
  const input = new Terminal(); const output = new Terminal(); let printed = "";
  output.on("data", chunk => { printed += chunk; });
  const secret = hiddenInput("Password: ", input, output);
  input.emit("keypress", "not-a-real-passworX", {});
  input.emit("keypress", "", { name: "backspace" });
  input.emit("keypress", "d", {});
  input.emit("keypress", "\r", { name: "return" });
  assert.equal(await secret, "not-a-real-password");
  assert.equal(printed, "Password: \n");
  assert.equal(input.isRaw, false); assert.equal(input.listenerCount("keypress"), 0);
  input.isRaw = true;
  const cancelled = hiddenInput("Password: ", input, output);
  input.emit("keypress", "secret-to-discard", {}); input.emit("keypress", "\x03", { ctrl: true, name: "c" });
  await assert.rejects(cancelled, /cancelled/);
  assert.equal(input.isRaw, true); assert.ok(!printed.includes("secret-to-discard"));
  input.isTTY = false;
  await assert.rejects(hiddenInput("Password: ", input, output), /interactive terminal/);
  assert.equal(printed, "Password: \nPassword: \n");
  input.destroy(); output.destroy();
});

test("terminal login verifies TLS/auth before saving, and failed login preserves existing credentials", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sideband-login-"));
  const profiles = new RoomProfiles(directory);
  const server = await RoomServer.start({ host: "127.0.0.1", port: 0 });
  const profile = { server: `127.0.0.1:${server.port}`, password: server.password };
  try {
    await loginAndSave("work", profile, profiles);
    assert.equal((await profiles.load("work")).password, profile.password);
    const { fingerprint } = parsePassword(profile.password);
    await assert.rejects(loginAndSave("work", { ...profile, password: `sb1.${fingerprint}.${"x".repeat(43)}` }, profiles), /password/i);
    assert.equal((await profiles.load("work")).password, profile.password);
    await assert.rejects(loginAndSave("../escape", profile, profiles), /profile name/);
  } finally { await server.close(); await rm(directory, { recursive: true, force: true }); }
});

test("native Claude credentials are available only as a profile name, without writing a duplicate secret file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sideband-native-profile-"));
  const server = await RoomServer.start({ host: "127.0.0.1", port: 0 });
  try {
    const profiles = new RoomProfiles(directory, { server: `127.0.0.1:${server.port}`, password: server.password });
    assert.deepEqual(await profiles.names(), ["claude"]);
    assert.equal((await profiles.load("claude")).password, server.password);
    await assert.rejects(access(join(directory, "connections")));
  } finally { await server.close(); await rm(directory, { recursive: true, force: true }); }
});
