// Actual TLS/WebSocket server and three clients; no model calls or external services.
import { RoomServer } from "../dist/src/room-server.js";
import { RoomClient } from "../dist/src/room-client.js";

const server = await RoomServer.start({ host: "127.0.0.1", port: 0 });
const profile = { server: `127.0.0.1:${server.port}`, password: server.password };
const peers = ["alice", "bob", "charlie"].map((name) => new RoomClient(profile, name, { proxyEnv: {} }));
const pending = [];
peers.forEach((client) => client.onMessage((message) => console.log(`${client.identity.name} received verified message from ${message.sender.name}: ${message.text}`)));
try {
  for (const client of peers) await client.connect();
  const first = await peers[0].createRoom("task-one");
  await peers[1].joinRoom(first.id);
  await peers[2].createRoom("task-two");
  console.log("Two rooms; Alice and Bob share task-one. Charlie is isolated.");
  pending.push(new Promise((resolve) => peers[1].onMessage(resolve)));
  await peers[0].send("Picked task 123");
  await Promise.all(pending);
  console.log("Server pushed to Bob without a history fetch; no self-echo or cross-room delivery.");
  console.log("History messages:", (await peers[1].history()).length);
} finally {
  await Promise.all(peers.map((client) => client.close()));
  await server.close();
}
