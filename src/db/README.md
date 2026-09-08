# db — Persistence

Postgres (Supabase in production) through **Drizzle ORM**. Everything here is
*out-of-match* state: accounts, profiles, cosmetics, quests, coins, and match
history. **No live match state is ever written here** — a match lives in memory
and is gone when it ends; only its result is recorded.

The whole layer is **optional**. With no `DATABASE_URL` the server runs fine as
a guest-only game: `getDb()` returns `null` and every function here degrades to
a no-op rather than throwing. That is deliberate — a database outage must not
take the game down with it.

## Layout

| File | Responsibility |
|------|----------------|
| `schema.ts` | Every table, in Drizzle's schema DSL — the single source of truth |
| `client.ts` | The lazily-created pool and `getDb()` / `DbOrTx` |
| `migrate.ts` | Migration runner (an **entry point**, run by `npm run db:migrate`, not imported) |
| `accounts.ts` | Account creation, auth identities, last-seen |
| `coins.ts` | The coin ledger — grants, balance, daily caps |
| `progression.ts` | XP, levels, per-kingdom stats |
| `quests.ts` | Daily quest slots and their claims |
| `cosmetics.ts` | Inventory and equipped items |
| `matches.ts` | Match + participant history rows |
| `admin.ts` | Who is an admin (`ADMIN_EMAILS`), with a cache |
| `privacy.ts` | Data export and account deletion |
| `cleanup.ts` | Scheduled pruning of expired ephemeral accounts |

## Migrations

Schema changes are **generated from `schema.ts`**, never hand-written:

```bash
npm run db:generate     # diff schema.ts -> a new SQL file in drizzle/
npm run build           # migrate.ts runs from dist/
npm run db:migrate      # apply pending migrations (needs .env)
npm run db:studio       # browse the data
```

`db:migrate` and `db:studio` use `--env-file=.env` (not `-if-exists`): they fail
loudly rather than silently pointing at nothing.

## The coin ledger

⚠️ **There is no balance column, and adding one would be a bug.** A balance is
`SUM(delta)` over `coin_ledger`, computed in the database. Every row carries an
`idempotency_key` built from *what caused it* —
`` `${reason}:${refId}:${accountId}` `` — and the column is `UNIQUE`, so the
reward path can run twice and pay once. `grantCoins` returning `false` for a
duplicate is a **success**: the player has the coins either way.

Reasons are `match` | `quest` | `purchase` | `adjustment`. Spending is a
negative `delta`, not a separate table.

### Giving a player coins by hand

Use `adjustment`, and choose a `ref_id` that describes the *occasion* — that is
what makes re-running the statement safe.

```sql
-- 1. Find the account. Usernames are matched lower-cased.
select a.id, p.username
from accounts a
join profiles p on p.account_id = a.id
where p.username_lower = lower('SomePlayer');

-- 2. Grant. Re-running this exact statement is a no-op, by design.
insert into coin_ledger (account_id, delta, reason, ref_id, idempotency_key)
values (
  '<account-uuid>', 500, 'adjustment', 'goodwill-2026-09-07',
  'adjustment:goodwill-2026-09-07:<account-uuid>'
)
on conflict (idempotency_key) do nothing;

-- 3. Confirm.
select coalesce(sum(delta), 0) as balance
from coin_ledger where account_id = '<account-uuid>';
```

To *take* coins away, insert a negative `delta` with a new `ref_id`. Never
`UPDATE` or `DELETE` a ledger row: the history is the balance, so editing one
rewrites the past and breaks any audit of how a player got where they are.

Daily caps live in `daily_earnings`, kept separate so enforcing a cap is one
indexed read rather than an aggregate over the whole ledger.

## Environment

| Variable | Effect |
|----------|--------|
| `DATABASE_URL` | Postgres connection string. Absent ⇒ the whole layer no-ops |
| `ALLOW_TEST_DB` | Lets a test run touch a real database. **Leave it unset** |
| `EPHEMERAL_ACCOUNTS` | Guest accounts expire and are pruned by `cleanup.ts` |
| `ADMIN_EMAILS` | Comma-separated; read by `admin.ts` |

⚠️ **Never run a bare `npx tsx --test`.** The suite is only pointed at the test
database by `npm test`'s `--env-file=.env.test`; without it the tests inherit
whatever `.env` is in the environment and will happily write to live Supabase.
See [../../test/README.md](../../test/README.md).
