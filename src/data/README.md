# data — Data-Driven Content

Static, declarative game content and tunables — **no logic**. Owns:

- `balance.ts` — global gameplay tunables (starting HP, citizens, crit, room code)
- Kingdom definitions and ability definitions (future; one file per kingdom)

Systems in `engine/` and `abilities/` read this data; a new kingdom or rebalance
touches `data/` only (see [ARCHITECTURE.md](../../../ARCHITECTURE.md)).
