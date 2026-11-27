import { z } from 'zod'

/** What the CLI knows about its caller from the environment; the host verifies it before trusting it. */
export const CallerHintSchema = z.object({
  role: z.literal('brain').optional(),
  agentSessionId: z.string().optional(),
  worktreeId: z.string().optional(),
  terminalHandle: z.string().optional()
})

export type CallerHint = z.infer<typeof CallerHintSchema>

/** The identity the host attributes a mutation to, resolved server-side from a hint and the transport. */
export const AttributedCallerSchema = z.object({
  kind: z.enum(['brain', 'agent-session', 'terminal', 'remote', 'mobile', 'script']),
  label: z.string(),
  worktreeId: z.string().optional(),
  agentSessionId: z.string().optional(),
  deviceId: z.string().optional()
})

export type AttributedCaller = z.infer<typeof AttributedCallerSchema>

function nonEmpty(value: string | undefined): string | undefined {
  return value ? value : undefined
}

/** Reads the caller hint from QUIRKY_CALLER_ROLE (only `brain` is honored), QUIRKY_AGENT_SESSION_ID, QUIRKY_WORKTREE_ID and QUIRKY_TERMINAL_HANDLE; empty values are ignored. */
export function readCallerHintFromEnv(
  env: Readonly<Record<string, string | undefined>>
): CallerHint {
  const hint: CallerHint = {}
  if (env.QUIRKY_CALLER_ROLE === 'brain') {
    hint.role = 'brain'
  }
  const agentSessionId = nonEmpty(env.QUIRKY_AGENT_SESSION_ID)
  if (agentSessionId) {
    hint.agentSessionId = agentSessionId
  }
  const worktreeId = nonEmpty(env.QUIRKY_WORKTREE_ID)
  if (worktreeId) {
    hint.worktreeId = worktreeId
  }
  const terminalHandle = nonEmpty(env.QUIRKY_TERMINAL_HANDLE)
  if (terminalHandle) {
    hint.terminalHandle = terminalHandle
  }
  return hint
}
