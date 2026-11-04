import type { JournalEntry, StepId } from '../contracts'

const STEP_LABELS: Record<StepId, string> = {
  'floor-core': 'Floor core',
  'floor-switch': 'Switches',
  level: 'Level',
  'fixed-rules': 'Fixed rules',
  judgment: 'Judgment'
}

const MAX_INPUT_LENGTH = 160

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The part of a tool call's input a person recognizes: its command or path, else the input as JSON. */
export function describeToolInput(toolInput: unknown): string {
  if (typeof toolInput === 'string') return toolInput
  if (isRecord(toolInput)) {
    for (const key of ['command', 'file_path', 'path', 'url']) {
      const value = toolInput[key]
      if (typeof value === 'string' && value !== '') return value
    }
  }
  const json = JSON.stringify(toolInput) ?? ''
  return json.length > MAX_INPUT_LENGTH ? `${json.slice(0, MAX_INPUT_LENGTH)}…` : json
}

function requestOf(data: Record<string, unknown>): string {
  const who = typeof data.agent === 'string' && data.agent !== '' ? data.agent : 'The worker'
  const tool = typeof data.toolName === 'string' ? data.toolName : 'a tool'
  const input = data.toolInput === undefined ? '' : describeToolInput(data.toolInput)
  return `${who} wants to run ${tool}${input === '' ? '' : `: ${input}`}`
}

function pathOf(data: Record<string, unknown>): string {
  if (!Array.isArray(data.trace) || data.trace.length === 0) return 'No steps recorded'
  return data.trace
    .filter(isRecord)
    .map((step) => `${STEP_LABELS[step.step as StepId] ?? String(step.step)}: ${String(step.result)}`)
    .join(' → ')
}

/**
 * Explains one gate decision from its journal entry: what was asked, the path it took through the
 * floor, level, rules and judgment, what the decision relied on, and what the judgment saw.
 */
export default function DecisionTrace({ entry }: { entry: JournalEntry }) {
  const { data } = entry
  const reliedOn = typeof data.reliedOn === 'string' && data.reliedOn !== '' ? data.reliedOn : 'Nothing recorded'
  const reason = typeof data.reason === 'string' && data.reason !== '' ? data.reason : null
  const sawExplanation = data.sawWorkerExplanation === true
  return (
    <dl data-avatar-ui="decision-trace">
      <dt>Request</dt>
      <dd>{requestOf(data)}</dd>
      <dt>Path</dt>
      <dd>{pathOf(data)}</dd>
      <dt>Relied on</dt>
      <dd>{reliedOn}</dd>
      <dt>Judgment saw</dt>
      <dd>{sawExplanation ? "The mandate, the command and the worker's explanation." : "The mandate and the command. Not the worker's explanation."}</dd>
      {reason !== null && (
        <>
          <dt>Reason</dt>
          <dd>{reason}</dd>
        </>
      )}
    </dl>
  )
}
