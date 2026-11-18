import { createHash } from 'node:crypto'

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value).sort()) out[key] = canonical((value as Record<string, unknown>)[key])
    return out
  }
  return value
}

/**
 * The identity of one tool call: sha256 hex over the canonical JSON (object keys sorted at every
 * depth) of the agent, worktree, tool name and input. Gate receipts and session-record checks
 * both use it, so the same call always hashes the same wherever it was seen.
 */
export function callFingerprint(agent: string, worktreeId: string, toolName: string, toolInput: unknown): string {
  const text = JSON.stringify(canonical({ agent, worktreeId, toolName, toolInput }))
  return createHash('sha256').update(text).digest('hex')
}
