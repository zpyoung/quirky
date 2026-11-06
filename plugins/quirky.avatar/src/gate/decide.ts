import type { ActionClass, DecideInput, Level, RuleDecision, StepId, Switches } from '../contracts'
import { commandParts, pushDestinations } from './classify'

type Trace = RuleDecision['trace']
type StepResult = { result: 'pass' | 'allow' | 'deny' | 'held'; note: string; reliedOn?: string }

const ALLOWED_BY_FIXED_RULES: ReadonlySet<ActionClass> = new Set(['read', 'edit-inside', 'test', 'build'])
const DENIED_BY_FIXED_RULES: Partial<Record<ActionClass, string>> = {
  'pipe-to-shell': 'piping a download into a shell is denied',
  'skip-hooks': 'skipping git hooks is denied',
  'agent-config': 'editing agent hook or permission settings is denied'
}

const LEVEL_RANK: Record<Level, number> = { shadow: 0, local: 0, 'own-branch': 1, full: 2 }
const OWN_BRANCH_RANK = LEVEL_RANK['own-branch']
const LEVEL_REQUIREMENT: Partial<Record<ActionClass, { rank: number; what: string }>> = {
  'push-own': { rank: 1, what: 'pushing' },
  'pr-draft': { rank: 1, what: 'opening a draft PR' },
  'push-force': { rank: 1, what: 'force-pushing' },
  'remote-delete': { rank: 1, what: 'deleting a remote branch' },
  'message-people': { rank: 1, what: 'messaging people' },
  'pr-ready': { rank: 2, what: 'marking a PR ready' },
  merge: { rank: 2, what: 'merging' },
  deploy: { rank: 2, what: 'deploying' },
  'push-default': { rank: 3, what: 'pushing to the default branch' }
}

const SWITCH_FOR_CLASS: Partial<Record<ActionClass, keyof Switches>> = {
  'message-people': 'messaging',
  'push-force': 'historyRewrite',
  'remote-delete': 'historyRewrite',
  deploy: 'deploys'
}
const SWITCH_NOUN: Record<keyof Switches, string> = { messaging: 'messaging people', historyRewrite: 'rewriting or deleting remote history', deploys: 'deploying' }

function floorCore(classes: ActionClass[]): StepResult {
  if (classes.includes('credential')) return { result: 'held', note: 'touches a credential path or command' }
  if (classes.includes('edit-outside')) return { result: 'held', note: 'writes outside every handed-off worktree' }
  return { result: 'pass', note: 'no credential access and no write outside the handed-off worktrees' }
}

function floorSwitch(classes: ActionClass[], switches: Switches): StepResult {
  for (const cls of classes) {
    const id = SWITCH_FOR_CLASS[cls]
    if (id !== undefined && switches[id] !== true) return { result: 'held', note: `${SWITCH_NOUN[id]} needs the ${id} switch, which is off` }
  }
  return { result: 'pass', note: 'every switch the call needs is on' }
}


function levelGate(input: DecideInput): StepResult {
  const { classes, level } = input
  const rank = LEVEL_RANK[level]
  if (rank === OWN_BRANCH_RANK && classes.includes('push-own')) {
    const foreign = pushDestinations(input.call, input.ctx).find((dest) => dest !== input.ctx.ownBranch)
    if (foreign !== undefined) return { result: 'deny', note: `pushing to ${foreign}, which is not this hand-off's own branch, is not allowed at level ${level}` }
  }
  const exceeding = classes
    .map((cls) => ({ cls, req: LEVEL_REQUIREMENT[cls] }))
    .filter((item): item is { cls: ActionClass; req: { rank: number; what: string } } => item.req !== undefined && item.req.rank > rank)
    .sort((a, b) => b.req.rank - a.req.rank)
  if (exceeding.length === 0) return { result: 'pass', note: `within level ${level}` }
  const [first] = exceeding
  const note =
    first.cls === 'push-default'
      ? `pushing to the default branch is not allowed at level ${level}; it goes through merge`
      : `${first.req.what} is above this hand-off's level (${level})`
  return { result: 'deny', note }
}

function fixedRules(input: DecideInput): StepResult {
  const { classes, call, ctx } = input
  for (const cls of classes) {
    const reason = DENIED_BY_FIXED_RULES[cls]
    if (reason !== undefined) return { result: 'deny', note: reason, reliedOn: `fixed rule: ${cls}` }
  }
  const denied = commandParts(call, ctx).find((part) => ctx.denyCommands.some((entry) => entry.trim() !== '' && (part === entry.trim() || part.startsWith(`${entry.trim()} `))))
  if (denied !== undefined) return { result: 'deny', note: `command is on the always-denied list: ${denied}`, reliedOn: 'settings: always-denied commands' }
  if (classes.length > 0 && classes.every((cls) => ALLOWED_BY_FIXED_RULES.has(cls))) {
    return { result: 'allow', note: 'reads, edits inside the worktree, tests and builds are allowed', reliedOn: 'fixed rule: reads, edits inside the worktree, tests and builds' }
  }
  return { result: 'pass', note: 'no fixed rule matches' }
}

/**
 * Decides a classified tool call by fixed code rules, without any judgment call.
 *
 * Steps run in the order floor core, floor switches, level, fixed rules and the
 * first one that does not pass wins. When all four pass the outcome is
 * `judgment`, meaning the brain must decide. A level step only ever denies.
 * Only `input.level` and `input.switches` feed the decision; mandate text such
 * as guidelines is ignored. Pure and total: it never throws, and an internal
 * failure comes back as `held` so a broken decision is never an allow.
 */
export function decide(input: DecideInput): RuleDecision {
  try {
    const { classes, switches, level } = input
    const steps: [StepId, () => StepResult][] = [
      ['floor-core', () => floorCore(classes)],
      ['floor-switch', () => floorSwitch(classes, switches)],
      ['level', () => levelGate(input)],
      ['fixed-rules', () => fixedRules(input)]
    ]
    const trace: Trace = []
    for (const [step, evaluate] of steps) {
      const outcome = evaluate()
      trace.push({ step, result: outcome.result, note: outcome.note })
      if (outcome.result === 'pass') continue
      return {
        outcome: outcome.result === 'held' ? 'held' : outcome.result === 'deny' ? 'deny' : 'allow',
        step,
        reason: outcome.note,
        reliedOn: outcome.reliedOn ?? step,
        trace
      }
    }
    return { outcome: 'judgment', step: null, reason: 'no code rule decided', reliedOn: '', trace }
  } catch (error) {
    const note = `could not evaluate the call: ${error instanceof Error ? error.message : String(error)}`
    return { outcome: 'held', step: 'floor-core', reason: note, reliedOn: 'floor-core', trace: [{ step: 'floor-core', result: 'held', note }] }
  }
}
