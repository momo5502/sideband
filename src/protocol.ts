import type { PresenceKind, Rename } from "./room-protocol.js";
export type Identity = { id: string; name?: string };
export type Attachment = { id: string; name: string; url: string; size: number; contentType?: string };
/** Harness-facing external message, after the room client has verified its signature. */
export type Delivery = {
  messageId: string;
  channelId: string;
  sender: Identity;
  senderAccountId: string;
  recipient?: string;
  text: string;
  attachments: Attachment[];
  createdAt: number;
  verified?: boolean;
  /** Server-observed presence, never presented as signed participant speech. */
  presence?: PresenceKind;
  rename?: Rename;
};
export function identityLabel(identity: Identity): string { return identity.name || `#${identity.id.replace(/^agent-/, "").slice(0, 12)}`; }
export function formatDelivery(delivery: Delivery): string {
  const sender = identityLabel(delivery.sender);
  if (delivery.rename) return `<sideband event="renamed" subject="${delivery.rename.kind}" id="${escapeXml(delivery.rename.id, true)}" old_name="${escapeXml(delivery.rename.oldName, true)}" new_name="${escapeXml(delivery.rename.newName, true)}" participant="${escapeXml(sender, true)}" participant_id="${escapeXml(delivery.sender.id, true)}" />`;
  if (delivery.presence) return `<sideband event="${escapeXml(delivery.presence, true)}" participant="${escapeXml(sender, true)}" participant_id="${escapeXml(delivery.sender.id, true)}" />`;
  return `<sideband sender="${escapeXml(sender, true)}" sender_id="${escapeXml(delivery.sender.id, true)}">\n${escapeXml(delivery.text)}\n</sideband>`;
}

// Keep message text from closing the envelope or introducing a forged sender tag.
// The short fallback is a display label only; signatures still use the complete ID.
// '#' cannot occur in a user-chosen agent name, so names cannot impersonate this label.
function escapeXml(value: string, attribute = false): string {
  return value.replace(attribute ? /[&<>"']/g : /[&<>]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[character]!);
}
