# abilities — Ability System

The shared ability system used by every kingdom (see
[ABILITY_SYSTEM.md](../../../ABILITY_SYSTEM.md)). Owns:

- Resolving an `AbilityDefinition` into effects the `engine/` executes
- Validation (ownership, cooldown, resources, targeting rules)
- Cooldown, upgrade-tier, and passive-trigger handling

Ability **content** (definitions per kingdom) is data and lives in `data/`;
this folder is the generic machinery that runs that data. No kingdom-specific
branches.
