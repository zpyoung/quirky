import type { GateOutcome, ToolCall } from '../contracts'

/** What the gate decided, in the terms an agent's hook protocol can express. */
export type EncodableDecision = { outcome: GateOutcome; reason: string }

/**
 * The exact text an agent must see for a gate decision: the hook's stdout for Claude and Codex, or
 * the JSON of the extension's return value for pi and omp, where an empty string means `undefined`
 * (let the call run). Deny, held and retry all block. An allow at Codex's PreToolUse is `{}`, since
 * Codex completes the allow at PermissionRequest from the receipt.
 */
export function encodeDecision(agent: string, event: ToolCall['event'], decision: EncodableDecision): string {
  const { outcome, reason } = decision
  const blocks = outcome === 'deny' || outcome === 'held' || outcome === 'retry'
  if (agent === 'pi' || agent === 'omp') return blocks ? JSON.stringify({ block: true, reason }) : ''
  if (outcome === 'passthrough') return '{}'
  if (event === 'PermissionRequest') {
    const answer = blocks ? { behavior: 'deny', message: reason } : { behavior: 'allow' }
    return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: answer } })
  }
  if (!blocks && agent === 'codex') return '{}'
  return JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: blocks ? 'deny' : 'allow', permissionDecisionReason: reason }
  })
}
