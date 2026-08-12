import {
  LOGIN_RATE_LIMIT_MAX,
  LOGIN_RATE_LIMIT_WINDOW_MS,
  BOOKING_RATE_LIMIT_MAX,
  BOOKING_RATE_LIMIT_WINDOW_MS,
} from './config.js'

type Entry = { count: number; windowStart: number }
type Bucket = { entries: Map<string, Entry>; max: number; windowMs: number }

function createBucket(max: number, windowMs: number): Bucket {
  return { entries: new Map(), max, windowMs }
}

function isExpired(bucket: Bucket, entry: Entry, now: number): boolean {
  return now - entry.windowStart >= bucket.windowMs
}

// Sweeps entries whose window has already elapsed.
//
// ponytail: this bounds *retention* (a key cannot outlive one window past
// its last write), not *size* — within a single window every distinct key
// gets an entry, so an attacker rotating through many IPv6 addresses can
// still grow the Map arbitrarily during that window. The scan is also
// O(bucket size) on every call, so heavy distinct-key traffic is quadratic.
// Fine at this scale for a single instance; move to Redis (with TTL-based
// expiry) if either becomes real.
function sweep(bucket: Bucket, now: number): void {
  for (const [key, entry] of bucket.entries) {
    if (isExpired(bucket, entry, now)) bucket.entries.delete(key)
  }
}

// True when `key` has used up its budget for the current window. Checks
// expiry itself rather than relying on sweep() having run, so a stale entry
// can never read as still-limited.
function isLimited(bucket: Bucket, key: string): boolean {
  const now = Date.now()
  sweep(bucket, now)
  const entry = bucket.entries.get(key)
  if (!entry || isExpired(bucket, entry, now)) return false
  return entry.count >= bucket.max
}

function record(bucket: Bucket, key: string): void {
  const now = Date.now()
  const entry = bucket.entries.get(key)
  if (!entry || isExpired(bucket, entry, now)) {
    bucket.entries.set(key, { count: 1, windowStart: now })
    return
  }
  entry.count += 1
}

function refund(bucket: Bucket, key: string): void {
  const entry = bucket.entries.get(key)
  if (entry && entry.count > 0) entry.count -= 1
}

// One bucket per use case. Sharing a Map would mean a user who exhausted
// their seat-hold budget could not log in either.
const loginBucket = createBucket(LOGIN_RATE_LIMIT_MAX, LOGIN_RATE_LIMIT_WINDOW_MS)
const bookingBucket = createBucket(BOOKING_RATE_LIMIT_MAX, BOOKING_RATE_LIMIT_WINDOW_MS)

// --- Login: keyed by IP, counts only failures ---
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
// index.ts warns at boot when this looks wrong. The seat-hold bucket below
// avoids the problem entirely by keying on the authenticated user id.

export function isRateLimited(key: string): boolean {
  return isLimited(loginBucket, key)
}

// Reserves one unit of budget against `key` *before* the login attempt
// runs (see auth.ts: called synchronously with the isRateLimited() check,
// before the `await loginUser(...)`). This closes the check-then-act race
// where concurrent requests all read the same pre-increment count and none
// of them see the others' attempts — the reservation must land before any
// await, or a parallel burst sails through the gate for free.
export function recordLoginFailure(key: string): void {
  record(loginBucket, key)
}

// Refunds one unit of budget previously reserved by recordLoginFailure().
// Called after a login that turned out to succeed, so only genuine
// failures end up counted — see auth.ts.
export function refundAttempt(key: string): void {
  refund(loginBucket, key)
}

// --- Seat holds: keyed by user id, counts every attempt ---
//
// No refund counterpart, deliberately: a successful hold is exactly what
// this limit exists to bound, so it must stay charged.

export function isBookingRateLimited(userId: string): boolean {
  return isLimited(bookingBucket, userId)
}

export function recordBookingAttempt(userId: string): void {
  record(bookingBucket, userId)
}

// Test-only: clears every bucket so tests do not leak into each other.
export function resetRateLimitState(): void {
  loginBucket.entries.clear()
  bookingBucket.entries.clear()
}
