# match — Matches

Per-match simulation instances. One `Match` = one authoritative game in one
Socket.IO room. Owns:

- Match lifecycle (lobby → active → ended) and phase transitions
- The match's authoritative state and its config snapshot (see
  [DATA_MODELS.md](../../../DATA_MODELS.md) → Match / MatchConfig)
- Driving the engine's tick loop for this match and broadcasting sync

A match holds Players (`player/`) and drives systems in `engine/`.
