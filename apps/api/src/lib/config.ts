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
const DEV_JWT_SECRET_FALLBACK = 'dev-secret-change-me'
if (process.env.NODE_ENV === 'production' && !process.env.JWT_SECRET) {
  throw new Error('JWT_SECRET must be set when NODE_ENV=production')
}
export const JWT_SECRET = process.env.JWT_SECRET ?? DEV_JWT_SECRET_FALLBACK

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

// Cap on seats one POST /admin/seatmaps may generate. Chosen by a human on
// 12 Aug 2026 as "enough for this project", not derived from a real hall's
// capacity — a bigger zone means several requests, or moving this number.
// The point of the cap is that one request cannot ask for a million rows.
export const MAX_SEATS_PER_SEATMAP = 100

// Seat-hold guard. MAX_SEATS_PER_BOOKING caps one booking, not how many
// bookings a user may open — without this, one account can hold a whole
// showtime a few seats at a time. Keyed on the authenticated user id rather
// than the IP: /showtimes/:id/seats/hold requires a session anyway, and a
// user id comes from a JWT we signed instead of a header a client can set,
// so this bucket is unaffected by whether TRUST_PROXY is on.
//
// 10 per minute leaves room for someone changing their mind repeatedly while
// picking seats, and still bounds how fast one account can accumulate holds.
export const BOOKING_RATE_LIMIT_MAX = 10
export const BOOKING_RATE_LIMIT_WINDOW_MS = 60 * 1000

export const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379'

// 'mock' runs a self-hosted fake provider so the payment flow can be
// demonstrated without a real payment account. Swapping to a real provider
// is meant to be a change at the provider layer only, not in booking logic.
//
// Default is 'stripe', not 'mock': the mock provider exposes an
// unauthenticated free-tickets endpoint (see assertPaymentProviderIsSafe
// below), and the boot guard that would catch it only runs when
// NODE_ENV === 'production'. A deploy with NODE_ENV unset/'staging' and this
// variable forgotten must fail closed (no mock routes mounted) rather than
// fail open — convenient for local dev is not the same as safe by default,
// so local dev sets PAYMENT_PROVIDER=mock explicitly in .env instead.
export const PAYMENT_PROVIDER = process.env.PAYMENT_PROVIDER ?? 'stripe'

// Shared secret the provider signs webhook bodies with. The dev fallback is
// committed and therefore not a secret; production must set a real one —
// and must not set it to the .env.example placeholder, which is exactly
// this same string (see the placeholder check below).
const DEV_WEBHOOK_SECRET_FALLBACK = 'dev-webhook-secret-change-me'
export const PAYMENT_WEBHOOK_SECRET =
  process.env.PAYMENT_WEBHOOK_SECRET ?? DEV_WEBHOOK_SECRET_FALLBACK

// Where the mock provider posts its webhook back to. Only used by the mock.
export const API_BASE_URL = process.env.API_BASE_URL ?? 'http://localhost:4000'

// Signs the QR payload on a ticket. Deliberately NOT the same value as
// PAYMENT_WEBHOOK_SECRET: those are two different trust boundaries, and
// whoever gets one leaked must not be able to forge the other.
//
// LIMITATION: falls back to a dev-only value committed in this repo (so it
// is not a secret) to keep local boot working without a .env. The guard in
// assertPaymentProviderIsSafe below makes that fallback unreachable in
// production.
const DEV_TICKET_SECRET_FALLBACK = 'dev-ticket-secret-change-me'
export const TICKET_SIGNING_SECRET =
  process.env.TICKET_SIGNING_SECRET ?? DEV_TICKET_SECRET_FALLBACK

// Confirmation email. Unset is a supported state: lib/email.ts logs the
// message instead of sending it, so local dev needs no mail account.
export const RESEND_API_KEY = process.env.RESEND_API_KEY
export const EMAIL_FROM = process.env.EMAIL_FROM ?? 'tickets@example.com'

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
  // .env.example commits the exact same string as the code's dev fallback.
  // The "must be set" check right above JWT_SECRET's export only verifies
  // the variable is *set* — a deploy that copied .env.example verbatim
  // would pass it while booting with a publicly known JWT signing key,
  // letting anyone forge a valid session cookie for any user. Reject that
  // specific value outright in production.
  if (
    process.env.NODE_ENV === 'production' &&
    process.env.JWT_SECRET === DEV_JWT_SECRET_FALLBACK
  ) {
    throw new Error(
      'JWT_SECRET is still the committed .env.example placeholder — set a real secret before deploying to production.',
    )
  }
  // .env.example commits the same string as the code fallback above. The
  // check just above only verifies the variable is *set* — a deploy that
  // copied .env.example verbatim would pass it while boot with a publicly
  // known signing key, letting anyone forge a webhook that pays their own
  // booking for free. Reject that specific value outright in production.
  if (
    process.env.NODE_ENV === 'production' &&
    process.env.PAYMENT_WEBHOOK_SECRET === DEV_WEBHOOK_SECRET_FALLBACK
  ) {
    throw new Error(
      'PAYMENT_WEBHOOK_SECRET is still the committed .env.example placeholder — set a real secret before deploying to production.',
    )
  }
  // Same failure Phase 3 had to be patched for: a deploy that copied
  // .env.example verbatim would boot with a publicly known signing key,
  // letting anyone mint a valid-looking ticket QR for free.
  if (process.env.NODE_ENV === 'production' && !process.env.TICKET_SIGNING_SECRET) {
    throw new Error('TICKET_SIGNING_SECRET must be set when NODE_ENV=production')
  }
  if (
    process.env.NODE_ENV === 'production' &&
    process.env.TICKET_SIGNING_SECRET === DEV_TICKET_SECRET_FALLBACK
  ) {
    throw new Error(
      'TICKET_SIGNING_SECRET is still the committed .env.example placeholder — set a real secret before deploying to production.',
    )
  }
}
