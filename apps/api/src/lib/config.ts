export const BCRYPT_SALT_ROUNDS = 10
// Single source of truth for session length: both the JWT expiry and the
// cookie maxAge derive from this so they cannot drift apart.
export const JWT_MAX_AGE_MS = 2 * 60 * 60 * 1000
export const JWT_COOKIE_NAME = 'token'

// LIMITATION: falls back to a dev-only secret so local boot never crashes;
// production must set a real JWT_SECRET or every token becomes forgeable.
export const JWT_SECRET = process.env.JWT_SECRET ?? 'dev-secret-change-me'

export const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN ?? 'http://localhost:3000'
