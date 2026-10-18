import { RoomClient } from "./room-client.js";
export class RoomSession {
    adapter;
    client;
    active = false;
    generation = 0;
    delivered = Promise.resolve();
    queued = 0;
    unsubscribe;
    lastDeliveryError;
    constructor(profile, adapter, name) {
        this.adapter = adapter;
        this.client = new RoomClient(profile, name);
    }
    async enable() {
        try {
            await this.adapter.prepare();
            await this.client.connect();
            this.active = true;
            const generation = ++this.generation;
            this.unsubscribe = this.client.onMessage((message) => this.receive(message, generation));
        }
        catch (error) {
            await this.disable();
            throw error;
        }
    }
    receive(message, generation) {
        if (this.queued >= 100) {
            this.lastDeliveryError = "Delivery backlog is full; use history for missed messages.";
            return;
        }
        this.queued++;
        this.delivered = this.delivered.then(async () => {
            if (!this.active || generation !== this.generation || message.roomId !== this.client.room?.id)
                return;
            await this.adapter.deliver({ messageId: message.id, channelId: message.roomId,
                sender: { id: message.sender.id, ...(message.sender.name ? { name: message.sender.name } : {}) },
                senderAccountId: message.sender.id, text: message.text, attachments: [], createdAt: message.createdAt, verified: true });
        }).catch((error) => { this.lastDeliveryError = error instanceof Error ? error.message : "Harness delivery failed."; })
            .finally(() => { this.queued--; });
    }
    status() {
        return { state: this.client.state, identity: this.client.identity, room: this.client.room,
            ...(this.client.lastError ? { connectionError: this.client.lastError } : {}),
            ...(this.lastDeliveryError ? { deliveryError: this.lastDeliveryError } : {}) };
    }
    async drain() { await this.delivered; }
    async disable() {
        this.active = false;
        ++this.generation;
        this.unsubscribe?.();
        await Promise.allSettled([this.client.close(), this.adapter.close()]);
    }
}
//# sourceMappingURL=room-session.js.map