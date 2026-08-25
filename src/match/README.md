# match — Matches

Per-match simulation instances. One `Match` = one authoritative game in one
Socket.IO room. Owns:

- Match lifecycle (lobby → starting → active → ended) and phase transitions
  (`Match.ts`, `MatchManager.ts`)
- The match's authoritative state (`GameState.ts`), per-player state
  (`playerState.ts`), and the config snapshot taken at start (`matchConfig.ts`)
  so live balance edits never disturb a running game
- The snapshot/delta shapes sent to clients (`snapshot.ts`)
- Driving the engine's tick loop for this match and broadcasting sync

Seats: up to `MATCH.MAX_PLAYERS` (8) total, of which at most
`MATCH.MAX_ACTIVE_PLAYERS` (7) play a kingdom; the rest are spectators. Minimum
2 to start.

A match owns its players' state and drives the systems in `engine/`.
