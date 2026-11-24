#!/usr/bin/env node

/**
 * Refuses a workstation vitest run, from any caller.
 *
 * The `.claude/hooks/require-sandboxed-tests.mjs` guard only sees Bash calls
 * made by a Claude Code session, so any other agent runtime or a plain shell
 * walks straight past it and saturates the machine. This runs as the first
 * step of the `test` script instead, where every caller has to go through it.
 *
 * Allowed through: an explicit `QUIRKY_ALLOW_LOCAL_TESTS=1`, a run already
 * inside a container (the sandbox shards are the point of the rule), and CI.
 */

import { existsSync } from 'node:fs'

const OVERRIDE_ENV = 'QUIRKY_ALLOW_LOCAL_TESTS'

if (process.env[OVERRIDE_ENV] === '1' || isContainer() || process.env.CI) {
  process.exit(0)
}

console.error(
  [
    '',
    'Refusing to run vitest on this workstation.',
    '',
    '  Use the remote sandbox instead:',
    '    pnpm test:sandbox --shards=16 --jobs=8            # full unit suite',
    '    pnpm test:sandbox --shards=16 --only=3            # one shard',
    '    pnpm test:sandbox --shards=16 --only=3 -- <args>  # extra vitest args',
    '',
    `  To override for a single run, export ${OVERRIDE_ENV}=1 first. An inline`,
    `  \`${OVERRIDE_ENV}=1 pnpm test\` prefix works here, but does not reach the`,
    '  Claude Code hook, which will still reject it.',
    ''
  ].join('\n')
)
process.exit(1)

function isContainer() {
  return existsSync('/.dockerenv') || existsSync('/run/.containerenv')
}
