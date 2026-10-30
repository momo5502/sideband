import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { stripVTControlCharacters } from "node:util";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { RoomClient } from "../src/room-client.js";
import { RoomServer } from "../src/room-server.js";
import { RoomProfiles } from "../src/room-profiles.js";
import { ReadlineTerminal, chatMessage, runChatSession, terminalText, terminalColors, type ChatTerminal } from "../src/terminal-chat.js";

class Terminal extends PassThrough {
  isTTY = true; isRaw = false; columns = 80;
  setRawMode(mode: boolean): this { this.isRaw = mode; return this; }
}

test("terminal redraw preserves a draft when messages arrive; Ctrl+C and EOF release raw mode", async () => {
  const input = new Terminal(); const output = new Terminal(); let printed = "";
  output.on("data", chunk => { printed += chunk; });
  const ui = new ReadlineTerminal(input, output);
  try {
    const answer = ui.question("room> ");
    input.write("unfinished draft");
    ui.write(chatMessage({ sender: { id: "alice", name: "alice", publicKey: "" }, text: "live message\x1b]52;c;clipboard\x07", createdAt: 0 }));
    input.write("\r");
    assert.equal(await answer, "unfinished draft");
    assert.ok(printed.includes("alice: live message\\u001b]52;c;clipboard\\u0007\n\n"), "messages end with an empty line before restoring the draft");
    assert.ok(!printed.includes("\x1b]52;"));
    const cancelled = ui.question("room> "); input.write("\x03");
    assert.equal(await cancelled, undefined); assert.equal(input.isRaw, false);
    assert.equal(await ui.question("closed> "), undefined);
  } finally { ui.close(); input.destroy(); output.destroy(); }
  const eofInput = new Terminal(); const eofOutput = new Terminal(); const eof = new ReadlineTerminal(eofInput, eofOutput);
  try {
    const answer = eof.question("room> "); eofInput.write("\x04");
    assert.equal(await answer, undefined); assert.equal(eofInput.isRaw, false);
  } finally { eof.close(); eofInput.destroy(); eofOutput.destroy(); }
});

