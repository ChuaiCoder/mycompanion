import type { FastifyReply } from "fastify";
import type { ApiErrorResponse } from "@mycompanion/shared";

// Shared error responder: byte-identical to the historical inline
// `reply.status(status).send({ error: { code, message } })` pattern.
export function sendError(
  reply: FastifyReply,
  status: number,
  code: string,
  message: string,
): FastifyReply {
  return reply.status(status).send({
    error: { code, message },
  } satisfies ApiErrorResponse);
}
