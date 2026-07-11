# player — Players

Player state and per-player logic. Owns:

- The Player model: castle (HP + shields), economy (citizens/currency/income),
  ability instances, statuses, combos, upgrades (see
  [DATA_MODELS.md](../../../DATA_MODELS.md) → Player)
- Connection association and reconnection bookkeeping (a Player persists across
  socket reconnects within a match)

Players belong to a `Match` and are acted upon by the `engine/`.
