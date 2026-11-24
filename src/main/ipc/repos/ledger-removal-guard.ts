import { z } from 'zod'
import { LedgerError } from '../../../shared/ledger'
import type { QuirkyRuntimeService } from '../../runtime/quirky-runtime'

export type RepoRemovalRuntime = Pick<QuirkyRuntimeService, 'deleteProjectGroup' | 'removeProject'>

export const ExpectedLedgersArg = z
  .array(z.object({ ledgerId: z.string().min(1).max(256), revision: z.number().int().positive() }))
  .max(10_000)
  .optional()

// Why: Electron IPC drops custom error properties, so a ledger conflict code only reaches the
// renderer if it rides in the message the renderer is allowed to see.
export async function withLedgerErrorCode<T>(action: () => Promise<T>): Promise<T> {
  try {
    return await action()
  } catch (error) {
    if (error instanceof LedgerError) {
      throw new Error(`${error.code}: ${error.message}`)
    }
    throw error
  }
}
