import type { LedgerRequest } from './ledger'

export type LedgerUiAttestation = { timestamp: number; nonce: string; mac: string }

const PROOF_DOMAIN = 'quirky-ledger-ui-v1\0'

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonical(item === undefined ? null : item)).join(',')}]`
  }
  return `{${Object.keys(value as Record<string, unknown>)
    .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
    .join(',')}}`
}

export function ledgerUiAttestationPayload(
  request: LedgerRequest,
  timestamp: number,
  nonce: string
): string {
  return `${PROOF_DOMAIN}${canonical({ request, timestamp, nonce })}`
}
