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
// guessing, not to throttle legitimate repeat logins. Humans rarely need
// more than 4-5 tries to get their own password right, but a bigger number
// is a real gift to an attacker: at 10 failures / 15 min an attacker gets
// 960 guesses/day/IP — against an 8-char-minimum policy with no complexity
// or breach-list check, that's enough to walk a top-100 password list
// against one account in about 2.5 hours. 5 keeps that budget tight while
// still fitting a human's usual mistyped-password count.
export const LOGIN_RATE_LIMIT_MAX = 5
export const LOGIN_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000

// Opt-in only: when true, Express trusts the `X-Forwarded-For` header (via
// `app.set('trust proxy', ...)` in index.ts) so req.ip reflects the real
// client behind a reverse proxy instead of the proxy's own address. Off by
// default because trusting that header when there is NO proxy in front lets
// any client set it themselves and pick a fresh IP per request, bypassing
// the login rate limiter entirely. Only flip this on for a deploy that
// actually terminates TLS at a proxy (nearly every PaaS does) — see the
// LIMITATION comment on recordLoginFailure in lib/rate-limit.ts for what
// happens if you deploy behind one with this left off.
export const TRUST_PROXY = process.env.TRUST_PROXY === 'true'

// How long a seat stays held for one user before it returns to the pool.
// Long enough to finish a checkout form, short enough that an abandoned
// cart doesn't hoard seats. Mirrored as the Redis key TTL.
export const SEAT_HOLD_TTL_SECONDS = 300

// Cap on seats per booking, so one request cannot sweep a whole zone.
export const MAX_SEATS_PER_BOOKING = 8

export const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379'

// 'mock' runs a self-hosted fake provider so the payment flow can be
// demonstrated without a real payment account. Swapping to a real provider
// is meant to be a change at the provider layer only, not in booking logic.
export const PAYMENT_PROVIDER = process.env.PAYMENT_PROVIDER ?? 'mock'

// Shared secret the provider signs webhook bodies with. The dev fallback is
// committed and therefore not a secret; production must set a real one.
export const PAYMENT_WEBHOOK_SECRET =
  process.env.PAYMENT_WEBHOOK_SECRET ?? 'dev-webhook-secret-change-me'

// Where the mock provider posts its webhook back to. Only used by the mock.
export const API_BASE_URL = process.env.API_BASE_URL ?? 'http://localhost:4000'

// The mock provider can mark any booking PAID with no money involved. Shipped
// to production it is a free-tickets endpoint for anyone who finds it, so a
// production boot with the mock enabled must fail loudly rather than quietly
// expose it. index.ts additionally refuses to mount the route at all unless
// the provider is 'mock'.
export function assertPaymentProviderIsSafe(): void {
  if (process.env.NODE_ENV === 'production' && PAYMENT_PROVIDER === 'mock') {
    throw new Error(
      'Refusing to start: PAYMENT_PROVIDER=mock in production would let anyone mark a booking PAID without paying.',
    )
  }
  if (process.env.NODE_ENV === 'production' && !process.env.PAYMENT_WEBHOOK_SECRET) {
    throw new Error('PAYMENT_WEBHOOK_SECRET must be set when NODE_ENV=production')
  }
}
