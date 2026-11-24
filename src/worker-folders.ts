import { opendir, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, parse, relative, resolve } from "node:path";
import { homedir } from "node:os";
import { execFile } from "node:child_process";
import type { FolderListing } from "./orchestration-protocol.js";

let driveCache: { at: number; value: Promise<string[]> } | undefined;
function driveRoots(): Promise<string[]> {
  if (driveCache && Date.now() - driveCache.at < 60000) return driveCache.value;
  const value = new Promise<string[]>(resolve => execFile("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "[System.IO.Directory]::GetLogicalDrives()"], { windowsHide: true, timeout: 5000, maxBuffer: 8192 }, (error, output) => resolve(error ? [] : output.split(/\r?\n/).filter(path => /^[a-z]:\\$/i.test(path)))));
  driveCache = { at: Date.now(), value }; return value;
}

/** Existing folders are used in place. This module never creates or changes them. */
export async function existingFolder(input: string, pinned = false): Promise<string> {
  if (!isAbsolute(input) || process.platform === "win32" && !(/^[a-z]:[\\/]/i.test(input) || /^\\\\[^\\]+\\[^\\]+/.test(input)) || /[\x00-\x1f]/.test(input)) throw new Error("Choose an absolute folder path on this machine.");
  const canonical = await realpath(input).catch(() => { throw new Error("The selected folder is missing or inaccessible on this machine."); });
  if (canonical.length > 4096) throw new Error("The selected folder path is too long.");
  if (!(await stat(canonical)).isDirectory()) throw new Error("The selected path is not a folder.");
  if (pinned && relative(resolve(input), canonical) !== "") throw new Error("The saved folder now resolves to a different location. Restore the original folder or launch a new agent with the new location.");
  return canonical;
}
export async function browseFolders(input?: string, cursor = ""): Promise<FolderListing> {
  const path = await existingFolder(input ?? homedir()), folder = await opendir(path), entries: FolderListing["entries"] = [];
  let more = false;
  let stalled = false;
  const probeDeadline = Date.now() + 10000;
  const directoryEntry = async (path: string): Promise<boolean> => {
    if (Date.now() >= probeDeadline) stalled = true;
    if (stalled) return false;
    return new Promise<boolean>(resolve => {
      // A failed network link must not start an unbounded queue of further stat calls.
      const timer = setTimeout(() => { stalled = true; resolve(false); }, Math.min(5000, Math.max(1, probeDeadline - Date.now())));
      void stat(path).then(info => { clearTimeout(timer); resolve(info.isDirectory()); }, () => { clearTimeout(timer); resolve(false); });
    });
  };
  // Stream directory entries; do not collect an unbounded directory into memory.
  for await (const entry of folder) {
    if (entry.name.length > 255 || entry.name <= cursor || /[\x00-\x1f]/.test(entry.name)) continue;
    if (!entry.isDirectory()) {
      // Unknown dirent types occur on network/FUSE filesystems. Known non-directories
      // need no I/O; symlinks and unknown types share the bounded probe.
      if (!entry.isSymbolicLink() && (entry.isFile() || entry.isBlockDevice() || entry.isCharacterDevice() || entry.isFIFO() || entry.isSocket())) continue;
      if (!await directoryEntry(resolve(path, entry.name))) continue;
    }
    entries.push({ name: entry.name, path: resolve(path, entry.name) });
    entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    if (entries.length > 100) { entries.pop(); more = true; }
  }
  const root = parse(path).root, parent = dirname(path);
  const roots = process.platform === "win32" ? [...new Set([root, ...await driveRoots()])] : [root];
  while (entries.length && Buffer.byteLength(JSON.stringify({ path, parent, roots, entries })) > 128 * 1024) { entries.pop(); more = true; }
  return { path, parent: parent === path ? null : parent, roots, entries, ...(more ? { next: entries.at(-1)!.name } : {}), ...(stalled ? { partial: true } : {}) };
}
