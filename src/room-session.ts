import { RoomClient } from "./room-client.js";
import type { ConnectionProfile, SignedMessage } from "./room-protocol.js";
import type { DeliveryAdapter } from "./adapters/codex.js";

export class RoomSession {
  readonly client: RoomClient;
  private active = false;
  private generation = 0;
  private delivered = Promise.resolve();
  private queued = 0;
  private unsubscribe?: () => void;
  private lastDeliveryError?: string;
  constructor(profile: ConnectionProfile, readonly adapter: DeliveryAdapter, name?: string) { this.client = new RoomClient(profile, name); }
  async enable(): Promise<void> {
    try {
      await this.adapter.prepare();
      await this.client.connect(); this.active = true;
      const generation = ++this.generation;
      this.unsubscribe = this.client.onMessage((message) => this.receive(message, generation));
    } catch (error) { await this.disable(); throw error; }
  }
  private receive(message: SignedMessage, generation: number): void {
    if (this.queued >= 100) { this.lastDeliveryError = "Delivery backlog is full; use history for missed messages."; return; }
    this.queued++;
    this.delivered = this.delivered.then(async () => {
      if (!this.active || generation !== this.generation || message.roomId !== this.client.room?.id) return;
      await this.adapter.deliver({ messageId: message.id, channelId: message.roomId,
        sender: { id: message.sender.id, ...(message.sender.name ? { name: message.sender.name } : {}) },
        senderAccountId: message.sender.id, text: message.text, attachments: [], createdAt: message.createdAt, verified: true });
    }).catch((error) => { this.lastDeliveryError = error instanceof Error ? error.message : "Harness delivery failed."; })
      .finally(() => { this.queued--; });
  }
  status(): object {
    return { state: this.client.state, identity: this.client.identity, room: this.client.room,
      ...(this.client.lastError ? { connectionError: this.client.lastError } : {}),
      ...(this.lastDeliveryError ? { deliveryError: this.lastDeliveryError } : {}) };
  }
  async drain(): Promise<void> { await this.delivered; }
  async disable(): Promise<void> {
    this.active = false; ++this.generation; this.unsubscribe?.();
    await Promise.allSettled([this.client.close(), this.adapter.close()]);
  }
}
