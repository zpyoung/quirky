import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createCodexAppServerFixture } from '../../plugins/quirky.structured/test/fakes/codex-app-server'

export type GoalLoopFixtureFaults = {
  missingAgent?: boolean
  malformedProvider?: boolean
  failedStartup?: boolean
}

export type GoalLoopFixturePaths = {
  bin: string
  omp: string
  codex: string
  codexFixture: string
  agy: string
  security: string
  orca: string
  shell: string
  codexLog: string
  codexEnvironmentLog: string
  ompLog: string
  ompInputLog: string
  agyLog: string
  securityLog: string
  orcaLog: string
  egressLog: string
  networkPreload: string
  askSpec: string
  worktreesRoot: string
  failedDaemonEntry: string
}

const CODEX_QUOTA_RESPONSE = {
  primary: { usedPercent: 31, windowDurationMins: 300, resetsAt: 1_893_456_000 },
  secondary: { usedPercent: 12, windowDurationMins: 10_080, resetsAt: 1_893_456_000 },
  rateLimitResetCredits: { availableCount: 1 }
}

const AGY_USAGE_RESPONSE = {
  status: 'SUCCESS',
  command: {
    name: 'usage',
    data: {
      groups: [{
        name: 'Gemini Models',
        buckets: [
          { id: 'gemini-weekly', name: 'Weekly Limit Remaining', window: 'weekly', remaining_fraction: 0.4, reset_time: '2030-01-01T00:00:00.000Z' },
          { id: 'gemini-5h', name: '5 Hour Limit', window: '5h', remaining_fraction: 0.75, reset_time: '2030-01-01T00:00:00.000Z' }
        ]
      }]
    }
  }
}

function executable(path: string, content: string): void {
  writeFileSync(path, content, { mode: 0o700 })
  chmodSync(path, 0o700)
}

function privateEmptyFile(path: string): void {
  writeFileSync(path, '', { mode: 0o600 })
}

