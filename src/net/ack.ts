/**
 * Uniform Socket.IO acknowledgement envelope shared by all event handlers
 * (see SOCKET_EVENTS.md §Conventions).
 */
export interface AckResponse {
  ok: boolean;
  data?: unknown;
  error?: { code: string; message: string };
}

export const ok = (data?: unknown): AckResponse => ({ ok: true, data });

export const fail = (code: string, message: string): AckResponse => ({
  ok: false,
  error: { code, message },
});

/** Invokes the client's ack callback if one was provided. */
export function respond(ack: unknown, response: AckResponse): void {
  if (typeof ack === "function") (ack as (r: AckResponse) => void)(response);
}
