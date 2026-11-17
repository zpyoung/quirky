import type { ModelDecl } from './core/types'

export type DiscoveryOptionInfo = {
  id: string
  label: string
  type: 'select' | 'boolean'
  choices: { value: string; label: string }[] | null
  /** The choice a new launch starts on, present only when it is among `choices`. */
  default?: string
}

/** Only successful authoritative nonempty results may retire a saved model on this exact host. */
export type ModelDiscovery = {
  agent: string
  host: string
  observedAt: number
  status: 'available' | 'unavailable'
  authoritative: boolean
  models: ModelDecl[]
  unlisted: 'accept' | 'refuse'
  unlistedOptions: DiscoveryOptionInfo[]
  reason?: string
}
