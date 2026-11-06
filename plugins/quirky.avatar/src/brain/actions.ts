import type { BrainAction } from '../contracts'

export type ParsedActions = { ok: true; actions: BrainAction[] } | { ok: false; error: string }

type Raw = Record<string, unknown>

const DECISIONS = ['allow', 'deny', 'held']
const PATCH_FIELDS = ['goal', 'doneWhen', 'guidelines', 'notes']
const FORBIDDEN_PATCH_FIELDS = ['level', 'switches']
const WORKTREE_ONLY = ['runDoneWhen', 'startReview', 'openPr', 'merge', 'mergeMainIn']

const isRecord = (value: unknown): value is Raw => typeof value === 'object' && value !== null && !Array.isArray(value)
const isString = (value: unknown): value is string => typeof value === 'string'
const isStringList = (value: unknown): value is string[] => Array.isArray(value) && value.every(isString)

function requireStrings(raw: Raw, fields: string[]): string | null {
  for (const field of fields) if (!isString(raw[field])) return `${field} must be a string`
  return null
}

function validatePatch(patch: unknown): string | null {
  if (!isRecord(patch)) return 'patch must be an object'
  for (const key of Object.keys(patch)) {
    if (FORBIDDEN_PATCH_FIELDS.includes(key)) return `patch may not contain ${key}`
    if (!PATCH_FIELDS.includes(key)) return `patch field ${key} is not editable`
  }
  for (const key of ['goal', 'doneWhen', 'notes']) {
    if (patch[key] !== undefined && !isString(patch[key])) return `patch.${key} must be a string`
  }
  if (patch.guidelines !== undefined && !isStringList(patch.guidelines)) return 'patch.guidelines must be a list of strings'
  return null
}

/** Checks one raw object and returns the action rebuilt from its declared fields only, or the reason it is invalid. */
function validate(raw: unknown): BrainAction | string {
  if (!isRecord(raw)) return 'must be an object'
  const type = raw.type
  if (!isString(type)) return 'type must be a string'
  let problem: string | null

  switch (type) {
    case 'judge':
      problem = requireStrings(raw, ['requestId', 'reliedOn', 'reason'])
      if (problem === null && !DECISIONS.includes(raw.decision as string)) problem = `decision must be one of ${DECISIONS.join(', ')}`
      return problem ?? { type, requestId: raw.requestId as string, decision: raw.decision as 'allow', reliedOn: raw.reliedOn as string, reason: raw.reason as string }
    case 'send':
    case 'stepIn':
      problem = requireStrings(raw, ['worktreeId', 'text'])
      return problem ?? { type, worktreeId: raw.worktreeId as string, text: raw.text as string }
    case 'answerAsk':
      problem = requireStrings(raw, ['askId'])
      if (problem === null && !isRecord(raw.answers)) problem = 'answers must be an object'
      return problem ?? { type, askId: raw.askId as string, answers: raw.answers as Raw }
    case 'askUser':
      problem = requireStrings(raw, ['worktreeId', 'blocks'])
      if (problem === null && !Array.isArray(raw.questions)) problem = 'questions must be a list'
      return problem ?? { type, worktreeId: raw.worktreeId as string, questions: raw.questions as unknown[], blocks: raw.blocks as string }
    case 'guess':
      problem = requireStrings(raw, ['worktreeId', 'question', 'choice'])
      if (problem === null && typeof raw.reversible !== 'boolean') problem = 'reversible must be a boolean'
      return problem ?? { type, worktreeId: raw.worktreeId as string, question: raw.question as string, choice: raw.choice as string, reversible: raw.reversible as boolean }
    case 'proposeMandateEdit':
      problem = requireStrings(raw, ['worktreeId', 'why']) ?? validatePatch(raw.patch)
      return problem ?? { type, worktreeId: raw.worktreeId as string, patch: raw.patch as Raw, why: raw.why as string }
    case 'judgeFinding':
      problem = requireStrings(raw, ['worktreeId', 'findingId', 'reason'])
      if (problem === null && typeof raw.valid !== 'boolean') problem = 'valid must be a boolean'
      return problem ?? { type, worktreeId: raw.worktreeId as string, findingId: raw.findingId as string, valid: raw.valid as boolean, reason: raw.reason as string }
    case 'startSession':
    case 'restartWorker':
      problem = requireStrings(raw, ['worktreeId', 'note'])
      return problem ?? { type, worktreeId: raw.worktreeId as string, note: raw.note as string }
    case 'park':
      problem = requireStrings(raw, ['worktreeId', 'story'])
      return problem ?? { type, worktreeId: raw.worktreeId as string, story: raw.story as string }
    case 'splitWorktree':
      problem = requireStrings(raw, ['worktreeId', 'branch', 'goal'])
      return problem ?? { type, worktreeId: raw.worktreeId as string, branch: raw.branch as string, goal: raw.goal as string }
    case 'setMergeOrder':
      problem = requireStrings(raw, ['sharedGoalId'])
      if (problem === null && !isStringList(raw.order)) problem = 'order must be a list of strings'
      return problem ?? { type, sharedGoalId: raw.sharedGoalId as string, order: raw.order as string[] }
    case 'noop':
      problem = requireStrings(raw, ['reason'])
      return problem ?? { type, reason: raw.reason as string }
    default:
      if (WORKTREE_ONLY.includes(type)) {
        problem = requireStrings(raw, ['worktreeId'])
        return problem ?? ({ type, worktreeId: raw.worktreeId } as BrainAction)
      }
      return `unknown action type ${JSON.stringify(type)}`
  }
}

const FENCE = /```json[^\S\n]*\n([\s\S]*?)```/g

/**
 * Reads the brain's reply as one fenced json block holding a `BrainAction[]`. Anything else is an
 * error naming what is wrong, which the caller sends back to the brain once. Each returned action
 * carries only its declared fields, and a mandate edit can never carry `level` or `switches`.
 */
export function parseActions(text: string): ParsedActions {
  const blocks = [...text.matchAll(FENCE)]
  if (blocks.length === 0) return { ok: false, error: 'expected exactly one fenced json block, found none' }
  if (blocks.length > 1) return { ok: false, error: `expected exactly one fenced json block, found ${blocks.length}` }
  let parsed: unknown
  try {
    parsed = JSON.parse(blocks[0]![1]!)
  } catch (error) {
    return { ok: false, error: `the json block is not valid json: ${error instanceof Error ? error.message : String(error)}` }
  }
  if (!Array.isArray(parsed)) return { ok: false, error: 'the json block must be an array of actions' }
  const actions: BrainAction[] = []
  for (const [index, raw] of parsed.entries()) {
    const result = validate(raw)
    if (typeof result === 'string') return { ok: false, error: `actions[${index}]: ${result}` }
    actions.push(result)
  }
  return { ok: true, actions }
}
