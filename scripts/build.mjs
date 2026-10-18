import { rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";
import { spawnSync } from "node:child_process";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const output = join(root, "dist");
if (relative(root, output) !== "dist") throw new Error("Unsafe build output path.");
// Only the explicitly named generated build directory is removed, never workspace/source state.
await rm(output, { recursive: true, force: true });
const result = spawnSync(process.execPath, [join(root, "node_modules/typescript/bin/tsc"), "-p", join(root, "tsconfig.json")], { stdio: "inherit", cwd: root, windowsHide: true });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
