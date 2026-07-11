# engine — Game Engine

The generic, data-driven gameplay engine. Contains **no kingdom-specific
logic** (see [ARCHITECTURE.md](../../../ARCHITECTURE.md)). Owns:

- The tick loop and scheduler (see [GAME_TICK.md](../../../GAME_TICK.md))
- The combat pipeline / resolver (ordering per ARCHITECTURE.md §7)
- The effect engine and its primitives (damage, heal, buff, debuff, status,
  combo, CC, economy/shield modifiers, target restriction)
- Status & combo processing, economy accrual, win-condition checks
- The event bus that produces `evt:*` gameplay events

Abilities are configured elsewhere (`abilities/`, `data/`); this executes them.
