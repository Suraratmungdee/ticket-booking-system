import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const ORIGINAL_ENV = process.env.NODE_ENV

beforeEach(() => {
  vi.resetModules()
})
afterEach(() => {
  process.env.NODE_ENV = ORIGINAL_ENV
})

function makeRes() {
  const headers: Record<string, string> = {}
  return {
    headers,
    setHeader: (name: string, value: string) => {
      headers[name] = value
    },
  }
}

describe('securityHeaders', () => {
  it('sets the three always-on headers and calls next', async () => {
    process.env.NODE_ENV = 'development'
    const { securityHeaders } = await import(
      '../../../apps/api/src/middleware/security-headers'
    )
    const res = makeRes()
    const next = vi.fn()

    securityHeaders({} as never, res as never, next)

    expect(res.headers['X-Content-Type-Options']).toBe('nosniff')
    expect(res.headers['X-Frame-Options']).toBe('DENY')
    expect(res.headers['Referrer-Policy']).toBe('no-referrer')
    expect(next).toHaveBeenCalledTimes(1)
  })

  // Setting HSTS while developing teaches the browser that localhost must be
  // HTTPS — for every port, for a year, across every other project on the
  // machine. It is painful to undo, so this must never fire outside
  // production.
  it('does not set HSTS outside production', async () => {
    process.env.NODE_ENV = 'development'
    const { securityHeaders } = await import(
      '../../../apps/api/src/middleware/security-headers'
    )
    const res = makeRes()

    securityHeaders({} as never, res as never, vi.fn())

    expect(res.headers['Strict-Transport-Security']).toBeUndefined()
  })

  it('sets HSTS in production', async () => {
    process.env.NODE_ENV = 'production'
    const { securityHeaders } = await import(
      '../../../apps/api/src/middleware/security-headers'
    )
    const res = makeRes()

    securityHeaders({} as never, res as never, vi.fn())

    expect(res.headers['Strict-Transport-Security']).toBe(
      'max-age=31536000; includeSubDomains',
    )
  })

  it('calls next exactly once even in production', async () => {
    process.env.NODE_ENV = 'production'
    const { securityHeaders } = await import(
      '../../../apps/api/src/middleware/security-headers'
    )
    const next = vi.fn()

    securityHeaders({} as never, makeRes() as never, next)

    expect(next).toHaveBeenCalledTimes(1)
  })
})
