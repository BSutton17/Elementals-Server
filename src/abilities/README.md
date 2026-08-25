# abilities — (folder unused)

**There is no code here.** The ability *system* lives in
[`../engine/abilities.ts`](../engine/abilities.ts) — validation, unlocks,
upgrade tiers, charges, cooldowns, and resolving an `AbilityDefinition` into
effects. Ability *content* lives in [`../data/`](../data/) as one
`<kingdom>Abilities.ts` per kingdom.

This folder was planned as a separate home for the system and was folded into
`engine/` instead. Kept only so the path in older tickets resolves somewhere.
See [ABILITY_SYSTEM.md](../../../ABILITY_SYSTEM.md).
