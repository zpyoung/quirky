import { readFileSync, realpathSync, statSync } from 'node:fs'
import { sep } from 'node:path'
import type { AskEnvelope, AskSpec } from '@quirky/protocol'

const MAX_PLAN_FILE_BYTES = 1024 * 1024

/** The plan a version shows: its text, the checked plan file it came from when there is one, and whether it is empty. */
export type PlanText = { text: string; filePath?: string; empty: boolean }

/** The ask a runner creates when Claude asks to leave plan mode: one decision, then optional feedback. */
export function planSpec(): AskSpec {
  return {
    questions: [
      {
        id: 'decision',
        type: 'select',
        question: 'Claude has a plan. How do you want to proceed?',
        required: true,
        options: [
          { value: 'approve-auto', label: 'Approve, auto mode' },
          { value: 'approve-review', label: 'Approve, review edits' },
          { value: 'keep', label: 'Keep planning' }
        ]
      },
      { id: 'reason', type: 'text', question: 'What should Claude change?', required: false }
    ]
  }
}

function realpathOrNull(path: string): string | null {
  try {
    return realpathSync(path)
  } catch {
    return null
  }
}

/** Reads `candidate` only when it is a regular file under 1 MiB whose real path sits inside the plans directory. */
function readPlanFile(candidate: unknown, plansDir: string | null): { text: string; path: string } | null {
  if (typeof candidate !== 'string' || candidate === '' || plansDir === null) return null
  const root = realpathOrNull(plansDir)
  const path = realpathOrNull(candidate)
  if (root === null || path === null || !path.startsWith(root + sep)) return null
  try {
    const stats = statSync(path)
    if (!stats.isFile() || stats.size > MAX_PLAN_FILE_BYTES) return null
    return { text: readFileSync(path, 'utf8'), path }
  } catch {
    return null
  }
}

/**
 * The plan to show for an `ExitPlanMode` request. The input is model output, so every field is checked.
 * The plan file wins because the inline text can be empty or lag a file Claude wrote in the same message;
 * a file that still holds the previous plan yields to a different inline text.
 */
export function planText(input: unknown, lastPlanText: string | null, plansDir: string | null): PlanText {
  const fields = typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {}
  const inline = typeof fields.plan === 'string' ? fields.plan : ''
  const file = readPlanFile(fields.planFilePath, plansDir)
  const filePath = file === null ? {} : { filePath: file.path }
  const fileHasText = file !== null && file.text.trim() !== ''
  const fileIsStale = fileHasText && file.text === lastPlanText && inline.trim() !== '' && inline !== file.text
  const text = fileHasText && !fileIsStale ? file.text : inline
  return text.trim() === '' ? { text: '', ...filePath, empty: true } : { text, ...filePath, empty: false }
}

export type PlanDecision =
  | { decision: 'approve-auto' | 'approve-review' }
  | { decision: 'keep'; message: string }
  | { decision: 'stopped' }

/** The user's answer to a plan ask, failing closed: only an answered approve exit approves. */
export function planDecision(envelope: AskEnvelope | null): PlanDecision {
  const readable = envelope?.status === 'answered' || envelope?.status === 'partial' ? envelope : null
  const answer = readable?.answers.decision
  const value = answer && 'value' in answer ? answer.value : undefined
  if (value === 'approve-auto' || value === 'approve-review') return { decision: value }
  if (value !== 'keep') return { decision: 'stopped' }
  const typed = readable?.answers.reason
  const message = typed && 'value' in typed && typeof typed.value === 'string' ? typed.value.trim() : ''
  return { decision: 'keep', message }
}
