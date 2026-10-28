import type { Ask } from '@quirky/protocol'

/** A resolved card is retained only in the UI; pending FIFO authority stays in the daemon. */
export type AskResolutionFlash = { ask: Ask; dismissAt: number }

export const ASK_RESULT_FLASH_MS = 4000
