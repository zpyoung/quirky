import type { LaunchSettings } from '@quirky/protocol'

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
  /** The model and option catalog; null when the agent takes no launch settings. */
  launchOptions: LaunchCatalog | null
  /** How the agent runs once to produce text; null when it can't. */
  oneShot: OneShotSpec | null
}

/**
 * One item of a one-shot `args` template: a literal argument, or a group of arguments that is
 * included only when `when` holds. Literals may contain `{model}`, `{thinking}` and `{prompt}`.
 * `when` is `model` (the model isn't `default`), `thinking` (the model has a thinking level) or
 * `thinking=<level>`; `{thinking}` is only allowed inside a thinking group.
 */
export type OneShotArg = string | { when: string; args: string[] }

/** A model a one-shot run can use; `thinking` is the effort level it runs with, null when it has none. */
export type OneShotModel = { id: string; label: string; thinking: string | null }

/**
 * The validated `oneShot` block of an agent entry; field meanings are in tech.md "Data models".
 * `command` is what a run starts when the user hasn't overridden the agent's command, and
 * defaults to the entry's `launch`. `singletonOptions` are alias groups the CLI accepts once, so
 * a user argument naming one replaces the generated flag; the default is `[['--model']]`.
 */
export type OneShotSpec = {
  args: OneShotArg[]
  command: string | null
  prompt: 'stdin' | 'argv'
  output: 'text' | 'opencode-json'
  singletonOptions: string[][]
  models: OneShotModel[]
  defaultModel: string | null
  /** `claude` marks the entry whose run is retried without `--strict-mcp-config` when an enterprise MCP config refuses it. */
  background: 'claude' | null
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
  /**
   * Whether the agent has a one-shot shape, so `quirky.agents/generate` can run it. The daemon
   * always reports it; it is optional here only so fixtures built before it existed still type.
   */
  canGenerate?: boolean
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
  /** What the launch applied; null with no picks and no arguments. */
  launchSettings: LaunchSettings | null
}

/** The settled outcome of pasting a prompt after start. */
export type DeliveryOutcome = 'pasted' | 'unconfirmed' | 'not-delivered'

/** Flags that already set something: any of `flags`, and with `valuePrefix` only when the value starts with it. */
export type Conflict = { flags: string[]; valuePrefix?: string }

export type OptionDecl = {
  id: string
  label: string
  type: 'select' | 'boolean'
  /** Present, non-empty, for a select; null for a boolean. */
  choices: { value: string; label: string }[] | null
  /** Argv template with one item containing `{value}`; null when composed or structured-only. */
  flag: string[] | null
  conflicts: Conflict[]
  composed: boolean
  structured: string | null
}

/** An option a model offers; `choices` narrows the declared values (in declared order), null means all. */
export type OptionUse = { id: string; choices: string[] | null }

export type ModelDecl = { id: string; label: string; description: string | null; options: OptionUse[] }

export type ExtraArgKind = 'model' | 'effort' | 'repeatable'

export type ExtraArgRule = { kind: ExtraArgKind; flags: string[]; valuePrefix?: string }

/** The validated `launchOptions` block of an agent entry; field meanings are in tech.md "Data models / schemas". */
export type LaunchCatalog = {
  model: { flag: string[]; conflicts: Conflict[]; structured: string | null }
  options: OptionDecl[]
  models: ModelDecl[]
  unlisted: 'accept' | 'refuse'
  unlistedOptions: OptionUse[]
  composeModel: 'cursor' | null
  valueFlags: string[]
  extraArgs: { allowed: ExtraArgRule[]; placeholder: string } | null
}

/** A caller's pick before validation. */
export type Selection = { model?: string; options?: Record<string, string | boolean> }

/** A pick checked against the catalog; `listed` is false for a model the catalog doesn't name. */
export type ValidSelection = { model: string; values: Record<string, string | boolean>; listed: boolean }

/** Extra arguments that passed the allowlist. */
export type ParsedExtras = { tokens: string[]; kinds: Set<ExtraArgKind> }

/** The result of resolving a selection and extras against an agent's configured arguments. */
export type Resolution = {
  /** The pick's flags as emitted; empty when there is no pick or it is shadowed. */
  added: string[]
  /** The arguments a launch uses, as tokens: configured minus replaced flags, extras, then `added`, before any `--`. */
  args: string[]
  structured: Record<string, string | boolean>
  /** Picked option IDs (and "model") that extras set instead. */
  shadowed: string[]
  launchSettings: LaunchSettings | null
}

export type { LaunchSettings }
