import { createHash, createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from "node:crypto";

export const VERSION = 1;
export const MAX_TEXT_BYTES = 8192;
export type AgentIdentity = { id: string; name?: string; publicKey: string };
export type Room = { id: string; name: string; members: number };
export type SignedMessage = { id: string; roomId: string; sender: AgentIdentity; text: string; signature: string; createdAt: number };
export type PresenceKind = "joined" | "left" | "disconnected" | "reconnected";
/** Server-observed membership, not a participant-authored or signed message. */
export type PresenceEvent = { id: string; roomId: string; kind: PresenceKind; participant: AgentIdentity; createdAt: number };
export type Login = { identity: AgentIdentity; room: Room | null; resumed: boolean };
export type ConnectionProfile = { server: string; password: string };
export class RoomError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = "RoomError"; }
}
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new RoomError("INVALID_ARGUMENT", "Expected an object.");
  return value as Record<string, unknown>;
}
export function fields(value: unknown, allowed: string[]): Record<string, unknown> {
  const result = object(value);
  if (Object.keys(result).some((key) => !allowed.includes(key))) throw new RoomError("INVALID_ARGUMENT", "Unexpected field.");
  return result;
}
export function text(value: unknown, label: string, max = 128): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max) throw new RoomError("INVALID_ARGUMENT", `Invalid ${label}.`);
  return value;
}
export function agentName(value: unknown): string | undefined {
  if (value === undefined || value === "") return undefined;
  const name = text(value, "agent name", 64);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(name)) throw new RoomError("INVALID_ARGUMENT", "Agent names use letters, digits, underscores and hyphens.");
  return name;
}
export function publicKey(encoded: string): KeyObject {
  if (!/^[A-Za-z0-9_-]{59}$/.test(encoded)) throw new RoomError("INVALID_KEY", "Expected an Ed25519 public key.");
  const key = createPublicKey({ key: Buffer.from(encoded, "base64url"), type: "spki", format: "der" });
  if (key.asymmetricKeyType !== "ed25519") throw new RoomError("INVALID_KEY", "Expected an Ed25519 public key.");
  return key;
}
export function identityFor(encoded: string, name?: string): AgentIdentity {
  const canonical = publicKey(encoded).export({ type: "spki", format: "der" }) as Buffer;
  return { id: `agent-${createHash("sha256").update(canonical).digest("base64url")}`, ...(name ? { name } : {}), publicKey: encoded };
}
export class AgentKeys {
  readonly identity: AgentIdentity;
  private readonly privateKey: KeyObject;
  constructor(name?: string) {
    const keys = generateKeyPairSync("ed25519");
    this.privateKey = keys.privateKey;
    this.identity = identityFor((keys.publicKey.export({ type: "spki", format: "der" }) as Buffer).toString("base64url"), agentName(name));
  }
  sign(data: string): string { return sign(null, Buffer.from(data), this.privateKey).toString("base64url"); }
}
export function validSignature(key: string, data: string, signature: unknown): boolean {
  try { return typeof signature === "string" && /^[A-Za-z0-9_-]{86}$/.test(signature) && verify(null, Buffer.from(data), publicKey(key), Buffer.from(signature, "base64url")); }
  catch { return false; }
}
export function loginProof(challenge: string, fingerprint: string, identity: AgentIdentity): string {
  return JSON.stringify(["sideband.login", VERSION, challenge, fingerprint, identity.id, identity.name ?? null]);
}
export function messageProof(message: Pick<SignedMessage, "id" | "roomId" | "sender" | "text">): string {
  return JSON.stringify(["sideband.message", VERSION, message.id, message.roomId, message.sender.id, message.sender.name ?? null, message.text]);
}
export function verifyMessage(value: unknown): value is SignedMessage {
  try {
    const message = object(value);
    const sender = object(message.sender);
    const identity = identityFor(text(sender.publicKey, "public key", 100), agentName(sender.name));
    if (identity.id !== sender.id || !Number.isFinite(message.createdAt)) return false;
    text(message.id, "message ID", 64); text(message.roomId, "room ID", 64);
    if (typeof message.text !== "string" || Buffer.byteLength(message.text) > MAX_TEXT_BYTES) return false;
    return validSignature(identity.publicKey, messageProof(message as SignedMessage), message.signature);
  } catch { return false; }
}
export function validPresence(value: unknown): value is PresenceEvent {
  try {
    const event = fields(value, ["id", "roomId", "kind", "participant", "createdAt"]);
    text(event.id, "event ID", 64); text(event.roomId, "room ID", 64);
    if (!["joined", "left", "disconnected", "reconnected"].includes(event.kind as string) || !Number.isFinite(event.createdAt)) return false;
    const participant = object(event.participant);
    return identityFor(text(participant.publicKey, "public key", 100), agentName(participant.name)).id === participant.id;
  } catch { return false; }
}
export function parsePassword(value: string): { fingerprint: string; secret: string } {
  const match = /^sb1\.([A-Za-z0-9_-]{43})\.([A-Za-z0-9_-]{43})$/.exec(value.trim());
  if (!match) throw new Error("Invalid server password. Copy the entire sb1.… string printed by the server.");
  return { fingerprint: match[1]!, secret: match[2]! };
}
export function serverUrl(value: string): string {
  const url = new URL(value.includes("://") ? value : `wss://${value}`);
  if (url.protocol !== "wss:" || !url.hostname || url.username || url.password || url.search || url.hash || !["/", "/ws"].includes(url.pathname)) {
    throw new Error("Use an IP:port or wss://host:port address, without credentials or query parameters.");
  }
  url.pathname = "/ws";
  return url.href;
}
