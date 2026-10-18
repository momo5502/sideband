import { rm, readFile, readdir, writeFile } from "node:fs/promises";
import { build } from "esbuild";
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
if (result.status !== 0) process.exit(result.status ?? 1);
// A Git-installed harness plugin cannot depend on npm install/prepare being run.
// Bundle all runtime dependencies; optional ws native accelerators stay disabled.
const bundled = await build({ absWorkingDir: root, entryPoints: ["src/cli.ts"], outfile: "dist/sideband.cjs",
  bundle: true, platform: "node", format: "cjs", target: "node22", minify: true,
  legalComments: "inline", metafile: true, define: { "process.env.WS_NO_BUFFER_UTIL": '"1"', "process.env.WS_NO_UTF_8_VALIDATE": '"1"' } });
// Preserve third-party license files for dependencies included in the standalone runtime.
const packages = new Set();
for (const input of Object.keys(bundled.metafile.inputs)) {
  if (!input.includes("node_modules/")) continue;
  let directory = dirname(join(root, input));
  while (directory !== root && relative(root, directory) && !relative(root, directory).startsWith("..")) {
    try {
      const manifest = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
      if (manifest.name && manifest.version) { packages.add(directory); break; }
    } catch { /* Try the enclosing package, not an internal module-format marker. */ }
    directory = dirname(directory);
  }
}
const notices = [];
for (const directory of [...packages].sort()) {
  const manifest = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
  const licenses = (await readdir(directory)).filter(name => /^(licen[cs]e|copying|notice)(\.|$)/i.test(name));
  if (!licenses.length) throw new Error(`Missing bundled license for ${manifest.name}.`);
  for (const name of licenses.sort()) notices.push(`${manifest.name}@${manifest.version} — ${name}\n${await readFile(join(directory, name), "utf8")}`);
}
await writeFile(join(output, "THIRD_PARTY_NOTICES.txt"), notices.join("\n\n---\n\n"));
