import { mkdir, open, readFile, readdir, rename, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { parsePassword, serverUrl, type ConnectionProfile } from "./room-protocol.js";

export const stateDirectory = process.env.SIDEBAND_STATE_DIR ?? join(homedir(), ".sideband");
export class RoomProfiles {
  constructor(readonly directory = stateDirectory) {}
  private path(name: string): string {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(name)) throw new Error("Invalid connection profile name.");
    return join(this.directory, "connections", `${name}.json`);
  }
  async names(): Promise<string[]> {
    try { return (await readdir(join(this.directory, "connections"))).filter((name) => /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}\.json$/.test(name)).map((name) => name.slice(0, -5)).sort(); }
    catch { return []; }
  }
  async load(name: string): Promise<ConnectionProfile> {
    const path = this.path(name);
    let value;
    try { value = JSON.parse(await readFile(path, "utf8")); }
    catch { throw new Error(`Connection profile '${name}' is unavailable. Run sideband_setup or sideband configure first.`); }
    parsePassword(value.password);
    return { server: serverUrl(value.server), password: value.password };
  }
  async save(name: string, profile: ConnectionProfile): Promise<void> {
    const destination = this.path(name);
    parsePassword(profile.password);
    const normalized = { server: serverUrl(profile.server), password: profile.password.trim() };
    await mkdir(join(this.directory, "connections"), { recursive: true, mode: 0o700 });
    const temporary = `${destination}.${randomUUID()}.tmp`;
    const file = await open(temporary, "wx", 0o600);
    try { await file.writeFile(JSON.stringify(normalized)); await file.close(); await rename(temporary, destination); }
    catch (error) { await file.close().catch(() => {}); await unlink(temporary).catch(() => {}); throw error; }
  }
}
