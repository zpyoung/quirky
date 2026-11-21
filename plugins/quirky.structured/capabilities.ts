import type { AgentCapabilities } from '@quirky/protocol'

const OK = { ok: true } as const

/** The terminal permission presets `quirky agents permissions` stores per agent. */
export type TerminalPermissionPreset = 'manual' | 'auto' | 'yolo'

type ModeTable = {
  modes: string[]
  labels: Record<string, string>
  dangerous: string[]
  /** The chat mode each terminal preset matches, so a new chat starts the way the agent's terminals do. */
  fromTerminal: Partial<Record<TerminalPermissionPreset, string>>
}

const CLAUDE_MODES: ModeTable = {
  modes: ['default', 'acceptEdits', 'plan', 'auto', 'dontAsk', 'bypassPermissions'],
  labels: { default: 'Default', acceptEdits: 'Accept edits', plan: 'Plan', auto: 'Auto', dontAsk: "Don't ask", bypassPermissions: 'Bypass permissions' },
  dangerous: ['bypassPermissions'],
  fromTerminal: { manual: 'default', auto: 'auto', yolo: 'bypassPermissions' }
}

/** Codex's own `/permissions` presets; each maps to an approval policy, sandbox and reviewer in the runner. */
const CODEX_MODES: ModeTable = {
  modes: ['default', 'read-only', 'auto-review', 'full-access'],
  labels: { default: 'Default', 'read-only': 'Read only', 'auto-review': 'Auto-review', 'full-access': 'Full access' },
  dangerous: ['full-access'],
  fromTerminal: { manual: 'default', auto: 'auto-review', yolo: 'full-access' }
}

/** omp's `--approval-mode` values, fixed per process, so the runner relaunches omp to switch. */
const OMP_MODES: ModeTable = {
  modes: ['always-ask', 'always-ask-cached', 'write', 'yolo'],
  labels: { 'always-ask': 'Always ask', 'always-ask-cached': 'Ask and remember', write: 'Write', yolo: 'Yolo' },
  dangerous: ['yolo'],
  fromTerminal: {}
}

const MODE_TABLES: Partial<Record<AgentCapabilities['agent'], ModeTable>> = { claude: CLAUDE_MODES, codex: CODEX_MODES, omp: OMP_MODES }

const advertised = ({ modes, labels, dangerous }: ModeTable): AgentCapabilities['permissionModes'] => ({ ok: true, modes, labels, dangerous })

const CAPABILITIES: Record<AgentCapabilities['agent'], AgentCapabilities> = {
  claude: {
    agent: 'claude',
    steer: OK,
    model: OK,
    planMode: OK,
    permissionModes: advertised(CLAUDE_MODES),
    images: OK,
    effort: OK,
    approveForSession: OK,
    resume: OK,
    fork: OK,
    subagents: 'full',
    stopAgent: OK
  },
  codex: {
    agent: 'codex',
    steer: OK,
    model: OK,
    planMode: { ok: false, reason: 'Codex has no plan mode in Quirky' },
    permissionModes: advertised(CODEX_MODES),
    images: OK,
    effort: OK,
    approveForSession: OK,
    resume: OK,
    fork: OK,
    subagents: 'full',
    stopAgent: OK
  },
  pi: {
    agent: 'pi',
    steer: OK,
    model: OK,
    planMode: { ok: false, reason: 'pi has no plan mode' },
    permissionModes: { ok: false, reason: 'pi has no permission modes; it runs tools without asking unless an extension asks' },
    images: OK,
    effort: OK,
    approveForSession: { ok: false, reason: 'pi has no session-wide approval' },
    resume: OK,
    fork: { ok: false, reason: "pi can't fork from Quirky yet" },
    subagents: 'states',
    stopAgent: { ok: false, reason: "pi can't stop one subagent" }
  },
  omp: {
    agent: 'omp',
    steer: OK,
    model: OK,
    planMode: { ok: false, reason: 'omp has no plan mode' },
    permissionModes: advertised(OMP_MODES),
    images: OK,
    effort: OK,
    approveForSession: { ok: false, reason: 'omp has no session-wide approval' },
    resume: OK,
    fork: { ok: false, reason: "omp can't fork from Quirky yet" },
    subagents: 'full',
    stopAgent: OK
  }
}

/** The static feature set of an agent's runner, or null for an agent Quirky has no runner for. */
export function capabilitiesFor(agent: string): AgentCapabilities | null {
  return Object.hasOwn(CAPABILITIES, agent) ? CAPABILITIES[agent as AgentCapabilities['agent']] : null
}

/**
 * The permission mode a new chat for `agent` starts in: `picked` when the agent offers it, else the
 * chat mode matching the agent's terminal preset, else the agent's default. Undefined for an agent
 * with no permission modes.
 */
export function startingPermissionMode(agent: string, picked: string | undefined, terminal: string | null | undefined): string | undefined {
  const table = Object.hasOwn(MODE_TABLES, agent) ? MODE_TABLES[agent as AgentCapabilities['agent']] : undefined
  if (!table) return undefined
  if (picked !== undefined && table.modes.includes(picked)) return picked
  const matched = terminal === 'manual' || terminal === 'auto' || terminal === 'yolo' ? table.fromTerminal[terminal] : undefined
  return matched ?? table.modes[0]
}
