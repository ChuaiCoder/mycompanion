import type { Socket } from "node:net";
import type { FastifyInstance } from "fastify";

/** Node's HTTP drain can wait forever on browser preconnections with no request. */
export function drainHttpConnectionsOnShutdown(app: FastifyInstance): void {
  const connections = new Map<Socket, number>();
  let closing = false;
  app.server.on("connection", socket => {
    if (closing) { socket.destroy(); return; }
    connections.set(socket, 0);
    socket.once("close", () => connections.delete(socket));
  });
  // Count pipelined responses too. Existing generation/save shutdown hooks own
  // accepted work; finish flushes its response before we send the socket's FIN.
  app.server.on("request", (request, response) => {
    const socket = request.socket;
    connections.set(socket, (connections.get(socket) ?? 0) + 1);
    let completed = false;
    const finish = () => {
      if (completed) return;
      completed = true;
      const remaining = (connections.get(socket) ?? 1) - 1;
      if (!connections.has(socket)) return;
      connections.set(socket, remaining);
      if (closing && remaining === 0) socket.end();
    };
    response.once("finish", finish);
    response.once("close", finish);
  });
  app.addHook("preClose", async () => {
    closing = true;
    for (const [socket, active] of connections) if (active === 0) socket.destroy();
  });
}
