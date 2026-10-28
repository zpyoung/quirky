import type { ModelDecl } from './core/types'

/** Only successful authoritative nonempty results may retire a saved model on this exact host. */
export type ModelDiscovery = {
  agent: string
  host: string
  observedAt: number
  status: 'available' | 'unavailable'
  authoritative: boolean
  models: ModelDecl[]
  reason?: string
}
