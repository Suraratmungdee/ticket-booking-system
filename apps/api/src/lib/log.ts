// console.error(err) on a raw error (e.g. a Prisma error) would print its
// full message, which for validation errors can echo request data (for
// auth, that includes passwordHash — the bcrypt hash, not the plaintext,
// but still no reason to log it). Log only the bits useful for debugging
// instead of the whole object. Shared by every route's 500 handler.
export function logServerError(context: string, err: unknown): void {
  const info =
    typeof err === 'object' && err !== null
      ? { code: (err as { code?: unknown }).code, message: (err as { message?: unknown }).message }
      : err
  console.error(context, info)
}
