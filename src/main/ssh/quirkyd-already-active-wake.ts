import { wakeStoppedManagedQuirkyd } from '../managed-server/lifecycle/quirkyd-managed-wake'
import type { QuirkydSlotOptions } from './quirkyd-recovery-slot'

/**
 * After a deploy found its own version already active: it launches nothing, and that slot may have
 * stopped since (a kill, a host reboot), so start it on proven exit. True when this call started it.
 */
export async function wakeAlreadyActiveQuirkyd(options: QuirkydSlotOptions): Promise<boolean> {
  const wake = await wakeStoppedManagedQuirkyd(options)
  if (wake.outcome === 'recovery-refused') {
    throw new Error(wake.reason)
  }
  return wake.outcome === 'started'
}
