# Kingdoms — Server

The **authoritative** game server for Kingdoms: a real-time, free-for-all party
game for 2–7 players (plus spectators, to 8 seats), played in a browser and
designed for phones first.

Node.js + TypeScript + Socket.IO. One match is one authoritative simulation
running in one Socket.IO room. **The client never decides anything** — it sends
intents and renders what this server reports.

## Running it

```bash
npm install
npm run dev        # tsx watch src/index.ts — the one you want
npm run build      # tsc -> dist/
npm start          # node dist/index.js (production)
npm run dev:dist   # build, then nodemon dist/ — only to debug the built output
```

```bash
npm test           # node:test suites in test/
npm run typecheck  # tsc --noEmit  (src)
npm run typecheck:test   # tsc -p tsconfig.test.json  (src + test together)
```

> ⚠️ **Run `npm test`, never a bare `npx tsx --test`.** Only the npm script
> passes `--env-file=.env.test`; without it the suite inherits your `.env` and
> writes to the **live** database. See [test/README.md](test/README.md).

> **Standing rule:** run the build **and** the tests for every repo a change
> touches before calling that change done.

### Environment

Listens on `PORT` (default **3001**). Nothing below is required to boot — with
an empty environment the server runs as a guest-only game on localhost.

| Variable | Effect |
|----------|--------|
| `PORT` / `HOST` | Where to listen (default `3001`) |
| `CLIENT_ORIGIN` | The client's origin. **Outside dev, cross-origin clients are blocked without it** |
| `DATABASE_URL` | Postgres/Supabase. Absent ⇒ persistence no-ops, the game still runs |
| `JWT_SECRET` | Signs session tokens |
| `GOOGLE_CLIENT_ID` | Google sign-in |
| `ADMIN_EMAILS` | Comma-separated admin accounts |
| `EPHEMERAL_ACCOUNTS` | Guest accounts expire and get pruned |
| `RECONNECT_GRACE_MS` | How long a dropped player keeps their seat (default 60 s) |
| `ELEMENTALS_AI_MODEL_DIR` | Where to find the bot models (default `models/`) |
| `LOG_LEVEL`, `NODE_ENV` | Logging and mode |
| `ALLOW_TEST_DB` | Lets a test touch a real database. **Leave it unset** |

### Database

```bash
npm run db:generate   # schema.ts -> a new SQL migration
npm run db:migrate    # apply pending migrations (build first; needs .env)
npm run db:studio     # browse the data
```

Coins are a **ledger**, not a balance column — the recipe for granting a player
coins by hand is in [src/db/README.md](src/db/README.md).

### Bots and balance

```bash
npm run sim -- ffa --matches 70        # free-for-all balance read
npm run sim -- params                  # every tunable and where it lives
npm run sim -- optimize --params <id>  # tune ONE lever, emits a candidate
```

Candidates are **never auto-applied**. The loop is FFA → diagnose → optimize one
lever → FFA; change one thing at a time. Full guide in
[simulation/README.md](simulation/README.md), bot models and training in
[src/ai/README.md](src/ai/README.md).

## Layout

| Folder | Responsibility |
|--------|----------------|
| `src/net/` | Sockets, lobbies, matchmaking, reconnection, intent routing, state sync |
| `src/match/` | Per-match simulation: `Match`, `GameState`, player state, snapshots |
| `src/engine/` | Tick loop, combat pipeline, effect primitives, statuses, economy, perks, targeting — plus the per-kingdom subsystems |
| `src/data/` | All content and tunables: kingdoms, abilities, perks, `balance.ts` |
| `src/ai/` | The bot subsystem (observation/action encoding, controller, difficulty) |
| `src/db/` | Postgres via Drizzle: accounts, coins, quests, match history |
| `simulation/` | Headless balance-simulation harness (internal tool, not shipped) |
| `test/` | `node:test` suites |

Each folder carries its own README.

## Design docs

Canonical at the **workspace root**, shared with the Client repo:

- [ARCHITECTURE.md](../ARCHITECTURE.md) — **start here**; §0 states what kind of
  game this is, and most design decisions only make sense in that light
- [ABILITY_SYSTEM.md](../ABILITY_SYSTEM.md) — how kits are built, and the rule
  that a kit is designed around a combo rather than five independent buttons
- [DATA_MODELS.md](../DATA_MODELS.md) — state shapes
- [GAME_TICK.md](../GAME_TICK.md) — the loop and its fixed phase ordering
- [SOCKET_EVENTS.md](../SOCKET_EVENTS.md) — the wire contract

## Two rules worth knowing before your first change

1. **Prices live here and nowhere else.** An ability's cost, unlock cost,
   cooldown, and upgrade costs are defined in `src/data/<kingdom>Abilities.ts`
   and reach the client via the `abilityPrices` sync. A price hardcoded in the
   client is a bug even when the number matches.
2. **Every tunable is read through `param(id, base)`**, never imported and used
   directly, so the simulation can run candidate balance sets without touching
   production data.
