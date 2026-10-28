import type { CheckResult } from './types'

export type IterationPromptInput = {
  body: string
  n: number
  maxIterations?: number
  notesPath: string
  newSession: boolean
  previousCheck: CheckResult | null
  steerNotes: string[]
}

const PREAMBLE = (notesPath: string): string =>
  `You are running in an automated background loop. Keep durable notes in ${notesPath}; the user may edit this file. Continue working until the task is finished. When complete, print LOOP_DONE on its own line. If blocked, print LOOP_BLOCKED: <reason> on its own line. If you need a human decision, print LOOP_DECIDE: <question> on its own line. Do not print these markers except to signal the corresponding state.`

function previousCheckOutput(check: CheckResult): string {
  return `${check.stdoutTail}${check.stderrTail ? `${check.stdoutTail ? '\n' : ''}${check.stderrTail}` : ''}`
    .split(/\r?\n/)
    .slice(-40)
    .join('\n')
}

export function buildIterationPrompt(input: IterationPromptInput): string {
  const parts: string[] = []
  if (input.newSession) parts.push(PREAMBLE(input.notesPath))
  parts.push(`This is iteration ${input.n}${input.maxIterations === undefined ? '' : ` of ${input.maxIterations}`}.`)
  if (input.previousCheck && !input.previousCheck.pass) {
    parts.push(`The previous check failed. Its last output:\n${previousCheckOutput(input.previousCheck)}`)
  }
  if (input.steerNotes.length > 0) {
    parts.push(`Notes from the user for this iteration:\n${input.steerNotes.map((note) => `- ${note}`).join('\n')}`)
  }
  parts.push(input.body)
  return parts.join('\n\n')
}
