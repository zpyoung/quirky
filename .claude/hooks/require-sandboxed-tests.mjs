#!/usr/bin/env node

/**
 * PreToolUse guard that keeps vitest off this machine.
 *
 * Reads a Bash tool call on stdin and denies it when it would start vitest
 * locally, pointing the caller at `pnpm test:sandbox` instead. The blocked
 * script names are read from package.json rather than hardcoded, so a renamed
 * or newly added vitest script is covered without editing this file.
 *
 * Set QUIRKY_ALLOW_LOCAL_TESTS=1 in the environment (settings.local.json or your
 * shell) to disable the guard. An inline `VAR=1 pnpm test` prefix does not
 * reach this process, and is rejected with that explanation.
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'

const PROJECT_DIR = path.resolve(import.meta.dirname, '../..')
const OVERRIDE_ENV = 'QUIRKY_ALLOW_LOCAL_TESTS'

/** Wrappers that delegate to the real command rather than being one. */
const TRANSPARENT_WRAPPERS = new Set([
  'command',
  'env',
  'exec',
  'ionice',
  'nice',
  'nohup',
  'stdbuf',
  'sudo',
  'time',
  'xargs'
])

/** Wrapper flags that consume the next token, which is otherwise read as the command. */
const WRAPPER_VALUE_FLAGS = new Map([
  ['env', new Set(['-u', '--unset', '-C', '--chdir', '-S', '--split-string'])],
  ['nice', new Set(['-n', '--adjustment'])],
  ['ionice', new Set(['-c', '-n', '-p', '-P', '-u'])],
  ['stdbuf', new Set(['-i', '-o', '-e', '--input', '--output', '--error'])],
  ['sudo', new Set(['-u', '--user', '-g', '--group', '-C', '-p', '-D', '--chdir'])],
  ['xargs', new Set(['-n', '-I', '-P', '-d', '-a', '-E', '-s', '-L'])]
])

const PACKAGE_MANAGERS = new Set(['bun', 'npm', 'pnpm', 'yarn'])
const RUNNER_SUBCOMMANDS = new Set(['dlx', 'exec', 'run', 'run-script', 'x'])
const DIRECT_RUNNERS = new Set(['bunx', 'npx', 'pnpx'])

main()

function main() {
  if (process.env[OVERRIDE_ENV] === '1') {
    process.exit(0)
  }

  const payload = readPayload()
  const command = payload?.tool_input?.command
  if (typeof command !== 'string' || command.trim() === '') {
    process.exit(0)
  }

  const offence = findLocalVitestRun(command)
  if (!offence) {
    process.exit(0)
  }

  deny(offence)
}

function readPayload() {
  try {
    return JSON.parse(readFileSync(0, 'utf8'))
  } catch {
    return null
  }
}

/** Script names in package.json whose body starts vitest. */
function vitestScriptNames() {
  try {
    const manifest = JSON.parse(readFileSync(path.join(PROJECT_DIR, 'package.json'), 'utf8'))
    return new Set(
      Object.entries(manifest.scripts ?? {})
        .filter(([, body]) => typeof body === 'string' && /(^|[\s/])vitest\b/.test(body))
        .map(([name]) => name)
    )
  } catch {
    return new Set(['test'])
  }
}

function findLocalVitestRun(command) {
  const scripts = vitestScriptNames()
  for (const segment of splitSegments(command)) {
    const offence = inspectSegment(segment, scripts)
    if (offence) {
      return offence
    }
  }
  return null
}

/**
 * Splits on shell operators while ignoring ones inside quotes, so a quoted
 * `--reporter="a;b"` cannot manufacture a segment boundary.
 */
function splitSegments(command) {
  const segments = []
  let current = ''
  let quote = null
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index]
    if (quote) {
      if (character === quote) {
        quote = null
      }
      current += character
      continue
    }
    if (character === "'" || character === '"') {
      quote = character
      current += character
      continue
    }
    if (character === ';' || character === '\n' || character === '&' || character === '|') {
      segments.push(current)
      current = ''
      continue
    }
    current += character
  }
  segments.push(current)
  return segments.map((segment) => segment.trim()).filter(Boolean)
}

function inspectSegment(segment, scripts) {
  const tokens = tokenize(segment)
  const inlineOverride = tokens.find((token) => token.startsWith(`${OVERRIDE_ENV}=`))
  const words = stripLeadingAssignments(tokens)
  if (words.length === 0) {
    return null
  }

  const head = unwrap(words)
  if (head.length === 0) {
    return null
  }

  const name = path.basename(head[0])

  if (name === 'vitest') {
    return { reason: 'invokes the vitest binary directly', segment, inlineOverride }
  }

  if (
    DIRECT_RUNNERS.has(name) &&
    head.slice(1).some((token) => path.basename(token) === 'vitest')
  ) {
    return { reason: `runs vitest through ${name}`, segment, inlineOverride }
  }

  if (PACKAGE_MANAGERS.has(name)) {
    const rest = head.slice(1).filter((token) => !RUNNER_SUBCOMMANDS.has(token))
    if (rest.some((token) => path.basename(token) === 'vitest')) {
      return { reason: `runs vitest through ${name}`, segment, inlineOverride }
    }
    const script = rest.find((token) => scripts.has(token))
    if (script) {
      return { reason: `runs the "${script}" script, which starts vitest`, segment, inlineOverride }
    }
  }

  return null
}

function tokenize(segment) {
  return segment.split(/\s+/).filter(Boolean)
}

function stripLeadingAssignments(tokens) {
  let index = 0
  while (index < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index])) {
    index += 1
  }
  return tokens.slice(index)
}

/** Drops a wrapper's own flags, consuming the operand of any flag that takes one. */
function dropFlags(tokens, valueFlags) {
  let index = 0
  while (index < tokens.length && tokens[index].startsWith('-')) {
    const flag = tokens[index]
    if (flag === '--') {
      index += 1
      break
    }
    index += 1
    if (valueFlags?.has(flag) && !flag.includes('=')) {
      index += 1
    }
  }
  return tokens.slice(index)
}

/** Peels wrappers like `sudo`/`env`/`time` until the real command is in front. */
function unwrap(words) {
  let current = words
  for (let depth = 0; depth < 8; depth += 1) {
    const name = path.basename(current[0] ?? '')
    if (!TRANSPARENT_WRAPPERS.has(name)) {
      return current
    }
    const rest = stripLeadingAssignments(dropFlags(current.slice(1), WRAPPER_VALUE_FLAGS.get(name)))
    if (rest.length === 0) {
      return current
    }
    current = rest
  }
  return current
}

function deny(offence) {
  const lines = [
    `This command ${offence.reason}, and tests for this repo run on the remote Docker host, never on this machine.`,
    '',
    'Use the sandbox runner instead:',
    '  pnpm test:sandbox --shards=16 --jobs=8            # full unit suite',
    '  pnpm test:sandbox --shards=16 --only=3            # one shard',
    '  pnpm test:sandbox --shards=16 --only=3 -- <args>  # extra vitest args',
    '',
    'The host comes from QUIRKY_SANDBOX_DOCKER_HOST, so no --docker-host flag is needed.',
    'Per-shard logs land in .quirky-sandbox-logs/.'
  ]

  if (offence.inlineOverride) {
    lines.push(
      '',
      `An inline ${OVERRIDE_ENV}= prefix does not reach this guard — it only sets the`,
      'variable for the command being launched. Ask the user to set it in the environment.'
    )
  }

  process.stdout.write(
    `${JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: lines.join('\n')
      }
    })}\n`
  )
  process.exit(0)
}
