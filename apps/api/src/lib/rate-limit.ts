import { LOGIN_RATE_LIMIT_MAX, LOGIN_RATE_LIMIT_WINDOW_MS } from './config.js'

type Entry = { count: number; windowStart: number }

// Fixed-window counter, keyed by client IP. Deliberately not counting every
// request (see recordLoginFailure below) — only failed login attempts.
const attempts = new Map<string, Entry>()

function isExpired(entry: Entry, now: number): boolean {
  return now - entry.windowStart >= LOGIN_RATE_LIMIT_WINDOW_MS
}

// Sweeps entries whose window has already elapsed.
//
// ponytail: this bounds *retention* (a key can't outlive one window past
// its last write), not *size* — within a single window every distinct IP
// with a failed login gets an entry, so one attacker rotating through many
// IPv6 addresses can still grow the Map arbitrarily large during that
// window. The scan itself is also O(map size) on every call, so heavy
// distinct-IP traffic is quadratic. Fine at login-endpoint scale for a
// single Phase-1 instance; move to Redis (with TTL-based expiry) if either
// becomes real.
function sweep(now: number): void {
  for (const [key, entry] of attempts) {
    if (isExpired(entry, now)) attempts.delete(key)
  }
}

// True when `key` has already used up its budget for the current window —
// the caller should reject with 429 without even attempting the login.
// Checks expiry itself (does not rely on sweep() having run first) so a
// stale entry can never read as still-limited.
export function isRateLimited(key: string): boolean {
  const now = Date.now()
  sweep(now)
  const entry = attempts.get(key)
  if (!entry || isExpired(entry, now)) return false
  return entry.count >= LOGIN_RATE_LIMIT_MAX
}

// Reserves one unit of budget against `key` *before* the login attempt
// runs (see auth.ts: called synchronously with the isRateLimited() check,
// before the `await loginUser(...)`). This closes the check-then-act race
// where concurrent requests all read the same pre-increment count and none
// of them see the others' attempts — the reservation must land before any
// await, or a parallel burst sails through the gate for free.
//
// LIMITATION: keyed on req.ip. Express only derives req.ip from
// X-Forwarded-For when `trust proxy` is enabled (config.ts's TRUST_PROXY,
// default off). Left off, every request behind a reverse proxy arrives as
// the proxy's single IP — meaning 10 wrong passwords from ONE attacker
// shares that bucket with every other user behind the same proxy and locks
// ALL of them out of login for 15 minutes. That's the realistic first-deploy
// outcome, since virtually every PaaS terminates TLS at a proxy. Turning
// TRUST_PROXY on fixes it, but only do that when an actual trusted proxy
// sits in front (otherwise a client can spoof X-Forwarded-For and dodge the
// limiter entirely — see index.ts). The Map is also in-memory only: state
// resets on restart and isn't shared across multiple API instances. Redis
// (already planned for Phase 2 seat locks) is the upgrade path for that.
export function recordLoginFailure(key: string): void {
  const now = Date.now()
  const entry = attempts.get(key)
  if (!entry || isExpired(entry, now)) {
    attempts.set(key, { count: 1, windowStart: now })
    return
  }
  entry.count += 1
}

// Refunds one unit of budget previously reserved by recordLoginFailure().
// Called after a login that turned out to succeed, so only genuine
// failures end up counted — see auth.ts.
export function refundAttempt(key: string): void {
  const entry = attempts.get(key)
  if (entry && entry.count > 0) entry.count -= 1
}

// Test-only: clears all state so tests don't leak into each other.
export function resetRateLimitState(): void {
  attempts.clear()
}
