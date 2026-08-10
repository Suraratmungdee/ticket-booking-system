export const BCRYPT_SALT_ROUNDS = 10
// Single source of truth for session length: both the JWT expiry and the
// cookie maxAge derive from this so they cannot drift apart.
export const JWT_MAX_AGE_MS = 2 * 60 * 60 * 1000
export const JWT_COOKIE_NAME = 'token'

// In production, apps/web and apps/api deploy to different registrable
// domains, so the cookie is cross-site from the browser's point of view —
// `sameSite: 'lax'` would silently never be sent back, making login look
// like it worked while every later request is anonymous. `none` fixes that,
// but browsers reject `SameSite=None` cookies outright unless `Secure` is
// also set, so the two must always move together.
export const COOKIE_SAME_SITE = process.env.NODE_ENV === 'production' ? 'none' : 'lax'
export const COOKIE_SECURE = process.env.NODE_ENV === 'production'

// LIMITATION: falls back to a dev-only secret (committed in this repo, so it
// is not a secret) so local boot never crashes without a .env file. In
// production this fallback must never be reachable — the check below throws
// at startup instead, so a misconfigured deploy fails loudly rather than
// silently signing forgeable tokens.
if (process.env.NODE_ENV === 'production' && !process.env.JWT_SECRET) {
  throw new Error('JWT_SECRET must be set when NODE_ENV=production')
}
export const JWT_SECRET = process.env.JWT_SECRET ?? 'dev-secret-change-me'

export const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN ?? 'http://localhost:3000'

// Login brute-force guard (see lib/rate-limit.ts). Only *failed* login
// attempts consume this budget, so it exists to slow down password
// guessing, not to throttle legitimate repeat logins. 10 failures per 15
// minutes is generous for a human mistyping a password a few times, while
// making online guessing impractical.
export const LOGIN_RATE_LIMIT_MAX = 10
export const LOGIN_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000
