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

  // .env.example commits the exact same string as the code's dev fallback.
  // The "must be set" check alone would let a deploy that copied
  // .env.example verbatim boot with a publicly known signing key.
  it('throws in production when the webhook secret is still the committed .env.example placeholder', async () => {
    process.env.NODE_ENV = 'production'
    process.env.PAYMENT_PROVIDER = 'stripe'
    process.env.JWT_SECRET = 'x'
    process.env.PAYMENT_WEBHOOK_SECRET = 'dev-webhook-secret-change-me'
    vi.resetModules()
    const { assertPaymentProviderIsSafe } = await import('../../../apps/api/src/lib/config')
    expect(() => assertPaymentProviderIsSafe()).toThrow(/placeholder/i)
  })

  it('does not throw in production with a real, non-placeholder webhook secret', async () => {
    process.env.NODE_ENV = 'production'
    process.env.PAYMENT_PROVIDER = 'stripe'
    process.env.JWT_SECRET = 'x'
    process.env.PAYMENT_WEBHOOK_SECRET = 'a-real-secret-only-the-provider-and-we-know'
    vi.resetModules()
    const { assertPaymentProviderIsSafe } = await import('../../../apps/api/src/lib/config')
    expect(() => assertPaymentProviderIsSafe()).not.toThrow()
  })
})

describe('PAYMENT_PROVIDER default', () => {
  // Forgetting the env var must fail closed (no mock free-tickets endpoint
  // mounted), not fail open. Local dev sets PAYMENT_PROVIDER=mock explicitly.
  it('defaults to stripe, not mock, when unset', async () => {
    delete process.env.PAYMENT_PROVIDER
    vi.resetModules()
    const { PAYMENT_PROVIDER } = await import('../../../apps/api/src/lib/config')
    expect(PAYMENT_PROVIDER).toBe('stripe')
  })
})
