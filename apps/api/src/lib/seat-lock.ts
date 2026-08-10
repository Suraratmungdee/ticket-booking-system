import { getRedis } from './redis.js'
import { SEAT_HOLD_TTL_SECONDS } from './config.js'

const key = (seatId: string) => `hold:seat:${seatId}`

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
}

export async function releaseSeatHolds(seatIds: string[]): Promise<void> {
  if (seatIds.length === 0) return
  const redis = await getRedis()
  await redis.del(seatIds.map(key))
}

// One MGET rather than N round trips, so rendering a 90-seat map costs a
// single Redis call.
export async function getHeldSeatIds(seatIds: string[]): Promise<Set<string>> {
  if (seatIds.length === 0) return new Set()
  const redis = await getRedis()
  const values = await redis.mGet(seatIds.map(key))
  const held = new Set<string>()
  values.forEach((value, i) => {
    if (value !== null) held.add(seatIds[i])
  })
  return held
}
