export const QUIRKYD_PAIRING_REPAIR_FAILED_CODE = 'quirkyd_pairing_repair_failed'

/** The host's server refuses this desktop and pairing again over SSH did not fix it. */
export class QuirkydManagedPairingRepairFailedError extends Error {
  readonly code = QUIRKYD_PAIRING_REPAIR_FAILED_CODE
  constructor(reason: string) {
    super(
      `${QUIRKYD_PAIRING_REPAIR_FAILED_CODE}: the Quirky server on this host no longer accepts this ` +
        `computer, and Quirky couldn't pair with it again over SSH: ${reason}. Nothing on the host ` +
        `was stopped; its terminals can't be verified until Quirky pairs again. Connect again to retry.`
    )
    this.name = 'QuirkydManagedPairingRepairFailedError'
  }
}
