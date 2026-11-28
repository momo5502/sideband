import { randomUUID } from "node:crypto";
import { RoomError, text } from "./room-protocol.js";
export function roomName(value) {
    const name = text(value, "room name", 100).trim();
    if (!name || /[\x00-\x1f\x7f]/.test(name))
        throw new RoomError("INVALID_ARGUMENT", "Invalid room name.");
    return name;
}
/** Only room identity/name metadata is durable. Membership, messages and events stay ephemeral. */
export class RoomCatalog {
    store;
    entries = new Map();
    operations = Promise.resolve();
    constructor(store) {
        this.store = store;
        for (const [id, value] of store?.all("room") ?? [])
            this.entries.set(id, { id, name: roomName(value.name), aliases: value.aliases ?? [] });
    }
    resolve(target) {
        if (!target)
            return;
        return this.entries.get(target) ?? [...this.entries.values()].find(value => value.name.toLowerCase() === target.toLowerCase());
    }
    legacy(target) { return [...this.entries.values()].find(value => value.aliases.some(name => name.toLowerCase() === target.toLowerCase())) ?? this.resolve(target); }
    serial(task) {
        const result = this.operations.then(task);
        this.operations = result.then(() => { }, () => { });
        return result;
    }
    ensure(target) {
        return this.serial(async () => {
            const existing = this.resolve(target);
            if (existing)
                return existing;
            if (/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(target))
                throw new RoomError("ROOM_NOT_FOUND", "Room ID does not exist. Join by name to create a room.");
            const entry = { id: randomUUID(), name: roomName(target), aliases: [] };
            await this.store?.change(() => this.store.put("room", entry.id, entry));
            this.entries.set(entry.id, entry);
            return entry;
        });
    }
    rename(id, input) {
        return this.serial(async () => {
            const current = this.entries.get(id);
            if (!current)
                throw new RoomError("ROOM_NOT_FOUND", "Room does not exist.");
            const name = roomName(input), taken = this.resolve(name);
            if (taken && taken.id !== id)
                throw new RoomError("ROOM_EXISTS", "Room name is already in use.");
            const entry = { id, name, aliases: [...new Set([...current.aliases, current.name])].slice(-100) };
            await this.store?.change(() => this.store.put("room", id, entry));
            this.entries.set(id, entry);
            return entry;
        });
    }
}
//# sourceMappingURL=room-catalog.js.map