import { createPrivateKey, randomBytes, randomUUID, X509Certificate } from "node:crypto";
import { link, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { generate } from "selfsigned";

export type ServerIdentity = { version: 1; privateKey: string; certificate: string; secret: string };

export async function createServerIdentity(): Promise<ServerIdentity> {
  const tls = await generate([{ name: "commonName", value: "sideband" }], { keyType: "ec", curve: "P-256", algorithm: "sha256" });
  return { version: 1, privateKey: tls.private, certificate: tls.cert, secret: randomBytes(32).toString("base64url") };
}

/** A broken existing file must never silently change the server password or certificate pin. */
export async function loadServerIdentity(path: string): Promise<ServerIdentity | undefined> {
  let encoded: string;
  try { encoded = await readFile(path, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(`Cannot read server credentials at ${path}. Refusing to generate replacements.`);
  }
  try {
    const value = JSON.parse(encoded);
    if (value?.version !== 1 || typeof value.privateKey !== "string" || typeof value.certificate !== "string" ||
      typeof value.secret !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value.secret) ||
      !new X509Certificate(value.certificate).checkPrivateKey(createPrivateKey(value.privateKey))) throw new Error("Invalid identity.");
    return { version: 1, privateKey: value.privateKey, certificate: value.certificate, secret: value.secret };
  } catch {
    throw new Error(`Invalid server credentials at ${path}. Restore the file or explicitly replace it with --rotate-password.`);
  }
}

/** Commit a complete, private file atomically. Initial creation cannot overwrite a racing writer. */
export async function saveServerIdentity(path: string, identity: ServerIdentity, replace: boolean): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  const file = await open(temporary, "wx", 0o600);
  try {
    await file.writeFile(JSON.stringify(identity)); await file.sync(); await file.close();
    if (replace) await rename(temporary, path);
    else await link(temporary, path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error("Server credentials were created by another process. Retry startup to use them; no credentials were replaced.");
    }
    throw new Error(`Cannot save server credentials at ${path}. The server was not started and existing credentials were not replaced.`);
  } finally { await file.close().catch(() => {}); await unlink(temporary).catch(() => {}); }
}
