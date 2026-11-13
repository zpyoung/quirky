import type { AvatarSettings, HandoffInput, Level, Mandate, SwitchId, Switches } from './contracts'

const LEVELS: readonly Level[] = ['shadow', 'local', 'own-branch', 'full']
const SWITCH_IDS: readonly SwitchId[] = ['messaging', 'historyRewrite', 'deploys']

const KNOWN_BINARIES = new Set([
  'bun', 'bunx', 'npm', 'npx', 'pnpm', 'yarn', 'node', 'deno', 'tsc', 'eslint', 'prettier', 'vitest', 'jest', 'playwright',
  'make', 'just', 'cargo', 'rustc', 'go', 'pytest', 'python', 'python3', 'pip', 'uv', 'poetry', 'ruby', 'rake', 'bundle', 'rspec',
  'mvn', 'gradle', 'dotnet', 'swift', 'xcodebuild', 'git', 'gh', 'glab', 'curl', 'sh', 'bash', 'zsh', 'test', 'docker', 'kubectl',
  'terraform', 'helm', 'quirky'
])

const FILLER_WORDS = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'be', 'it', 'its', 'that', 'this', 'these', 'those', 'to', 'sure', 'all', 'any', 'every', 'each',
  'your', 'my', 'our', 'their', 'has', 'have', 'and', 'or', 'but', 'when', 'once', 'if', 'so', 'with', 'for', 'in', 'on', 'at', 'of', 'out', 'up', 'there', 'no', 'not'
])

/**
 * Whether a done-when reads as a shell command or as prose. It is a command when it is one line, its
 * first word (after any `VAR=value` prefixes) is a known tool or a path, and its second word is not an
 * English filler such as "the" or "sure", so "make sure the tests pass" stays prose.
 */
export function inferDoneWhenKind(doneWhen: string): 'command' | 'prose' {
  const text = doneWhen.trim()
  if (text === '' || text.includes('\n')) return 'prose'
  const words = text.split(/\s+/)
  let first = 0
  while (first < words.length && /^[A-Za-z_][A-Za-z0-9_]*=\S*$/.test(words[first] ?? '')) first++
  const head = words[first]
  if (head === undefined) return 'prose'
  const isPath = /^(\.{1,2}\/|\/|~\/)/.test(head)
  if (!isPath && !KNOWN_BINARIES.has(head)) return 'prose'
  const next = words[first + 1]
  if (next !== undefined && FILLER_WORDS.has(next.toLowerCase())) return 'prose'
  if (!isPath && /[.!?]$/.test(text)) return 'prose'
  return 'command'
}

function trimmedLines(value: unknown): string[] | null {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string')) return null
  return (value as string[]).map((entry) => entry.trim()).filter((entry) => entry !== '')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export type Normalized = { ok: true; value: HandoffInput } | { ok: false; error: string }

/**
 * Validates one hand-off item as received from the sheet, the CLI or the brain, and fills level and
 * switches from `settings` where the item leaves them out. Errors are `invalid: <field>` for the first
 * bad field.
 */
export function normalizeHandoffInput(raw: unknown, settings: AvatarSettings): Normalized {
  if (!isRecord(raw)) return { ok: false, error: 'invalid: item' }
  const bad = (field: string): Normalized => ({ ok: false, error: `invalid: ${field}` })

  if (typeof raw.worktreeId !== 'string' || raw.worktreeId.trim() === '') return bad('worktreeId')
  if (typeof raw.goal !== 'string' || raw.goal.trim() === '') return bad('goal')
  if (typeof raw.doneWhen !== 'string' || raw.doneWhen.trim() === '') return bad('doneWhen')

  let level = settings.defaultLevel
  if (raw.level !== undefined) {
    if (!LEVELS.includes(raw.level as Level)) return bad('level')
    level = raw.level as Level
  }

  const switches: Switches = { ...settings.switches }
  if (raw.switches !== undefined) {
    if (!isRecord(raw.switches)) return bad('switches')
    for (const [id, enabled] of Object.entries(raw.switches)) {
      if (!SWITCH_IDS.includes(id as SwitchId) || typeof enabled !== 'boolean') return bad('switches')
      switches[id as SwitchId] = enabled
    }
  }

  const guidelines = raw.guidelines === undefined ? [] : trimmedLines(raw.guidelines)
  if (guidelines === null) return bad('guidelines')

  let agent: string | null = null
  if (raw.agent !== undefined && raw.agent !== null) {
    if (typeof raw.agent !== 'string') return bad('agent')
    agent = raw.agent.trim() === '' ? null : raw.agent.trim()
  }
  if (raw.notes !== undefined && typeof raw.notes !== 'string') return bad('notes')
  if (raw.allowSplit !== undefined && typeof raw.allowSplit !== 'boolean') return bad('allowSplit')

  const value: HandoffInput = {
    worktreeId: raw.worktreeId.trim(),
    goal: raw.goal.trim(),
    doneWhen: raw.doneWhen.trim(),
    doneWhenKind: raw.doneWhenKind === 'command' || raw.doneWhenKind === 'prose' ? raw.doneWhenKind : inferDoneWhenKind(raw.doneWhen),
    guidelines,
    level,
    switches,
    agent,
    notes: typeof raw.notes === 'string' ? raw.notes.trim() : '',
    allowSplit: raw.allowSplit === true
  }
  if (raw.sharedGoal !== undefined) {
    const shared = raw.sharedGoal
    if (!isRecord(shared) || typeof shared.goal !== 'string' || shared.goal.trim() === '') return bad('sharedGoal')
    if (shared.id !== undefined && (typeof shared.id !== 'string' || shared.id === '')) return bad('sharedGoal')
    value.sharedGoal = { ...(typeof shared.id === 'string' ? { id: shared.id } : {}), goal: shared.goal.trim() }
  }
  return { ok: true, value }
}

export type MandatePatch = Partial<Pick<Mandate, 'goal' | 'doneWhen' | 'guidelines' | 'notes'>>

/**
 * Applies a proposed edit to a mandate. Only goal, done-when, guidelines and notes can change, so a
 * patch can never move the level or the switches; any other key is ignored.
 */
export function applyMandatePatch(mandate: Mandate, patch: MandatePatch, at: number): { ok: true; value: Mandate } | { ok: false; error: string } {
  const next: Mandate = { ...mandate, updatedAt: at }
  let touched = false
  if (patch.goal !== undefined) {
    if (typeof patch.goal !== 'string' || patch.goal.trim() === '') return { ok: false, error: 'invalid: goal' }
    next.goal = patch.goal.trim()
    touched = true
  }
  if (patch.doneWhen !== undefined) {
    if (typeof patch.doneWhen !== 'string' || patch.doneWhen.trim() === '') return { ok: false, error: 'invalid: doneWhen' }
    next.doneWhen = patch.doneWhen.trim()
    next.doneWhenKind = inferDoneWhenKind(next.doneWhen)
    touched = true
  }
  if (patch.guidelines !== undefined) {
    const guidelines = trimmedLines(patch.guidelines)
    if (guidelines === null) return { ok: false, error: 'invalid: guidelines' }
    next.guidelines = guidelines
    touched = true
  }
  if (patch.notes !== undefined) {
    if (typeof patch.notes !== 'string') return { ok: false, error: 'invalid: notes' }
    next.notes = patch.notes.trim()
    touched = true
  }
  return touched ? { ok: true, value: next } : { ok: false, error: 'invalid: patch' }
}
