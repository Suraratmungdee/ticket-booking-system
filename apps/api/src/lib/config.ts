export const BCRYPT_SALT_ROUNDS = 10
export const JWT_EXPIRES_IN = '2h'
export const JWT_COOKIE_NAME = 'token'

// LIMITATION: falls back to a dev-only secret so local boot never crashes;
// production must set a real JWT_SECRET or every token becomes forgeable.
export const JWT_SECRET = process.env.JWT_SECRET ?? 'dev-secret-change-me'

export const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN ?? 'http://localhost:3000'
