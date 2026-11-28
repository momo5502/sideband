import { mkdir, open, readFile, readdir, rename, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { parsePassword, serverUrl, type ConnectionProfile } from "./room-protocol.js";

export const stateDirectory = process.env.SIDEBAND_STATE_DIR ?? join(homedir(), ".sideband");
export class RoomProfiles {
  constructor(readonly directory = stateDirectory, private readonly nativeProfile?: ConnectionProfile) {}
  private path(name: string): string {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(name)) throw new Error("Invalid connection profile name.");
    return join(this.directory, "connections", `${name}.json`);
  }
  async names(): Promise<string[]> {
    let names: string[] = [];
    try { names = (await readdir(join(this.directory, "connections"))).filter((name) => /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}\.json$/.test(name)).map((name) => name.slice(0, -5)); }
    catch { /* No terminal profiles yet. */ }
    if (this.nativeProfile) names.push("claude");
    return [...new Set(names)].sort();
  }
  async load(name: string): Promise<ConnectionProfile> {
    const path = this.path(name);
    if (name === "claude" && this.nativeProfile) {
      parsePassword(this.nativeProfile.password);
      return { server: serverUrl(this.nativeProfile.server), password: this.nativeProfile.password };
    }
    let value;
    try { value = JSON.parse(await readFile(path, "utf8")); }
    catch { throw new Error(`Connection profile '${name}' is unavailable. Use oh-my-pi's /sideband login HOST:PORT, sideband login in your terminal, or Claude's /plugin configure sideband@sideband dialog.`); }
    parsePassword(value.password);
    return { server: serverUrl(value.server), password: value.password };
  }
  async resolve(name?: string): Promise<{ name: string; profile: ConnectionProfile }> {
    if (name === undefined) {
      const names = await this.names();
      if (!names.length) throw new Error("No saved server. Use oh-my-pi's /sideband login HOST:PORT, sideband login in your terminal, or Claude's /plugin configure sideband@sideband dialog.");
      name = await this.defaultName();
      if (!name && names.length > 1) throw new Error(`Multiple saved servers: ${names.join(", ")}. Specify a profile in the join or rooms call.`);
      name ??= names[0]!;
    }
    return { name, profile: await this.load(name) };
  }
  async defaultName(): Promise<string | undefined> {
    const names = await this.names();
    try { const value = JSON.parse(await readFile(join(this.directory, "default-profile.json"), "utf8")); if (names.includes(value.name)) return value.name; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("Could not read the default server profile."); }
    return names.includes("default") ? "default" : names.length === 1 ? names[0] : undefined;
  }
  async setDefault(name: string): Promise<void> {
    await this.load(name);
    const { privateJson } = await import("./update-runtime.js");
    await privateJson(join(this.directory, "default-profile.json"), { name });
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
    if (name === "default") await this.setDefault(name);
  }
}
