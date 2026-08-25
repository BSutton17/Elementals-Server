# player — (folder unused)

**There is no code here.** Per-player state lives in
[`../match/playerState.ts`](../match/playerState.ts): castle (HP + shields),
economy (citizens / currency / income), ability instances and levels, statuses,
modifiers, target, and elimination bookkeeping.

Reconnection bookkeeping — a player keeps their seat across a socket drop — is
in [`../net/ReconnectionManager.ts`](../net/ReconnectionManager.ts).

This folder was planned separately and was folded into `match/`. Kept only so
the path in older tickets resolves somewhere.
See [DATA_MODELS.md](../../../DATA_MODELS.md) → Player.
