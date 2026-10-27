/** The shapes shared by the rule files, their sources and the matcher. */

export type RuleState = 'working' | 'blocked' | 'idle'
export type BlockedKind = 'approval' | 'question'

export type Matcher = { regex: string; ignoreCase?: boolean } | { contains: string }

export type Rule = {
  id: string
  why?: string
  state: RuleState
  kind?: BlockedKind
  region: 'title' | 'screen'
  lastLines?: number
  all?: Matcher[]
  none?: Matcher[]
  quietMs?: number
}

export type RuleFile = { agent: string; description?: string; rules: Rule[] }

export type Origin =
  | { kind: 'user'; path: string }
  | { kind: 'plugin'; plugin: string; contribution: string }
  | { kind: 'built-in'; path: string }

export type IgnoredSource = { origin: Origin; reason: string }

export type RuleListing = { agent: string; origin: Origin | null; rules: number; ignored: IgnoredSource[] }

export type Verdict = { rule: string; state: RuleState; kind?: BlockedKind; origin: Origin }

/** What a rule file is evaluated against; `quietForMs` is null when the screen hasn't been watched long enough to know. */
export type EvaluateInput = { title: string; lines: string[]; quietForMs: number | null }

export type Evaluation = { verdict: Verdict | null; pendingQuiet?: string }

export type LineMatch = { line: string; match: string; groups: string[] }
