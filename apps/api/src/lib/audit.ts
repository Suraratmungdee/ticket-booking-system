import type { Prisma } from '@prisma/client'

// Takes a transaction client, never the global prisma import: the entry has
// to commit or roll back together with the change it describes. Written the
// other way round, a crash between the two leaves either an unexplained
// change or a log of something that never happened — and a log people cannot
// trust is worse than no log, because they trust it anyway.
//
// Errors deliberately propagate. See the test.
export async function recordAudit(
  tx: Prisma.TransactionClient,
  input: { adminId: string; action: string; targetType: string; targetId: string },
): Promise<void> {
  await tx.adminAuditLog.create({ data: input })
}
