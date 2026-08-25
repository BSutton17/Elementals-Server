# engine — Game Engine

The data-driven gameplay engine. Owns:

- The tick loop and scheduler (see [GAME_TICK.md](../../../GAME_TICK.md))
- The combat pipeline / resolver (ordering per ARCHITECTURE.md §7)
- The effect engine and its primitives (damage, heal, buff, debuff, status,
  combo, CC, economy/shield modifiers, target restriction, vision)
- Status processing, economy accrual, perks, targeting, win-condition checks
- Persistent-siege escalation (`siege.ts`) — see ARCHITECTURE.md §0
- The event bus that produces `evt:*` gameplay events

Abilities are configured elsewhere (`../data/`); this executes them.

## Kingdom-specific modules — read before adding one

The engine is generic **by default**, not absolutely. A handful of kingdoms carry
a bespoke subsystem that no reasonable primitive expresses, and those live here as
named modules: `blackjack.ts`, `roulette.ts`, `slotMachine.ts` (Joker),
`volcano.ts`, `hotAsh.ts`, `lavaFloor.ts` (Magma), `crawlers.ts`, `caprice.ts`
(Insects), `centrepiece.ts` (who may hold the middle of the field).

This is accepted and documented in ARCHITECTURE.md §1 — but it is a cost, so:

1. **Default to data.** Most of every kit still composes existing primitives.
2. **If two kingdoms would want it, it is a primitive**, not a module.
3. **A bespoke module is a deliberate decision.** Own file, own constants block
   in `../data/balance.ts`, own tests.

The core loop, combat pipeline, economy, and status engine stay fully generic.
These modules hang off them; they are never branches inside them.
