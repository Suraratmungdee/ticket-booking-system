import { LOGIN_RATE_LIMIT_MAX, LOGIN_RATE_LIMIT_WINDOW_MS } from './config.js'

type Entry = { count: number; windowStart: number }

// Fixed-window counter, keyed by client IP. Deliberately not counting every
// request (see recordLoginFailure below) — only failed login attempts.
const attempts = new Map<string, Entry>()

function isExpired(entry: Entry, now: number): boolean {
  return now - entry.windowStart >= LOGIN_RATE_LIMIT_WINDOW_MS
}

// Sweeps entries whose window has already elapsed. Runs inline on every
// call instead of a timer/interval — login traffic is small enough that an
// O(n) scan over the map is cheap, and it avoids managing a timer's
// lifecycle (clearing it on shutdown, in tests, etc). This is what keeps
// the Map from growing without bound as distinct IPs churn through.
function sweep(now: number): void {
  for (const [key, entry] of attempts) {
    if (isExpired(entry, now)) attempts.delete(key)
  }
}

// True when `key` has already used up its budget for the current window —
// the caller should reject with 429 without even attempting the login.
// Checking does not itself consume budget; call recordLoginFailure() after
// an actual failed login to do that.
export function isRateLimited(key: string): boolean {
  const now = Date.now()
  sweep(now)
  const entry = attempts.get(key)
  if (!entry) return false
  return entry.count >= LOGIN_RATE_LIMIT_MAX
}

// Counts one failed login attempt against `key`. Only failures are counted
// (see auth.ts) so a burst of successful logins — e.g. several people
// behind one office NAT, or a user's own retries after fixing a typo —
// never trips the limiter; only repeated bad passwords do.
//
// LIMITATION: keyed on req.ip, which Express only derives from
// X-Forwarded-For when `trust proxy` is enabled — it isn't here, so behind
// a reverse proxy in production every request would arrive as the proxy's
// IP and share one bucket. The Map is also in-memory only: state resets on
// restart and is not shared across multiple API instances. Both are fine
// for a single-instance Phase 1 deploy; upgrade to Redis (already planned
// for Phase 2 seat locks) if either a proxy or horizontal scaling shows up.
export function recordLoginFailure(key: string): void {
  const now = Date.now()
  const entry = attempts.get(key)
  if (!entry || isExpired(entry, now)) {
    attempts.set(key, { count: 1, windowStart: now })
    return
  }
  entry.count += 1
}

// Test-only: clears all state so tests don't leak into each other.
export function resetRateLimitState(): void {
  attempts.clear()
}
