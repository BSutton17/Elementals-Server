# data — Data-Driven Content

Static, declarative game content and tunables — **no logic**. Owns:

- `balance.ts` — global tunables (starting HP, citizens, crit, tick rate,
  besieged curves, targeting, reconnection) plus a per-kingdom constants block
  for each kingdom with a bespoke subsystem (`FIRE`, `MAGMA`, `INSECTS`,
  `KITSUNE`, `SPACE`, `DARK`)
- `kingdoms.ts` — the canonical `KINGDOM_IDS` roster and every kingdom's
  always-on passives, composed from generic passive primitives
- `<kingdom>Abilities.ts` — one file per kingdom holding its 5 activated cards
  and the status definitions they apply
- `abilitiesRegistry.ts` — the ability-id → definition map the engine reads
- `perks.ts` — the lobby perk catalogue

Systems in `engine/` read this data; a rebalance or an ordinary new kit touches
`data/` only (see [ARCHITECTURE.md](../../../ARCHITECTURE.md) §1 and §4).

## Two rules that are easy to break

**Prices live here and nowhere else.** An ability's `cost`, `unlockCost`,
`cooldownTicks`, and upgrade-tier costs are defined in its
`<kingdom>Abilities.ts` and reach the client through the `abilityPrices` sync.
A price hardcoded in the client is a bug even when the number happens to match.

**Every tunable is read through `param(id, base)`**, never imported and used
directly, so the simulation can run candidate balance sets without touching
production data. See `engine/parameters.ts`.
