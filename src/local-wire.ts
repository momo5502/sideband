import type { Socket } from "node:net";
import { StringDecoder } from "node:string_decoder";

/** Private local IPC. It carries structured session events, never terminal bytes. */
export function writeLocal(socket: Socket | undefined, packet: object): boolean {
  if (!socket || socket.destroyed || !socket.writable) return false;
  const line = JSON.stringify({ v: 1, ...packet }) + "\n";
  if (Buffer.byteLength(line) > 1024 * 1024 || socket.writableLength > 1024 * 1024) { socket.destroy(); return false; }
  socket.write(line); return true;
}
export function readLocal(socket: Socket, receive: (packet: any) => void): void {
  const decoder = new StringDecoder("utf8"); let buffer = "";
  socket.on("error", () => {});
  socket.on("data", chunk => {
    buffer += decoder.write(chunk);
    while (buffer.includes("\n")) {
      const end = buffer.indexOf("\n"), line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      if (Buffer.byteLength(line) > 1024 * 1024) { socket.destroy(); return; }
      try { const packet = JSON.parse(line); if (packet?.v !== 1 || typeof packet.type !== "string") throw new Error(); receive(packet); }
      catch { socket.destroy(); return; }
    }
    if (Buffer.byteLength(buffer) > 1024 * 1024) socket.destroy();
  });
}
