import { describe, it, expect, afterEach, vi } from 'vitest'

const originalEnv = { ...process.env }

afterEach(() => {
  process.env = { ...originalEnv }
  vi.resetModules()
})

describe('assertPaymentProviderIsSafe', () => {
  it('throws when the mock provider is enabled in production', async () => {
    process.env.NODE_ENV = 'production'
    process.env.PAYMENT_PROVIDER = 'mock'
    process.env.JWT_SECRET = 'x'
    process.env.PAYMENT_WEBHOOK_SECRET = 'y'
    vi.resetModules()
    const { assertPaymentProviderIsSafe } = await import('../../../apps/api/src/lib/config')
    expect(() => assertPaymentProviderIsSafe()).toThrow(/mock/i)
  })

  it('throws in production when the webhook secret is unset', async () => {
    process.env.NODE_ENV = 'production'
    process.env.PAYMENT_PROVIDER = 'stripe'
    process.env.JWT_SECRET = 'x'
    delete process.env.PAYMENT_WEBHOOK_SECRET
    vi.resetModules()
    const { assertPaymentProviderIsSafe } = await import('../../../apps/api/src/lib/config')
    expect(() => assertPaymentProviderIsSafe()).toThrow(/PAYMENT_WEBHOOK_SECRET/)
  })

  it('does not throw in development with the mock provider', async () => {
    process.env.NODE_ENV = 'development'
    process.env.PAYMENT_PROVIDER = 'mock'
    vi.resetModules()
    const { assertPaymentProviderIsSafe } = await import('../../../apps/api/src/lib/config')
    expect(() => assertPaymentProviderIsSafe()).not.toThrow()
  })
})
