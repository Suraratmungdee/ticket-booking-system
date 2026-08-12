import { describe, it, expect, afterEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const originalEnv = { ...process.env }

// Parses apps/api/.env.example the same simple way dotenv-style KEY="value"
// files are meant to be read — just enough to pull placeholder values back
// out for the drift test below. Not a general .env parser.
function readEnvExamplePlaceholders(): Record<string, string> {
  const path = join(__dirname, '../../../apps/api/.env.example')
  const text = readFileSync(path, 'utf8')
  const out: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq === -1) continue
    out[trimmed.slice(0, eq)] = trimmed.slice(eq + 1).replace(/^"(.*)"$/, '$1')
  }
  return out
}

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
    process.env.TICKET_SIGNING_SECRET = 'a-real-ticket-secret'
    vi.resetModules()
    const { assertPaymentProviderIsSafe } = await import('../../../apps/api/src/lib/config')
    expect(() => assertPaymentProviderIsSafe()).not.toThrow()
  })
})

describe('assertPaymentProviderIsSafe — ticket signing secret', () => {
  it('refuses to boot in production without TICKET_SIGNING_SECRET', async () => {
    process.env.NODE_ENV = 'production'
    process.env.PAYMENT_PROVIDER = 'stripe'
    process.env.JWT_SECRET = 'x'
    process.env.PAYMENT_WEBHOOK_SECRET = 'a-real-webhook-secret'
    delete process.env.TICKET_SIGNING_SECRET
    vi.resetModules()

    const { assertPaymentProviderIsSafe } = await import('../../../apps/api/src/lib/config')
    expect(() => assertPaymentProviderIsSafe()).toThrow(/TICKET_SIGNING_SECRET/)
  })

  it('refuses to boot in production with the committed placeholder secret', async () => {
    process.env.NODE_ENV = 'production'
    process.env.PAYMENT_PROVIDER = 'stripe'
    process.env.JWT_SECRET = 'x'
    process.env.PAYMENT_WEBHOOK_SECRET = 'a-real-webhook-secret'
    process.env.TICKET_SIGNING_SECRET = 'dev-ticket-secret-change-me'
    vi.resetModules()

    const { assertPaymentProviderIsSafe } = await import('../../../apps/api/src/lib/config')
    expect(() => assertPaymentProviderIsSafe()).toThrow(/placeholder/)
  })

  it('boots in production with a real secret', async () => {
    process.env.NODE_ENV = 'production'
    process.env.PAYMENT_PROVIDER = 'stripe'
    process.env.JWT_SECRET = 'x'
    process.env.PAYMENT_WEBHOOK_SECRET = 'a-real-webhook-secret'
    process.env.TICKET_SIGNING_SECRET = 'a-real-ticket-secret'
    vi.resetModules()

    const { assertPaymentProviderIsSafe } = await import('../../../apps/api/src/lib/config')
    expect(() => assertPaymentProviderIsSafe()).not.toThrow()
  })
})

// The thing that let Finding 1 happen: .env.example shipped a DIFFERENT
// placeholder string than the one the production guard actually rejects, so
// every test above (which asserts against the code's own constants) stayed
// green while a deploy that copied .env.example verbatim would have booted
// with a publicly known secret. This reads the real file from disk instead
// of hardcoding what we think it says, so it breaks the moment the two
// diverge again.
describe('.env.example placeholders are rejected by the production guard', () => {
  const placeholders = readEnvExamplePlaceholders()

  it.each([
    ['JWT_SECRET', placeholders.JWT_SECRET],
    ['PAYMENT_WEBHOOK_SECRET', placeholders.PAYMENT_WEBHOOK_SECRET],
    ['TICKET_SIGNING_SECRET', placeholders.TICKET_SIGNING_SECRET],
  ])('rejects the committed .env.example value for %s', async (key, value) => {
    expect(value).toBeTruthy() // sanity: the key must actually be in the file

    process.env.NODE_ENV = 'production'
    process.env.PAYMENT_PROVIDER = 'stripe'
    process.env.JWT_SECRET = 'a-real-jwt-secret-only-we-know'
    process.env.PAYMENT_WEBHOOK_SECRET = 'a-real-webhook-secret-only-we-know'
    process.env.TICKET_SIGNING_SECRET = 'a-real-ticket-secret-only-we-know'
    process.env[key] = value

    vi.resetModules()
    const { assertPaymentProviderIsSafe } = await import('../../../apps/api/src/lib/config')
    expect(() => assertPaymentProviderIsSafe()).toThrow(/placeholder/i)
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