test("terminal text cannot inject control codes, bidi overrides or unprefixed multiline senders", () => {
  assert.equal(terminalText("safe\ntext\r\b\x1b[2J\u202e"), "safe\ntext\\u000d\\u0008\\u001b[2J\\u202e");
  assert.match(chatMessage({ sender: { id: "agent-abcdefghijklmnop", publicKey: "" }, text: "hi\nforged: no", createdAt: 0 }), /#abcdefghijkl: hi\n  \| forged: no\n$/);
});

test("timestamps and identities have separate colors, while peer text stays plain and escaped", () => {
  const message = { sender: { id: "agent-abcdefghijklmnop", name: "alice", publicKey: "" }, text: "hi\x1b[31m\u202e\nnext", createdAt: 0 };
  const plain = chatMessage(message); const colored = chatMessage(message, true);
  assert.match(colored, /^\x1b\[90m[^\x1b]+\x1b\[0m \x1b\[1;\d+malice\x1b\[0m: /);
  assert.ok(plain.startsWith(`${new Date(message.createdAt).toLocaleTimeString()} alice: `), "timestamps have no surrounding brackets");
  assert.equal(stripVTControlCharacters(colored), plain);
  assert.ok(!colored.includes("\x1b[31m")); assert.ok(colored.includes("hi\\u001b[31m\\u202e\n  | next\n"));
  const nameStyle = (value: string) => /\x1b\[1;\d+m/.exec(value)?.[0];
  assert.equal(nameStyle(colored), nameStyle(chatMessage({ ...message, text: "different text", createdAt: 1 }, true)));
  assert.ok(!plain.includes("\x1b"));
});

test("color detection respects non-color terminals and NO_COLOR", () => {
  assert.equal(terminalColors({ isTTY: true, getColorDepth: () => 8 }, {}), true);
  assert.equal(terminalColors({ isTTY: false, getColorDepth: () => 8 }, {}), false);
  assert.equal(terminalColors({ isTTY: true, getColorDepth: () => 1 }, {}), false);
  assert.equal(terminalColors({ isTTY: true }, { TERM: "dumb" }), false);
  assert.equal(terminalColors({ isTTY: true }, { NO_COLOR: "1" }), false);
});

test("colored terminal redraw preserves the draft and never permits peer escape sequences", async () => {
  const input = new Terminal(); const output = new Terminal(); let printed = "";
  output.on("data", chunk => { printed += chunk; });
  const ui = new ReadlineTerminal(input, output);
  try {
    const answer = ui.question("room> "); input.write("unfinished draft");
    ui.message({ sender: { id: "peer", name: "alice", publicKey: "" }, text: "hello\x1b]52;c;secret\x07", createdAt: 0 });
    input.write("\r"); assert.equal(await answer, "unfinished draft");
    assert.ok(stripVTControlCharacters(printed).includes("alice: hello\\u001b]52;c;secret\\u0007\n\n"));
    assert.ok(!printed.includes("\x1b]52;"));
  } finally { ui.close(); input.destroy(); output.destroy(); }
});

test("human terminal browses rooms, sees history/live pushes, sends signed messages and leaves cleanly", async () => {
  const server = await RoomServer.start({ host: "127.0.0.1", port: 0 });
  const profile = { server: `127.0.0.1:${server.port}`, password: server.password };
  const human = new RoomClient(profile, "human"); const agent = new RoomClient(profile, "agent");
  const printed: string[] = []; const prompts: string[] = []; const received: string[] = []; let step = 0;
  try {
    await agent.connect(); const room = await agent.joinRoom("project");
    await agent.send("retained context"); await human.connect();
    const sent = new Promise<void>(resolve => agent.onMessage(message => { received.push(message.text); resolve(); }));
    const ui: ChatTerminal = {
      write: text => { printed.push(text); },
      question: async prompt => {
        prompts.push(prompt);
        switch (step++) {
          case 0: return "1";
          case 1: {
            const pushed = new Promise<void>(resolve => human.onMessage(() => resolve()));
            await agent.send("live while typing"); await pushed;
            return "human reply";
          }
          case 2: await sent; return "/members";
          case 3: return "/join 00000000-0000-0000-0000-000000000000";
          case 4: assert.equal(human.room?.id, room.id); return "/history 0";
          case 5: return "//literal slash";
          case 6: return "/leave";
          case 7: return "/join human-room";
          default: return "/quit";
        }
      },
    };
    await runChatSession(human, ui);
    const text = printed.join("\n");
    assert.match(text, /1\. project \(1 participant\)/);
    assert.equal(printed.filter(line => line.includes("retained context")).length, 1);
    assert.equal(printed.filter(line => line.includes("live while typing")).length, 1);
    for (const contents of ["retained context", "live while typing", "human reply"]) {
      assert.ok(printed.find(line => line.includes(contents))?.endsWith("\n"), "history, incoming and outgoing messages all have spacing");
    }
    assert.deepEqual(received.slice(0, 1), ["human reply"]);
    assert.match(text, /Participants \(2\)/); assert.match(text, /does not exist/); assert.match(text, /Use \/history \[1-50\]/);
    assert.match(text, /human: \/literal slash/); assert.match(text, /Joined human-room/);
    assert.ok(prompts.some(prompt => prompt === "project> "));
    await human.close(); assert.deepEqual((await agent.listRooms()).map(item => item.name), ["project"]);
  } finally { await human.close(); await agent.close(); await server.close(); }
});

test("terminal join history and live overlap is shown once, without replaying history to peers", async () => {
  const server = await RoomServer.start({ host: "127.0.0.1", port: 0 });
  const profile = { server: `127.0.0.1:${server.port}`, password: server.password };
  const human = new RoomClient(profile); const agent = new RoomClient(profile);
  try {
    await agent.connect(); await agent.joinRoom("race"); await human.connect();
    const original = human.history.bind(human);
    human.history = async limit => {
      const received = new Promise<void>(resolve => human.onMessage(() => resolve()));
      await agent.send("during history load"); await received;
      return original(limit);
    };
    let step = 0; const printed: string[] = []; const peerMessages: string[] = [];
    agent.onMessage(message => peerMessages.push(message.text));
    await runChatSession(human, { write: text => { printed.push(text); }, question: async () => step++ ? undefined : "1" });
    assert.equal(printed.filter(line => line.includes("during history load")).length, 1);
    assert.deepEqual(peerMessages, []);
  } finally { await human.close(); await agent.close(); await server.close(); }
});

test("packaged CLI with no arguments selects a saved login, joins, receives, sends and quits", { timeout: 15_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "sideband-chat-cli-"));
  const server = await RoomServer.start({ host: "127.0.0.1", port: 0 });
  const profile = { server: `127.0.0.1:${server.port}`, password: server.password };
  const agent = new RoomClient(profile, "agent");
  let child: ReturnType<typeof spawn> | undefined;
  try {
    const entry = join(directory, "sideband.cjs"); await copyFile(resolve("dist/sideband.cjs"), entry);
    await new RoomProfiles(directory).save("vps", profile);
    await agent.connect(); await agent.joinRoom("cli-room"); await agent.send("prior context");
    // A simulated TTY over pipes exercises the actual bundled CLI/readline without a platform PTY dependency.
    const shim = "process.stdin.isTTY = true; process.stdout.isTTY = true; process.stdout.getColorDepth = () => 4; delete process.env.NO_COLOR; process.env.TERM = 'xterm'; process.stdin.setRawMode = function(mode) { this.isRaw = mode; return this; };";
    child = spawn(process.execPath, ["--import", `data:text/javascript,${encodeURIComponent(shim)}`, entry], {
      cwd: directory, env: { ...process.env, SIDEBAND_STATE_DIR: directory, NODE_PATH: "" }, stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
    });
    const exited = once(child, "exit");
    let output = ""; let errors = "";
    child.stdout!.on("data", chunk => { output += chunk; }); child.stderr!.on("data", chunk => { errors += chunk; });
    const untilOutput = async (text: string) => {
      const deadline = Date.now() + 5000;
      while (!stripVTControlCharacters(output).includes(text)) {
        if (Date.now() > deadline || child!.exitCode !== null) throw new Error(`Missing CLI output: ${text}; stderr: ${errors}`);
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    };
    await untilOutput("Your name"); child.stdin!.write("human-console\n");
    await untilOutput("1. cli-room"); await untilOutput("Join room (number/name)"); child.stdin!.write("1\n");
    await untilOutput("--- Live ---"); assert.ok(output.includes("prior context"));
    await agent.send("pushed while waiting"); await untilOutput("pushed while waiting");
    const received = new Promise<void>(resolve => agent.onMessage(message => { if (message.text === "from the terminal") resolve(); }));
    child.stdin!.write("from the terminal\n"); await received; await untilOutput("human-console: from the terminal");
    child.stdin!.write("/quit\n");
    const [code] = await exited; assert.equal(code, 0, errors);
    assert.ok(output.includes("\x1b[90m")); assert.match(output, /\x1b\[1;\d+m/);
    assert.equal((await agent.members()).length, 1);
    assert.ok(!output.includes(profile.password)); assert.equal(errors, "");
  } finally {
    if (child && child.exitCode === null) { child.kill(); await once(child, "exit"); }
    await agent.close(); await server.close(); await rm(directory, { recursive: true, force: true });
  }
});
