import { createInterface } from "node:readline/promises";
import { clearScreenDown, cursorTo, moveCursor } from "node:readline";
import { RoomClient } from "./room-client.js";
import { RoomProfiles } from "./room-profiles.js";
import { agentName } from "./room-protocol.js";
import { identityLabel } from "./protocol.js";
/** Peers can send arbitrary text: never interpret their terminal control sequences or bidi overrides. */
export function terminalText(value) {
    return value.replace(/\r\n/g, "\n").replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/g, character => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
}
export function chatMessage(message) {
    const time = new Date(message.createdAt).toLocaleTimeString();
    return `[${time}] ${terminalText(identityLabel(message.sender))}: ${terminalText(message.text).replace(/\n/g, "\n  | ")}`;
}
export class ReadlineTerminal {
    output;
    reader;
    cancelled = new AbortController();
    asking = false;
    constructor(input = process.stdin, output = process.stdout) {
        this.output = output;
        this.reader = createInterface({ input, output, terminal: true, historySize: 0 });
        this.reader.once("close", () => this.cancelled.abort());
        this.reader.on("SIGINT", () => this.close());
    }
    async question(prompt) {
        if (this.cancelled.signal.aborted)
            return undefined;
        this.asking = true;
        try {
            return await this.reader.question(terminalText(prompt), { signal: this.cancelled.signal });
        }
        catch (error) {
            if (this.cancelled.signal.aborted)
                return undefined;
            throw error;
        }
        finally {
            this.asking = false;
        }
    }
    write(text) {
        if (this.cancelled.signal.aborted)
            return;
        if (this.asking) {
            const { rows } = this.reader.getCursorPos();
            moveCursor(this.output, 0, -rows);
            cursorTo(this.output, 0);
            clearScreenDown(this.output);
        }
        this.output.write(`${terminalText(text)}\n`);
        if (this.asking)
            this.reader.prompt(true); // Preserve the draft and cursor while a push arrives.
    }
    close() { this.reader.close(); }
}
const help = "Type a message to send it to the current room.\n/rooms  /join NUMBER|NAME|ID  /create NAME  /leave  /members  /history [1-50]  /quit\nUse //text to send a message beginning with /. Ctrl+C or Ctrl+D exits.";
/** Uses the same signed client as agents; only terminal input explicitly sends speech. */
export async function runChatSession(client, ui) {
    let rooms = [];
    let buffering = false;
    let buffered = [];
    let overflow = false;
    const shown = new Set();
    const remember = (id) => {
        shown.add(id);
        if (shown.size > 1000)
            shown.delete(shown.values().next().value);
    };
    const display = (event, force = false) => {
        if (event.roomId !== client.room?.id)
            return;
        const key = `${event.roomId}:${event.id}`;
        if (!force && shown.has(key))
            return;
        remember(key);
        if ("kind" in event)
            ui.write(`* ${identityLabel(event.participant)} ${event.kind}.`);
        else
            ui.write(chatMessage(event));
    };
    const receive = (event) => {
        if (!buffering) {
            display(event);
            return;
        }
        if (buffered.length < 1000)
            buffered.push(event);
        else
            overflow = true;
    };
    const unsubscribe = client.onMessage(receive);
    const unsubscribePresence = client.onPresence(receive);
    const bufferedOperation = async (operation) => {
        buffering = true;
        try {
            await operation();
        }
        finally {
            buffering = false;
            for (const event of buffered)
                display(event);
            buffered = [];
            if (overflow) {
                ui.write("Some live events were omitted while loading; use /history to check retained messages.");
                overflow = false;
            }
        }
    };
    const listRooms = async () => {
        rooms = await client.listRooms();
        ui.write(rooms.length ? "Chatrooms:" : "No occupied chatrooms. Use /create NAME to start one.");
        rooms.forEach((room, index) => ui.write(`  ${index + 1}. ${room.name} (${room.members} participant${room.members === 1 ? "" : "s"})`));
    };
    const history = async (limit = 50, force = false) => {
        const messages = await client.history(limit);
        ui.write(messages.length ? `--- Recent messages (${messages.length}) ---` : "--- No messages yet ---");
        for (const message of messages)
            display(message, force);
        ui.write("--- Live ---");
    };
    const join = async (target, create = false) => {
        if (!target)
            throw new Error(create ? "Use /create NAME." : "Use /join NUMBER, NAME or ID.");
        if (!create && /^\d+$/.test(target)) {
            const choice = rooms[Number(target) - 1];
            if (!choice)
                throw new Error("No room at that number. Use /rooms to refresh the list.");
            target = choice.id;
        }
        await bufferedOperation(async () => {
            const room = create ? await client.createRoom(target) : await client.joinRoom(target);
            ui.write(`Joined ${room.name}. /help shows commands.`);
            await history();
        });
    };
    try {
        ui.write(`Connected as ${identityLabel(client.identity)}. /help shows commands.`);
        await listRooms();
        for (;;) {
            const line = await ui.question(client.room ? `${terminalText(client.room.name)}> ` : "Join room (number/name), /create NAME, or /quit> ");
            if (line === undefined)
                break;
            if (!line.trim())
                continue;
            try {
                if (line.startsWith("/") && !line.startsWith("//")) {
                    const match = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(line.trim());
                    const command = match?.[1]?.toLowerCase();
                    const arg = match?.[2]?.trim() ?? "";
                    if (["quit", "exit", "q"].includes(command ?? "") && !arg)
                        break;
                    switch (command) {
                        case "help":
                            ui.write(help);
                            break;
                        case "rooms":
                            await listRooms();
                            break;
                        case "join":
                            await join(arg);
                            break;
                        case "create":
                            await join(arg, true);
                            break;
                        case "leave":
                            await client.leaveRoom();
                            ui.write("Left the room.");
                            await listRooms();
                            break;
                        case "members": {
                            const members = await client.members();
                            ui.write(`Participants (${members.length}):`);
                            for (const member of members)
                                ui.write(`  ${identityLabel(member)}${member.id === client.identity.id ? " (you)" : ""}`);
                            break;
                        }
                        case "history": {
                            const limit = arg ? Number(arg) : 50;
                            if (!Number.isInteger(limit) || limit < 1 || limit > 50)
                                throw new Error("Use /history [1-50].");
                            await bufferedOperation(() => history(limit, true));
                            break;
                        }
                        default: throw new Error("Unknown command. Use /help; use //text to send a leading slash.");
                    }
                }
                else if (!client.room)
                    await join(line.trim());
                else {
                    const text = line.startsWith("//") ? line.slice(1) : line;
                    const roomId = client.room.id;
                    const sent = await client.send(text);
                    remember(`${roomId}:${sent.messageId}`);
                    ui.write(chatMessage({ sender: client.identity, text, createdAt: Date.now() }));
                }
            }
            catch (error) {
                ui.write(`Error: ${error instanceof Error ? error.message : "Command failed."}`);
            }
        }
    }
    finally {
        unsubscribe();
        unsubscribePresence();
    }
}
export async function terminalChat(options = {}) {
    if (!process.stdin.isTTY || !process.stdout.isTTY)
        throw new Error("Chat requires an interactive terminal. Use sideband --help for other commands.");
    const profiles = new RoomProfiles();
    const names = await profiles.names();
    if (!options.profile && !names.length)
        throw new Error("No saved connection. Run sideband login IP:port first, then sideband.");
    const ui = new ReadlineTerminal();
    let client;
    const terminate = () => ui.close();
    process.once("SIGTERM", terminate);
    try {
        let profileName = options.profile ?? (names.length === 1 ? names[0] : undefined);
        while (!profileName) {
            ui.write("Saved connections:");
            names.forEach((name, index) => ui.write(`  ${index + 1}. ${name}`));
            const answer = await ui.question("Connection (number/name): ");
            if (answer === undefined)
                return;
            const value = answer.trim();
            profileName = /^\d+$/.test(value) ? names[Number(value) - 1] : names.find(name => name === value);
            if (!profileName)
                ui.write("Choose a saved connection from the list.");
        }
        const profile = await profiles.load(profileName);
        let name = options.name;
        if (name === undefined) {
            for (;;) {
                const answer = await ui.question("Your name (Enter for a generated ID): ");
                if (answer === undefined)
                    return;
                try {
                    name = agentName(answer.trim()) ?? "";
                    break;
                }
                catch (error) {
                    ui.write(error.message);
                }
            }
        }
        ui.write(`Connecting to ${profile.server}...`);
        client = new RoomClient(profile, name, { onError: error => ui.write(`Connection: ${error.message}`) });
        await client.connect();
        await runChatSession(client, ui);
    }
    finally {
        ui.close();
        process.off("SIGTERM", terminate);
        await client?.close();
        process.stdout.write("\nDisconnected.\n");
    }
}
//# sourceMappingURL=terminal-chat.js.map