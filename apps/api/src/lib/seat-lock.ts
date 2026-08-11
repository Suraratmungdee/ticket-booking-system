import { getRedis } from './redis.js'
import { SEAT_HOLD_TTL_SECONDS } from './config.js'

const key = (seatId: string) => `hold:seat:${seatId}`

// LIMITATION: every function below fails *open* on any Redis error
// (connection refused, timeout, a broken command — anything getRedis() or
// the client throws). This module is only a fast-fail gate, not the
// correctness guarantee, so when Redis is unavailable we behave as if the
// gate allowed the request and let Postgres's `SELECT ... FOR UPDATE` in
// lib/booking.ts decide for real. Concretely, while Redis is down:
//   - no fast 409 for a seat someone else is actively holding (the reject
//     only happens once the request reaches the DB transaction)
//   - the seat map's `HELD` overlay disappears — everything reads AVAILABLE
//     or BOOKED, so two people can see the same free-looking seat
//   - all contention is resolved by the DB row lock alone (still correct,
//     just slower and with a worse error message)
// Upgrade path: none needed for correctness; only revisit if a Redis outage
// needs to *also* preserve the fast-fail UX, e.g. via a circuit breaker.

// Takes a short-lived hold on every seat or none at all.
//
// The all-or-nothing part is the point: acquiring 2 of 3 seats and returning
// false without releasing those 2 would strand them for the full TTL, which
// users see as "the seat looks free but I can't select it".
//
// This is a first gate for fast failure and a better error message, NOT the
// correctness guarantee — Postgres's `SELECT ... FOR UPDATE` in
// lib/booking.ts is. If Redis is down or wrong, booking stays correct.
export async function acquireSeatHolds(seatIds: string[], userId: string): Promise<boolean> {
  if (seatIds.length === 0) return true
  try {
    const redis = await getRedis()
    const acquired: string[] = []

    for (const seatId of seatIds) {
      const result = await redis.set(key(seatId), userId, {
        NX: true,
        EX: SEAT_HOLD_TTL_SECONDS,
      })
      if (result !== 'OK') {
        if (acquired.length > 0) await redis.del(acquired)
        return false
      }
      acquired.push(key(seatId))
    }

    return true
  } catch (err) {
    console.error('[seat-lock] acquireSeatHolds: Redis unavailable, failing open', err)
    return true
  }
}

export async function releaseSeatHolds(seatIds: string[]): Promise<void> {
  if (seatIds.length === 0) return
  try {
    const redis = await getRedis()
    await redis.del(seatIds.map(key))
  } catch (err) {
    console.error('[seat-lock] releaseSeatHolds: Redis unavailable, nothing to release', err)
  }
}

// One MGET rather than N round trips, so rendering a 90-seat map costs a
// single Redis call.
export async function getHeldSeatIds(seatIds: string[]): Promise<Set<string>> {
  if (seatIds.length === 0) return new Set()
  try {
    const redis = await getRedis()
    const values = await redis.mGet(seatIds.map(key))
    const held = new Set<string>()
    values.forEach((value, i) => {
      if (value !== null) held.add(seatIds[i])
    })
    return held
  } catch (err) {
    console.error('[seat-lock] getHeldSeatIds: Redis unavailable, showing no holds', err)
    return new Set()
  }
}
