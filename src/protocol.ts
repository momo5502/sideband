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
};
export function formatDelivery(delivery: Delivery): string {
  return JSON.stringify({ source: "sideband", ...delivery });
}
