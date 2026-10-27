/**
 * Entry point of the matcher process: answers rule evaluations and single-pattern line matches
 * sent over IPC. It runs user regexes, so it is a separate process the client can kill when a
 * pattern runs too long; a thread could not be stopped from inside a running regex.
 */
import { evaluate, findLine } from './match'
import type { EvaluateInput, Origin, RuleFile } from './types'

export type MatcherRequest =
  | { id: number; op: 'evaluate'; file: RuleFile; input: EvaluateInput; origin: Origin }
  | { id: number; op: 'line'; pattern: string; ignoreCase: boolean; lines: string[] }

process.on('message', (request: MatcherRequest) => {
  const result = request.op === 'evaluate' ? evaluate(request.file, request.input, request.origin) : findLine(request.pattern, request.ignoreCase, request.lines)
  process.send?.({ id: request.id, result })
})
process.on('disconnect', () => process.exit(0))
process.send?.({ ready: true })
