import { OAuth2Client } from "google-auth-library";

// No client secret needed for this flow - we are only READING a token Google
// already issued, not asking Google for anything on the user's behalf.
const client = new OAuth2Client();

export interface GoogleProfile {
  /** Google's permanent, unique id for this person. */
  googleId: string;
  email?: string;
  name?: string;
  picture?: string;
}

/**
 * Checks that an ID token really came from Google and really was issued for
 * OUR app, then returns who it says the user is.
 *
 * `verifyIdToken` checks four things for us:
 *   - the signature matches Google's published public keys
 *   - `aud` (audience) is our client id, so a token minted for a DIFFERENT
 *     app cannot be replayed against ours
 *   - `iss` (issuer) is really Google
 *   - `exp` (expiry) has not passed
 *
 * Throws if any check fails. Never catch and ignore that.
 */
export async function verifyGoogleIdToken(idToken: string): Promise<GoogleProfile> {
  const ticket = await client.verifyIdToken({
    idToken,
    audience: process.env.GOOGLE_CLIENT_ID,
  });

  const payload = ticket.getPayload();
  if (!payload?.sub) throw new Error("Token has no subject");

  return {
    // ⚠️ ALWAYS identify people by `sub`, never by email. A person can change
    // their Gmail address; `sub` is permanent and never reused by Google.
    googleId: payload.sub,
    email: payload.email,
    name: payload.name,
    picture: payload.picture,
  };
}
