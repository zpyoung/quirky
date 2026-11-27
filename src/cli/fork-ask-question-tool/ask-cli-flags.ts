import { readFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { getRequiredStringFlag } from '../flags'
import { RuntimeClientError } from '../runtime-client'
import { parsePositiveSafeIntegerText } from '../../shared/timer-delay'
import type { AskValidationError } from '../../shared/fork-ask-question-tool/ask-question-schema'

/**
 * Parses `--timeout-ms`/`--chunk-ms` with the same exact-integer text rule as
 * `orchestration ask` (`getOptionalPositiveIntegerValueFlag`,
 * src/cli/handlers/orchestration.ts:362-381) rather than the looser
 * `Number()`-coercing helper in flags.ts.
 */
export function getOptionalPositiveSafeIntegerFlag(
  flags: Map<string, string | boolean>,
  name: string,
  max: number = Number.MAX_SAFE_INTEGER
): number | undefined {
  if (!flags.has(name)) {
    return undefined
  }
  const raw = flags.get(name)
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new RuntimeClientError('invalid_argument', `Missing value for --${name}.`)
  }
  const value = parsePositiveSafeIntegerText(raw)
  if (value === null) {
    throw new RuntimeClientError(
      'invalid_argument',
      `Invalid positive safe integer for --${name}: ${raw}`
    )
  }
  if (value > max) {
    throw new RuntimeClientError('invalid_argument', `--${name} must be at most ${max}.`)
  }
  return value
}

/** Reads `--spec <json|@file>`, resolving a leading `@` against `cwd`. Never returns malformed JSON. */
export function readAskSpecInput(flags: Map<string, string | boolean>, cwd: string): unknown {
  const raw = getRequiredStringFlag(flags, 'spec')
  const jsonText = raw.startsWith('@') ? readAskSpecFile(raw.slice(1), cwd) : raw
  try {
    return JSON.parse(jsonText)
  } catch (error) {
    throw new RuntimeClientError(
      'invalid_argument',
      `Invalid JSON for --spec: ${error instanceof Error ? error.message : String(error)}`
    )
  }
}

function readAskSpecFile(path: string, cwd: string): string {
  const resolved = isAbsolute(path) ? path : join(cwd, path)
  try {
    return readFileSync(resolved, 'utf8')
  } catch (error) {
    throw new RuntimeClientError(
      'invalid_argument',
      `Could not read --spec file at ${resolved}: ${error instanceof Error ? error.message : String(error)}`
    )
  }
}

export function formatAskValidationErrors(errors: readonly AskValidationError[]): string {
  return errors
    .map((error) => (error.path ? `${error.path}: ${error.message}` : error.message))
    .join('; ')
}

/** Pane/worktree attribution the server-side `resolveAskOrigin` (C3) validates before trusting. */
export type AskOriginParams = {
  cwd: string
  paneKey?: string
  terminalHandle?: string
  worktreeId?: string
  workspaceId?: string
}

export function resolveAskOriginParams(cwd: string): AskOriginParams {
  return {
    cwd,
    ...(process.env.QUIRKY_PANE_KEY ? { paneKey: process.env.QUIRKY_PANE_KEY } : {}),
    ...(process.env.QUIRKY_TERMINAL_HANDLE
      ? { terminalHandle: process.env.QUIRKY_TERMINAL_HANDLE }
      : {}),
    ...(process.env.QUIRKY_WORKTREE_ID ? { worktreeId: process.env.QUIRKY_WORKTREE_ID } : {}),
    ...(process.env.QUIRKY_WORKSPACE_ID ? { workspaceId: process.env.QUIRKY_WORKSPACE_ID } : {})
  }
}
