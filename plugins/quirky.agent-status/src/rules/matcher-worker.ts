/**
 * Entry point of the matcher process: answers rule evaluations and single-pattern line matches
 * over newline-delimited JSON on stdio. It runs user regexes, so it is a separate process the
 * client can kill when a pattern runs too long; a thread could not be stopped from inside a running regex.
 */
import { isRecord } from '../normalize/shared'
import { readMatcherFrames, type MatcherRequest, type MatcherResponse } from './matcher-protocol'
import { evaluate, findLine } from './match'

function readRequest(value: unknown): MatcherRequest {
  if (!isRecord(value) || typeof value.id !== 'number' || !Number.isSafeInteger(value.id) || value.id <= 0) {
    throw new Error('invalid matcher request')
  }
  if (value.op === 'line' && typeof value.pattern === 'string' && typeof value.ignoreCase === 'boolean' &&
      Array.isArray(value.lines) && value.lines.every(line => typeof line === 'string')) {
    return value as unknown as MatcherRequest
  }
  if (value.op === 'evaluate' && isRecord(value.file) && isRecord(value.input) && isRecord(value.origin)) {
    return value as unknown as MatcherRequest
  }
  throw new Error('invalid matcher request')
}

async function writeFrame(response: MatcherResponse): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>()
  process.stdout.write(`${JSON.stringify(response)}\n`, error => {
    if (error) reject(error)
    else resolve()
  })
  await promise
}

async function run(): Promise<void> {
  await writeFrame({ ready: true })
  for await (const frame of readMatcherFrames(Bun.stdin.stream())) {
    const request = readRequest(frame)
    const result = request.op === 'evaluate'
      ? evaluate(request.file, request.input, request.origin)
      : findLine(request.pattern, request.ignoreCase, request.lines)
    await writeFrame({ id: request.id, result })
  }
}

void run().catch(() => {
  process.exitCode = 1
})
