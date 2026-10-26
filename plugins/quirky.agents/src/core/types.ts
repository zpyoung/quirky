/** How an agent's first prompt reaches it. */
export type PromptMode =
  | 'argv'
  | 'flag-prompt'
  | 'flag-prompt-interactive'
  | 'flag-interactive'
  | 'hermes-query'
  | 'stdin-after-start'

export const PROMPT_MODES: readonly PromptMode[] = [
  'argv',
  'flag-prompt',
  'flag-prompt-interactive',
  'flag-interactive',
  'hermes-query',
  'stdin-after-start'
]

/** Output that shows an agent's input can take a paste. */
export type ReadySignal =
  | 'render-quiet-after-bracketed-paste'
  | 'render-cursor-after-bracketed-paste'
  | 'grok-composer-prompt'
  | 'dsh-composer-prompt'
  | 'zcode-composer-prompt'
  | 'codex-composer-prompt'

/** A ready signal, or OpenCode's agent row, which only says Enter is live. */
export type SubmitSignal = ReadySignal | 'opencode-agent-row'

export const READY_SIGNALS: readonly ReadySignal[] = [
  'render-quiet-after-bracketed-paste',
  'render-cursor-after-bracketed-paste',
  'grok-composer-prompt',
  'dsh-composer-prompt',
  'zcode-composer-prompt',
  'codex-composer-prompt'
]

export const SUBMIT_SIGNALS: readonly SubmitSignal[] = [...READY_SIGNALS, 'opencode-agent-row']

/** Which workspace-trust record is pre-written before the agent starts. */
export type TrustPreset = 'claude' | 'cursor' | 'copilot' | 'codex' | 'antigravity' | 'qoder' | 'qoder-cn'

export const TRUST_PRESETS: readonly TrustPreset[] = ['claude', 'cursor', 'copilot', 'codex', 'antigravity', 'qoder', 'qoder-cn']

/**
 * One validated `agent` contribution, with defaults applied (`launch` and `process` default to
 * `detect`). Field meanings are in tech.md "Agent entry (manifest data)".
 */
export type AgentEntry = {
  id: string
  /** The plugin whose declaration is in effect. */
  plugin: string
  label: string
  detect: string
  detectAliases: string[]
  detectRequires: string[]
  launch: string
  process: string
  env: Record<string, string>
  prompt: PromptMode
  promptSeparator: '--' | null
  draftFlag: string | null
  yolo: string | null
  auto: string | null
  yoloEnv: Record<string, string> | null
  stripArgs: string[]
  /** Argv after the command; placeholders `{id}`, `{transcript}`, `{transcriptOrId}`. */
  resume: string[] | null
  fork: string[] | null
  resumeStyle: 'claude-splice' | null
  readySignal: ReadySignal
  submitSignal: SubmitSignal
  readyTimeoutMs: number
  blindPaste: boolean
  submitRetryMs: number | null
  lineSettleMs: number | null
  enterWithPaste: boolean
  trust: TrustPreset | null
  homepage: string | null
  install: string | null
}

/** A declared agent the catalog left out, and why. */
export type CatalogProblem = { plugin: string; id: string; status: 'invalid' | 'conflict'; error: string }

/** The valid, effective agents in auto-pick order, and the declarations left out. */
export type Catalog = { agents: AgentEntry[]; problems: CatalogProblem[] }

export type PermissionMode = 'manual' | 'auto' | 'yolo'

export type PermissionSummary = 'manual' | 'auto' | 'yolo' | 'mixed'

/** The user's saved overrides for one agent; null means "not overridden". `args === ''` is Manual. */
export type AgentConfig = {
  disabled: boolean
  command: string | null
  args: string | null
  env: Record<string, string> | null
}

export const EMPTY_CONFIG: AgentConfig = { disabled: false, command: null, args: null, env: null }

/** One agent as `quirky.agents/list` and `get` report it. */
export type AgentInfo = {
  id: string
  label: string
  plugin: string
  installed: boolean
  enabled: boolean
  isDefault: boolean
  promptMode: PromptMode
  resumable: boolean
  canFork: boolean
  homepage: string | null
  install: string | null
  command: string
  commandOverridden: boolean
  args: string
  argsOverridden: boolean
  env: Record<string, string>
  envOverridden: boolean
  showEnv: boolean
  permissions: { mode: PermissionMode | 'custom' | null; hasAuto: boolean }
}

/** The result of `quirky.agents/list` and `refresh`. */
export type AgentListing = {
  defaultAgent: string
  workspaceTrust: boolean
  permissions: { summary: PermissionSummary; nonAuto: 'manual' | 'yolo' | 'mixed' }
  agents: AgentInfo[]
  problems?: CatalogProblem[]
}

/** What a session launched with, replayed by resume. */
export type LaunchRecord = { command: string; args: string; env: Record<string, string> }

export type ProviderSession = { id: string; transcriptPath: string | null }

/** How a launch's first prompt reached the agent; null when it had none. */
export type PromptDelivery = 'command-line' | 'pending' | 'pasted' | 'unconfirmed' | 'not-delivered'

/** A launch, planned. `env` values of null remove a variable. */
export type LaunchPlan = {
  agent: string
  command: string
  env: Record<string, string | null>
  record: LaunchRecord
  promptDelivery: 'command-line' | 'pending' | null
  paste: { text: string; submit: boolean } | null
}

/** The settled outcome of pasting a prompt after start. */
export type DeliveryOutcome = 'pasted' | 'unconfirmed' | 'not-delivered'
