import { describe, it, expect, beforeEach, vi } from 'vitest'

const m = vi.hoisted(() => ({ createBooking: vi.fn() }))

vi.mock('../../../apps/api/src/lib/booking', () => ({
  createBooking: m.createBooking,
  TooManySeatsError: class TooManySeatsError extends Error {},
  SeatUnavailableError: class SeatUnavailableError extends Error {},
}))

import {
  isBookingRateLimited,
  recordBookingAttempt,
  isRateLimited,
  recordLoginFailure,
  resetRateLimitState,
} from '../../../apps/api/src/lib/rate-limit'
import {
  BOOKING_RATE_LIMIT_MAX,
  BOOKING_RATE_LIMIT_WINDOW_MS,
  LOGIN_RATE_LIMIT_MAX,
} from '../../../apps/api/src/lib/config'
import { holdSeatsHandler } from '../../../apps/api/src/routes/showtimes'

beforeEach(() => {
  resetRateLimitState()
  m.createBooking.mockReset()
})

describe('booking rate limit', () => {
  it('allows a user under the limit', () => {
    for (let i = 0; i < BOOKING_RATE_LIMIT_MAX - 1; i++) {
      recordBookingAttempt('user-1')
    }
    expect(isBookingRateLimited('user-1')).toBe(false)
  })

  it('blocks a user once they reach the limit', () => {
    for (let i = 0; i < BOOKING_RATE_LIMIT_MAX; i++) {
      recordBookingAttempt('user-1')
    }
    expect(isBookingRateLimited('user-1')).toBe(true)
  })

  // The whole reason for keying on the user id. If the buckets were shared
  // or the key were the proxy's IP, one user hitting the limit would lock
  // out everyone else booking at the same time.
  it('does not charge one user against another', () => {
    for (let i = 0; i < BOOKING_RATE_LIMIT_MAX; i++) {
      recordBookingAttempt('user-1')
    }
    expect(isBookingRateLimited('user-2')).toBe(false)
  })

  // Separate buckets: exhausting the booking budget must not lock a user
  // out of logging in, and vice versa.
  it('keeps the login and booking budgets independent', () => {
    for (let i = 0; i < BOOKING_RATE_LIMIT_MAX; i++) {
      recordBookingAttempt('same-key')
    }
    expect(isBookingRateLimited('same-key')).toBe(true)
    expect(isRateLimited('same-key')).toBe(false)

    resetRateLimitState()

    for (let i = 0; i < LOGIN_RATE_LIMIT_MAX; i++) {
      recordLoginFailure('same-key')
    }
    expect(isRateLimited('same-key')).toBe(true)
    expect(isBookingRateLimited('same-key')).toBe(false)
  })

  it('clears both buckets on reset', () => {
    for (let i = 0; i < BOOKING_RATE_LIMIT_MAX; i++) recordBookingAttempt('user-1')
    for (let i = 0; i < LOGIN_RATE_LIMIT_MAX; i++) recordLoginFailure('1.2.3.4')

    resetRateLimitState()

    expect(isBookingRateLimited('user-1')).toBe(false)
    expect(isRateLimited('1.2.3.4')).toBe(false)
  })

  // A limit that never lifts is a ban. Read how the existing
  // tests/unit/api/rate-limit.test.ts advances time for the login bucket and
  // use the same mechanism here rather than sleeping for a real minute.
  it('lets the user through again once the window has elapsed', () => {
    vi.useFakeTimers()
    try {
      for (let i = 0; i < BOOKING_RATE_LIMIT_MAX; i++) recordBookingAttempt('user-1')
      expect(isBookingRateLimited('user-1')).toBe(true)

      vi.advanceTimersByTime(BOOKING_RATE_LIMIT_WINDOW_MS)

      expect(isBookingRateLimited('user-1')).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })
})

function makeRes() {
  const res = { status: vi.fn(), json: vi.fn() } as any
  res.status.mockReturnValue(res)
  res.json.mockReturnValue(res)
  return res
}

function holdReq(userId: string) {
  return { params: { id: 'st1' }, body: { seatIds: ['s1'] }, user: { id: userId } } as never
}

describe('POST /showtimes/:id/seats/hold rate limit', () => {
  it('429s once the user is over the limit, without touching the booking layer', async () => {
    resetRateLimitState()
    for (let i = 0; i < BOOKING_RATE_LIMIT_MAX; i++) recordBookingAttempt('user-1')
    const res = makeRes()

    await holdSeatsHandler(holdReq('user-1'), res, vi.fn())

    expect(res.status).toHaveBeenCalledWith(429)
    expect(m.createBooking).not.toHaveBeenCalled()
  })

  it('lets a different user through', async () => {
    resetRateLimitState()
    for (let i = 0; i < BOOKING_RATE_LIMIT_MAX; i++) recordBookingAttempt('user-1')
    m.createBooking.mockResolvedValue({
      id: 'b1',
      status: 'PENDING_PAYMENT',
      totalPrice: 1000,
      expiresAt: new Date(),
    })
    const res = makeRes()

    await holdSeatsHandler(holdReq('user-2'), res, vi.fn())

    expect(res.status).toHaveBeenCalledWith(201)
    expect(m.createBooking).toHaveBeenCalledTimes(1)
  })

  // Charged whether or not the booking succeeds — a burst of failures is
  // exactly the pattern this limit exists to slow down.
  it('charges the attempt even when the booking fails', async () => {
    resetRateLimitState()
    m.createBooking.mockRejectedValue(new Error('boom'))
    const res = makeRes()

    await holdSeatsHandler(holdReq('user-3'), res, vi.fn())

    for (let i = 0; i < BOOKING_RATE_LIMIT_MAX - 1; i++) recordBookingAttempt('user-3')
    expect(isBookingRateLimited('user-3')).toBe(true)
  })
})