export function installGoalLoopFixtures(home: string, faults: GoalLoopFixtureFaults = {}): GoalLoopFixturePaths {
  const root = resolve(home)
  const fixtures = join(root, 'fixtures')
  const bin = join(fixtures, 'bin')
  const logs = join(fixtures, 'logs')
  const codexHome = join(fixtures, 'codex')
  const omp = join(bin, 'omp')
  const codex = join(bin, 'codex')
  const agy = join(bin, 'agy')
  const security = join(bin, 'security')
  const orca = join(bin, 'orca')
  const shell = join(bin, 'goal-loop-login-shell')
  const codexLog = join(logs, 'codex-app-server.jsonl')
  const codexEnvironmentLog = join(logs, 'codex-app-server-environments.jsonl')
  const ompLog = join(logs, 'omp-argv.jsonl')
  const ompInputLog = join(logs, 'omp-input.jsonl')
  const agyLog = join(logs, 'agy-argv.jsonl')
  const securityLog = join(logs, 'security.log')
  const orcaLog = join(logs, 'orca.log')
  const egressLog = join(logs, 'egress.log')
  const networkPreload = join(fixtures, 'deny-network.cjs')
  const askSpec = join(fixtures, 'ask-confirm.json')
  const worktreesRoot = join(root, 'worktrees')
  const failedDaemonEntry = join(fixtures, 'failed-daemon.ts')

  for (const directory of [bin, logs, codexHome, join(root, 'codex'), join(root, 'claude'), join(root, 'gemini'), join(root, 'agy'), worktreesRoot]) {
    mkdirSync(directory, { recursive: true, mode: 0o700 })
  }
  for (const path of [codexLog, codexEnvironmentLog, ompLog, ompInputLog, agyLog, securityLog, orcaLog, egressLog]) privateEmptyFile(path)
  writeFileSync(askSpec, `${JSON.stringify({ questions: [{ id: 'continue', type: 'confirm', question: 'Continue fixture?' }] })}\n`, { mode: 0o600 })
  writeFileSync(join(root, 'codex', 'auth.json'), '{"tokens":{"access_token":"fixture-token-not-a-credential","account_id":"fixture-account"}}\n', { mode: 0o600 })
  writeFileSync(failedDaemonEntry, "process.stderr.write('injected fixture daemon startup failure\\n')\nprocess.exit(78)\n", { mode: 0o600 })

  if (!faults.missingAgent) {
    executable(omp, `#!${process.execPath}
const fs = require('node:fs')
require(${JSON.stringify(networkPreload)})
const argvLog = ${JSON.stringify(ompLog)}
const inputLog = ${JSON.stringify(ompInputLog)}
const argv = process.argv.slice(2)
const sessionId = process.env.QUIRKY_SESSION_ID || ''
const promptIndex = argv.indexOf('--prompt')
const prompt = promptIndex >= 0 ? (argv[promptIndex + 1] || '') : [...argv].reverse().find((argument) => !argument.startsWith('-')) || ''
fs.appendFileSync(argvLog, JSON.stringify({ sessionId, argv, prompt }) + '\\n')
process.stdout.write('PROMPT:' + prompt + ':' + sessionId + '\\n')
let input = ''
function accept(rawLine) {
  const pasteStart = '\\x1b[200~'
  const pasteEnd = '\\x1b[201~'
  const line = rawLine.startsWith(pasteStart) && rawLine.endsWith(pasteEnd) ? rawLine.slice(pasteStart.length, -pasteEnd.length) : rawLine
  fs.appendFileSync(inputLog, JSON.stringify({ sessionId, line, rawLine }) + '\\n')
  process.stdout.write('ACK:' + line + '\\n')
}
function receive() {
  for (;;) {
    const index = input.search(/[\\r\\n]/)
    if (index < 0) return
    const separator = input[index]
    const line = input.slice(0, index)
    let consumed = index + 1
    if (separator === '\\r' && input[consumed] === '\\n') consumed += 1
    input = input.slice(consumed)
    accept(line)
  }
}
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => { input += chunk; receive() })
process.stdin.on('end', () => { if (input) accept(input); process.exit(0) })
`)
  }

  executable(codex, `#!/bin/sh
set -eu
if [ "$#" -eq 1 ] && [ "$1" = '--version' ]; then
  printf 'codex-cli 0.120.0\\n'
  exit 0
fi
if [ "$#" -eq 1 ] && [ "$1" = 'app-server' ]; then
  exec "$GOAL_LOOP_CODEX_BUN" "--preload=$GOAL_LOOP_NETWORK_PRELOAD" "$GOAL_LOOP_CODEX_FIXTURE" app-server
fi
if [ "$#" -eq 9 ] && [ "$1" = '-c' ] && [ "$2" = 'approval_policy=never' ] && [ "$3" = '-c' ] && [ "$4" = 'features.plugins=false' ] && [ "$5" = '-s' ] && [ "$6" = 'read-only' ] && [ "$7" = '-a' ] && [ "$8" = 'never' ] && [ "$9" = 'app-server' ]; then
  exec "$GOAL_LOOP_CODEX_BUN" "--preload=$GOAL_LOOP_NETWORK_PRELOAD" "$GOAL_LOOP_CODEX_FIXTURE" app-server
fi
printf '%s\\n' 'codex fixture refuses unsupported arguments' >&2
exit 64
`)

  executable(agy, `#!${process.execPath}
const fs = require('node:fs')
require(${JSON.stringify(networkPreload)})
const log = ${JSON.stringify(agyLog)}
const argv = process.argv.slice(2)
const autoUpdateDisabled = process.env.AGY_CLI_DISABLE_AUTO_UPDATE === 'true'
fs.appendFileSync(log, JSON.stringify({ argv, autoUpdateDisabled }) + '\\n')
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right)
if (!autoUpdateDisabled) {
  process.stderr.write('AGY_CLI_DISABLE_AUTO_UPDATE must be true\\n')
  process.exit(2)
} else if (same(argv, ['--version'])) {
  process.stdout.write('1.1.11\\n')
} else if (same(argv, ['-p', '/usage', '--output-format', 'json', '--print-timeout', '20s'])) {
  process.stdout.write(${JSON.stringify(faults.malformedProvider ? '{malformed-provider' : JSON.stringify(AGY_USAGE_RESPONSE))} + '\\n')
} else {
  process.stderr.write('agy fixture refuses unsupported arguments\\n')
  process.exit(2)
}
`)

  executable(security, `#!/bin/sh
printf '%s\\n' "$*" >> "$QUIRKY_HOME/fixtures/logs/security.log"
exit 44
`)
  executable(orca, `#!/bin/sh
printf '%s\\n' "$*" >> "$QUIRKY_HOME/fixtures/logs/orca.log"
exit 97
`)
  executable(shell, `#!/bin/sh
while [ "$#" -gt 0 ] && [ "$1" = '-l' ]; do shift; done
exec /bin/sh "$@"
`)

  for (const name of ['claude', 'gemini', 'opencode', 'cursor-agent', 'amp', 'aider', 'copilot', 'goose', 'kiro', 'droid', 'kimi', 'gh', 'glab', 'curl', 'ssh']) {
    executable(join(bin, name), `#!/bin/sh
printf '%s\\n' '${name} fixture refuses external provider or hook resolution' >&2
exit 44
`)
  }

  const codexFixture = createCodexAppServerFixture(codexHome, { uniqueThreads: true, rateLimitsRead: CODEX_QUOTA_RESPONSE })

  return {
    bin,
    omp,
    codex,
    codexFixture: codexFixture.executable,
    agy,
    security,
    orca,
    shell,
    codexLog: codexFixture.logPath,
    codexEnvironmentLog: codexFixture.environmentLogPath,
    ompLog,
    ompInputLog,
    agyLog,
    securityLog,
    orcaLog,
    egressLog,
    networkPreload,
    askSpec,
    worktreesRoot,
    failedDaemonEntry
  }
}
