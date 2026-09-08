# auth — Identity

Who a player is, if they choose to be anybody. **Signing in is optional**: the
game is fully playable as a guest, and everything here exists to let a player
*keep* progress rather than to gate them out of a match.

| File | Responsibility |
|------|----------------|
| `google.ts` | Verifies a Google ID token (`GOOGLE_CLIENT_ID`) into a profile |
| `sessions.ts` | Issues, reads, and renews the signed session token (`JWT_SECRET`) |
| `username.ts` | Validates and normalises a display name (3–16 chars) |
| `age.ts` | The minimum-age check |

**Usernames are compared lower-cased.** `usernameKey()` produces the value
stored in `profiles.username_lower`, which carries the uniqueness constraint —
the cased original is only for display. Comparing raw usernames anywhere is a
bug that shows up as two accounts that look identical.

**`checkAge` is a gate, not a record.** The minimum is 13
(`MINIMUM_ACCOUNT_AGE`); what persists is a coarse `age_bracket` on the account,
never a birth date. Keep it that way — see [../db/privacy.ts](../db/privacy.ts)
for export and deletion.

Session tokens are stateless and signed; `readSessionToken` returns the account
id or `null`, and never throws on a malformed or expired token.
