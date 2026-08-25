# net — Networking

Socket.IO transport, connection lifecycle, and everything between a socket and a
match. Owns:

- Connection handling (`connection.ts`) and session/reconnection bookkeeping
  (`sessionHandlers.ts`, `ReconnectionManager.ts` — a disconnected player keeps
  their seat, kingdom, and position for `RECONNECT.GRACE_MS`)
- Lobby and room management (`lobbyRoom.ts`, `lobbyHandlers.ts`, `roomCode.ts`)
- Public matchmaking (`publicLobby.ts`, `PublicLobbyManager.ts`)
- Inbound intent routing to matches (`matchHandlers.ts`) and outbound state
  synchronization (`gameSync.ts`, `ack.ts`)
- Health checks (`health.ts`)

Translates socket messages ↔ engine actions per the contract in
[SOCKET_EVENTS.md](../../../SOCKET_EVENTS.md). Contains no gameplay logic — it
validates and forwards, and emits the `state:*` / `evt:*` the engine produced.
