import type { AgentCapabilities } from '@quirky/protocol'

const OK = { ok: true } as const

const STARTUP_ONLY = { ok: false, reason: 'Set when the chat starts' } as const

const CODEX_APPROVAL = 'Codex runs with on-request approval in Quirky'

const CAPABILITIES: Record<AgentCapabilities['agent'], AgentCapabilities> = {
  claude: {
    agent: 'claude',
    steer: OK,
    model: OK,
    planMode: OK,
    permissionModes: { ok: true, modes: ['default', 'acceptEdits', 'plan'] },
    images: OK,
    effort: OK,
    approveForSession: OK,
    resume: OK
  },
  codex: {
    agent: 'codex',
    steer: OK,
    model: OK,
    planMode: { ok: false, reason: CODEX_APPROVAL },
    permissionModes: { ok: false, reason: CODEX_APPROVAL },
    images: OK,
    effort: OK,
    approveForSession: OK,
    resume: OK
  },
  pi: {
    agent: 'pi',
    steer: OK,
    model: STARTUP_ONLY,
    planMode: { ok: false, reason: 'pi has no plan mode' },
    permissionModes: { ok: false, reason: 'pi has no permission modes' },
    images: OK,
    effort: STARTUP_ONLY,
    approveForSession: { ok: false, reason: 'pi has no session-wide approval' },
    resume: OK
  },
  omp: {
    agent: 'omp',
    steer: OK,
    model: STARTUP_ONLY,
    planMode: { ok: false, reason: 'omp has no plan mode' },
    permissionModes: { ok: false, reason: 'omp has no permission modes' },
    images: OK,
    effort: STARTUP_ONLY,
    approveForSession: { ok: false, reason: 'omp has no session-wide approval' },
    resume: OK
  }
}

/** The static feature set of an agent's runner, or null for an agent Quirky has no runner for. */
export function capabilitiesFor(agent: string): AgentCapabilities | null {
  return Object.hasOwn(CAPABILITIES, agent) ? CAPABILITIES[agent as AgentCapabilities['agent']] : null
}
