/** What a client learns from decommissioning a managed quirkyd. */
import type { QuirkydManagedRefusal } from './quirkyd-managed-runtime'
import type { QuirkydDaemonRetirementVerdict } from './quirkyd-stop-request'

export type QuirkydDecommissionResult =
  | {
      outcome: 'decommissioned'
      version: string
      /** The daemon's fate: `retired`, or kept with its terminals (`live`/`unverifiable`). */
      retirement: QuirkydDaemonRetirementVerdict
    }
  | QuirkydManagedRefusal
