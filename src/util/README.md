# util — Utilities

Cross-cutting, dependency-light helpers with no gameplay knowledge. Owns:

- `logger.ts` — centralized leveled logging
- Future generic helpers (ids, seeded RNG, timing, validation)

Utilities must not import from gameplay domains (`engine/`, `match/`, etc.) to
stay reusable and avoid dependency cycles.
