import { describe, it, expect, beforeEach, vi } from 'vitest'
import { isRateLimited, recordLoginFailure, resetRateLimitState } from '../../../apps/api/src/lib/rate-limit'
import { LOGIN_RATE_LIMIT_MAX, LOGIN_RATE_LIMIT_WINDOW_MS } from '../../../apps/api/src/lib/config'

beforeEach(() => {
  resetRateLimitState()
  vi.useRealTimers()
})

describe('rate-limit', () => {
  it('allows a key that is under the limit', () => {
    for (let i = 0; i < LOGIN_RATE_LIMIT_MAX - 1; i++) {
      recordLoginFailure('1.2.3.4')
    }
    expect(isRateLimited('1.2.3.4')).toBe(false)
  })

  it('blocks once a key reaches the limit', () => {
    for (let i = 0; i < LOGIN_RATE_LIMIT_MAX; i++) {
      recordLoginFailure('1.2.3.4')
    }
    expect(isRateLimited('1.2.3.4')).toBe(true)
  })

  it('tracks each key independently', () => {
    for (let i = 0; i < LOGIN_RATE_LIMIT_MAX; i++) {
      recordLoginFailure('1.2.3.4')
    }
    expect(isRateLimited('5.6.7.8')).toBe(false)
  })

  it('resets a key once its window has elapsed, so the Map does not grow forever', () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    for (let i = 0; i < LOGIN_RATE_LIMIT_MAX; i++) {
      recordLoginFailure('1.2.3.4')
    }
    expect(isRateLimited('1.2.3.4')).toBe(true)

    vi.setSystemTime(LOGIN_RATE_LIMIT_WINDOW_MS + 1)
    expect(isRateLimited('1.2.3.4')).toBe(false)

    // A fresh failure after the window rolled over starts a brand new
    // window rather than reusing the stale, already-expired entry.
    recordLoginFailure('1.2.3.4')
    expect(isRateLimited('1.2.3.4')).toBe(false)
  })
})
