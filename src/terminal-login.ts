import { emitKeypressEvents } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { RoomClient } from "./room-client.js";
import { RoomProfiles } from "./room-profiles.js";
import { serverUrl, type ConnectionProfile } from "./room-protocol.js";

type TerminalInput = Readable & { isTTY?: boolean; isRaw?: boolean; setRawMode(mode: boolean): unknown };
type TerminalOutput = Writable & { isTTY?: boolean };

/** Reads only from a real terminal. Never echo the credential or accept piped model input. */
export async function hiddenInput(prompt: string, input: TerminalInput = process.stdin, output: TerminalOutput = process.stdout): Promise<string> {
  if (!input.isTTY || !output.isTTY) throw new Error("Login requires an interactive terminal. Never put passwords in chat or command arguments.");
  output.write(prompt); emitKeypressEvents(input);
  const wasRaw = !!input.isRaw; input.setRawMode(true); input.resume();
  return new Promise((resolve, reject) => {
    let secret = ""; let finished = false;
    const finish = (error?: Error) => {
      if (finished) return; finished = true;
      input.off("keypress", handler); input.off("end", ended);
      input.setRawMode(wasRaw); input.pause(); output.write("\n");
      if (error) reject(error); else resolve(secret);
      secret = "";
    };
    const ended = () => finish(new Error("Login cancelled."));
    const handler = (value: string, key: { ctrl?: boolean; name?: string } = {}) => {
      if (key.ctrl && key.name === "c") return finish(new Error("Login cancelled."));
      if (key.name === "return" || key.name === "enter") return finish();
      if (key.name === "backspace") { secret = secret.slice(0, -1); return; }
      if (!key.ctrl && value && !/[\x00-\x1f\x7f]/.test(value)) secret += value;
    };
    input.on("keypress", handler); input.once("end", ended);
  });
}

/** Verify pinned TLS and authentication before replacing a saved profile. No room is joined. */
export async function loginAndSave(name: string, profile: ConnectionProfile, profiles = new RoomProfiles()): Promise<void> {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(name)) throw new Error("Invalid connection profile name.");
  const client = new RoomClient(profile);
  try { await client.connect(); await profiles.save(name, profile); }
  finally { await client.close(); }
}

export async function terminalLogin(endpoint: string, profile: string): Promise<void> {
  const server = serverUrl(endpoint);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(profile)) throw new Error("Invalid connection profile name.");
  const password = await hiddenInput("Server password (hidden): ");
  await loginAndSave(profile, { server, password });
  console.log(`Login verified. Saved profile '${profile}'. Ask your agent to join a room; it connects automatically.`);
}
