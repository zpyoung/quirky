import type { ServeReadiness } from '../server/serve-readiness'
import type { QuirkydManagedStopContext } from '../../shared/quirkyd-stop-request'

export type QuirkydOptions = {
  port?: number
  json?: boolean
  noPairing?: boolean
  pairingAddress?: string
  /** Desktop `quirky serve` parity: a mobile-scoped offer with a terminal QR. */
  mobilePairing?: boolean
  /** Lets the paired runtime client drive this machine's desktop (computer.*). */
  grantDesktopControl?: boolean
  /** Desktop `quirky serve` parity: print only the ephemeral-VM recipe line. */
  recipeJson?: boolean
  projectRoot?: string
  /** Literal IP to bind. Defaults to loopback; see quirkyd-bind-address.ts. */
  bind?: string
  /** The browser client's directory; the slot carries none, so `quirky serve` passes the app's. */
  webClientRoot?: string
}

export type QuirkydHandle = {
  readiness: ServeReadiness
  /** What an instance-bound stop request must name to stop this process. */
  managedStop: QuirkydManagedStopContext
  stop(): Promise<void>
}
