# net — Networking

Socket.IO transport and connection lifecycle. Owns:

- Connection handling (`connection.ts`)
- Room/lobby management (future)
- Inbound intent routing to matches (future)

Translates socket messages ↔ engine actions per the contract in
[SOCKET_EVENTS.md](../../../SOCKET_EVENTS.md). Contains no gameplay logic — it
validates/forwards and emits `state:*` / `evt:*` produced by the engine.
