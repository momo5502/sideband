// Smoke-test an isolated npm installation, not the source tree. Never print its ephemeral password.
import { spawn } from "node:child_process";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(process.argv[2] ?? ".cache/install-check/node_modules/sideband");
const entry = process.argv[3] ? resolve(process.argv[3]) : join(root, "dist/src/cli.js");
const { RoomClient } = await import(pathToFileURL(join(root, "dist/src/room-client.js")).href);
const child = spawn(process.execPath, [entry, "server", "--host", "127.0.0.1", "--port", "0"], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
let timer;
const clients = [];
try {
  const profile = await new Promise((resolve, reject) => {
    let stdout = ""; let stderr = "";
    timer = setTimeout(() => reject(new Error("Installed server did not start.")), 10000);
    child.on("error", reject); child.on("exit", () => reject(new Error(`Installed server exited: ${stderr}`)));
    child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-1000); });
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      const port = /listening on 127\.0\.0\.1:(\d+)/.exec(stdout);
      const password = /Password: (sb1\.[A-Za-z0-9_.-]+)/.exec(stdout);
      if (port && password) { stdout = ""; resolve({ server: `127.0.0.1:${port[1]}`, password: password[1] }); }
    });
  });
  clearTimeout(timer);
  const alice = new RoomClient(profile, "installed-alice"); const bob = new RoomClient(profile, "installed-bob"); clients.push(alice, bob);
  await alice.connect(); await bob.connect(); const room = await alice.createRoom("installed-smoke"); await bob.joinRoom(room.id);
  const arrived = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error("Installed client did not receive push.")), 3000);
    bob.onMessage((message) => message.text === "Package push check" ? resolve(message) : reject(new Error("Wrong message.")));
  });
  await alice.send("Package push check"); await arrived; clearTimeout(timer);
  if ((await bob.history()).length !== 1) throw new Error("Installed package history mismatch.");
  console.log("Installed npm package: server startup, generated credential, pinned TLS, signed client login, room join, live push and history all passed.");
} finally {
  clearTimeout(timer); await Promise.all(clients.map((client) => client.close())); child.kill();
  await new Promise((resolve) => { if (child.exitCode !== null || child.signalCode !== null) resolve(); else child.once("exit", resolve); });
}
