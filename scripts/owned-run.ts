#!/usr/bin/env bun
import { createProcessScope } from './test-support/process-scope'

const command = Bun.argv.slice(2)
if (command[0] === '--') command.shift()
if (command.length === 0) {
  console.error('usage: bun scripts/owned-run.ts -- <command> [args...]')
  process.exit(2)
}

// Never adopt a user's home: every disposable run gets its own private state.
const scope = createProcessScope()
console.error(`QUIRKY_HOME=${scope.home}`)
try {
  const child = scope.spawn(command, {
    env: { ...process.env, ...scope.env, HOME: scope.home },
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit'
  })
  process.exitCode = await child.exited
} finally {
  await scope.cleanup()
}
