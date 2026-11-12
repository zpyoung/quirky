import type { Level } from '../contracts'

export type MergeCheck = { name: string; required: boolean; conclusion: string | null }
export type MergeFinding = { id: string; valid: boolean | null; fixed: boolean }
export type MergeThread = { id: string; resolved: boolean }

/**
 * What the merge bar decides on. `sharedGoalOrder` lists the worktrees that must merge before this
 * one (null when it is not in a shared goal) and `mergedIds` the worktrees already merged.
 */
export type MergeInput = {
  level: Level
  checks: MergeCheck[]
  findings: MergeFinding[]
  threads: MergeThread[]
  guessesOpen: number
  headSha: string | null
  reviewedSha: string | null
  checkedSha: string | null
  sharedGoalOrder: string[] | null
  mergedIds: string[]
}

export type StopStep = 'commit' | 'draft-pr' | 'merge' | 'none'

const GREEN = new Set(['success', 'neutral', 'skipped'])

/** The last outward step a level may take: Local stops at a commit, Own branch at a draft PR. */
export function stopAt(level: Level): StopStep {
  if (level === 'local') return 'commit'
  if (level === 'own-branch') return 'draft-pr'
  if (level === 'full') return 'merge'
  return 'none'
}

/**
 * The merge bar (R-31). Ready only at Full, with required checks green, every finding fixed or
 * dismissed, no unresolved thread, no unconfirmed guess, the head, reviewed and checked commits
 * all the same, and every shared-goal predecessor merged. `reasons` names each unmet condition.
 * Takes no free text, so repo or PR wording cannot change the answer.
 */
export function mergeReady(input: MergeInput): { ready: boolean; reasons: string[] } {
  const reasons: string[] = []
  if (input.level !== 'full') reasons.push(`level ${input.level} stops at ${stopAt(input.level)}`)
  if (input.checks.length === 0) reasons.push('no checks have reported on the pull request')

  for (const check of input.checks) {
    if (check.required && !(check.conclusion !== null && GREEN.has(check.conclusion))) {
      reasons.push(`required check ${check.name} is ${check.conclusion ?? 'not finished'}`)
    }
  }
  for (const finding of input.findings) {
    if (finding.valid === null) reasons.push(`finding ${finding.id} is not judged`)
    else if (finding.valid && !finding.fixed) reasons.push(`finding ${finding.id} is valid and not fixed`)
  }
  for (const thread of input.threads) {
    if (!thread.resolved) reasons.push(`thread ${thread.id} is unresolved`)
  }
  if (input.guessesOpen > 0) {
    reasons.push(`${input.guessesOpen} ${input.guessesOpen === 1 ? 'guess is' : 'guesses are'} unconfirmed`)
  }

  const { headSha, reviewedSha, checkedSha } = input
  if (headSha === null || reviewedSha === null || checkedSha === null) {
    reasons.push('the head, reviewed and checked commits are not all known')
  } else if (headSha !== reviewedSha || headSha !== checkedSha) {
    reasons.push(`head ${headSha}, reviewed ${reviewedSha} and checked ${checkedSha} are not the same commit`)
  }

  for (const id of input.sharedGoalOrder ?? []) {
    if (!input.mergedIds.includes(id)) reasons.push(`${id} must merge first`)
  }
  return { ready: reasons.length === 0, reasons }
}

/** The worktrees ahead of `worktreeId` in a shared goal's merge order; empty when it is not listed. */
export function predecessorsOf(order: string[], worktreeId: string): string[] {
  const index = order.indexOf(worktreeId)
  return index < 0 ? [] : order.slice(0, index)
}

/**
 * Whether a failed required check looks flaky: it passed before on the same commit, or its failure
 * output names no file in the diff. Unknown output (`null`) is not treated as flaky.
 */
export function looksFlaky(input: { passedBeforeOnSha: boolean; failureOutput: string | null; diffFiles: string[] }): boolean {
  if (input.passedBeforeOnSha) return true
  if (input.failureOutput === null) return false
  const output = input.failureOutput
  return !input.diffFiles.some((file) => output.includes(file))
}

/** A flaky-looking failure gets one rerun on a commit; a second failure goes back to the worker. */
export function nextFlakyStep(input: { looksFlaky: boolean; rerunsOnSha: number }): 'rerun' | 'back-to-worker' {
  return input.looksFlaky && input.rerunsOnSha < 1 ? 'rerun' : 'back-to-worker'
}
