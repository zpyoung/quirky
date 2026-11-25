import type {
  AgentJournalToolCallItem,
  AgentJournalToolCallState
} from '../../../shared/agent-session-journal-types'
import { stripAnsiEscapeSequences } from '../../../shared/ansi-escape-sequences'
import type { AgentJournalTestResultItem } from '../../../shared/agent-session-journal-v1-items'

const TAIL_LINES = 8
const TAIL_CHARS = 800
const COMMAND_CHARS = 2000

const TEST_COMMAND =
  /(?:^|[\s;&|(])(?:(?:npm|pnpm|yarn|bun|make)\s+(?:run\s+)?test(?::[\w-]+)?|bun\s+test|pytest|jest|vitest|go\s+test|cargo\s+test)(?=$|[\s;&|)])/

const EDIT_TOOL_NAMES = new Set([
  'edit',
  'write',
  'multiedit',
  'notebookedit',
  'apply_patch',
  'patch',
  'str_replace_editor'
])

export type TestCounts = { passed?: number; failed?: number; skipped?: number }

/** Whether a shell command runs a test suite. */
export function isTestCommand(command: string): boolean {
  return TEST_COMMAND.test(command)
}

function plainText(output: string): string {
  return stripAnsiEscapeSequences(output)
}

/** Pass, fail and skip counts printed by common test runners; the last mention of each wins. */
export function parseTestCounts(output: string): TestCounts {
  const text = plainText(output)
  const last = (pattern: RegExp): number | undefined => {
    let found: number | undefined
    for (const match of text.matchAll(pattern)) {
      found = Number(match[1])
    }
    return found
  }
  const counts: TestCounts = {}
  const passed = last(/(\d+)\s+(?:passed|pass)\b/gi)
  const failed = last(/(\d+)\s+(?:failed|fail|failures?)\b/gi)
  const skipped = last(/(\d+)\s+(?:skipped|skip|ignored|pending)\b/gi)
  if (passed !== undefined) {
    counts.passed = passed
  }
  if (failed !== undefined) {
    counts.failed = failed
  }
  if (skipped !== undefined) {
    counts.skipped = skipped
  }
  return counts
}

/** The last lines of a run's output, at most 8 lines and 800 characters. */
export function tailOf(output: string): string | undefined {
  const trimmed = plainText(output).trimEnd()
  if (!trimmed) {
    return undefined
  }
  const tail = trimmed.split('\n').slice(-TAIL_LINES).join('\n')
  return tail.length > TAIL_CHARS ? tail.slice(-TAIL_CHARS) : tail
}

function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > COMMAND_CHARS ? `${flat.slice(0, COMMAND_CHARS - 1)}…` : flat
}

/** The command a shell tool call ran: the `command` input of Claude `Bash`, Codex command items,
 *  and the ACP and pi shell tools. Null for any other tool, edit tools included. */
export function shellCommandOf(
  call: Pick<AgentJournalToolCallItem, 'name' | 'input'>
): string | null {
  if (EDIT_TOOL_NAMES.has(call.name.toLowerCase()) || call.name.startsWith('mcp__')) {
    return null
  }
  const { input } = call
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return null
  }
  const command = (input as Record<string, unknown>).command
  if (typeof command === 'string') {
    return command.trim() === '' ? null : command
  }
  if (
    Array.isArray(command) &&
    command.length > 0 &&
    command.every((part) => typeof part === 'string')
  ) {
    return command.join(' ')
  }
  return null
}

function stateOf(
  call: Pick<AgentJournalToolCallItem, 'state' | 'exitCode'>,
  counts: TestCounts
): 'passed' | 'failed' {
  const callState: AgentJournalToolCallState = call.state
  if (callState === 'failed') {
    return 'failed'
  }
  if (call.exitCode !== undefined && call.exitCode !== 0) {
    return 'failed'
  }
  return (counts.failed ?? 0) > 0 ? 'failed' : 'passed'
}

/**
 * The `test-result` a shell tool call yields, or null when the call is no test run. A running
 * call yields `running` with no counts; a finished one is `failed` when the call failed, exited
 * non-zero, or its output reports failures. Counts come from the whole output, which only the
 * host holds: clients see a bounded head of it.
 */
export function deriveTestResult(
  call: AgentJournalToolCallItem,
  callId: string
): AgentJournalTestResultItem | null {
  const command = shellCommandOf(call)
  if (command === null || !isTestCommand(command)) {
    return null
  }
  const base = { kind: 'test-result' as const, callId, command: oneLine(command) }
  if (call.state === 'running') {
    return { ...base, state: 'running' }
  }
  const output = call.output?.head ?? ''
  const counts = parseTestCounts(output)
  const tail = tailOf(output)
  return {
    ...base,
    state: stateOf(call, counts),
    ...counts,
    ...(tail === undefined ? {} : { tail })
  }
}
