import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createCodexAppServerFixture } from '../../plugins/quirky.structured/test/fakes/codex-app-server'

export type GoalLoopFixtureFaults = {
  missingAgent?: boolean
  malformedProvider?: boolean
  malformedClaudeUsage?: boolean
  failedStartup?: boolean
  delayedPrompt?: boolean
}

export type GoalLoopFixturePaths = {
  bin: string
  omp: string
  codex: string
  claude: string
  codexFixture: string
  agy: string
  security: string
  orca: string
  shell: string
  codexLog: string
  codexEnvironmentLog: string
  ompLog: string
  ompPromptArgvRelease: string
  ompPromptTerminalRelease: string
  ompInputLog: string
  ompSignalLog: string
  claudeLog: string
  claudeUsageLog: string
  loopCheck: string
  loopCheckLog: string
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
const CLAUDE_ACCESS_TOKEN = 'goal-loop-synthetic-access-token'

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
  const claude = join(bin, 'claude')
  const codexLog = join(logs, 'codex-app-server.jsonl')
  const claudeLog = join(logs, 'claude.jsonl')
  const claudeUsageLog = join(logs, 'claude-usage.jsonl')
  const ompSignalLog = join(logs, 'omp-signal.jsonl')
  const loopCheck = join(fixtures, 'loop-check.cjs')
  const loopCheckLog = join(logs, 'loop-check.jsonl')
  const codexEnvironmentLog = join(logs, 'codex-app-server-environments.jsonl')
  const ompLog = join(logs, 'omp-argv.jsonl')
  const ompInputLog = join(logs, 'omp-input.jsonl')
  const ompPromptArgvRelease = join(logs, 'omp-prompt-argv.release')
  const ompPromptTerminalRelease = join(logs, 'omp-prompt-terminal.release')
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
  for (const path of [codexLog, codexEnvironmentLog, ompLog, ompInputLog, ompSignalLog, claudeLog, claudeUsageLog, loopCheckLog, agyLog, securityLog, orcaLog, egressLog]) privateEmptyFile(path)
  writeFileSync(join(root, 'claude', '.credentials.json'), `${JSON.stringify({ claudeAiOauth: { accessToken: CLAUDE_ACCESS_TOKEN } })}\n`, { mode: 0o600 })
  writeFileSync(askSpec, `${JSON.stringify({ questions: [{ id: 'continue', type: 'confirm', question: 'Continue fixture?' }] })}\n`, { mode: 0o600 })
  writeFileSync(failedDaemonEntry, "process.stderr.write('injected fixture daemon startup failure\\n')\nprocess.exit(78)\n", { mode: 0o600 })
  writeFileSync(join(root, 'codex', 'auth.json'), '{"tokens":{"access_token":"fixture-token-not-a-credential","account_id":"fixture-account"}}\n', { mode: 0o600 })

  if (!faults.missingAgent) {
    executable(omp, `#!${process.execPath}
const fs = require('node:fs')
require(${JSON.stringify(networkPreload)})
const argvLog = ${JSON.stringify(ompLog)}
const inputLog = ${JSON.stringify(ompInputLog)}
const signalLog = ${JSON.stringify(ompSignalLog)}
const argv = process.argv.slice(2)
const sessionId = process.env.QUIRKY_SESSION_ID || ''
const promptIndex = argv.indexOf('--prompt')
const prompt = promptIndex >= 0 ? (argv[promptIndex + 1] || '') : [...argv].reverse().find((argument) => !argument.startsWith('-')) || ''
const delayedPrompt = ${JSON.stringify(faults.delayedPrompt === true)}
function waitForRelease(path, action) {
  const interval = setInterval(() => {
    if (!fs.existsSync(path)) return
    clearInterval(interval)
    action()
  }, 10)
}
function recordPrompt() {
  if (delayedPrompt) {
    waitForRelease(${JSON.stringify(ompPromptArgvRelease)}, () => fs.appendFileSync(argvLog, JSON.stringify({ sessionId, argv, prompt }) + '\\n'))
    waitForRelease(${JSON.stringify(ompPromptTerminalRelease)}, () => process.stdout.write('PROMPT:' + prompt + ':' + sessionId + '\\n'))
  } else {
    fs.appendFileSync(argvLog, JSON.stringify({ sessionId, argv, prompt }) + '\\n')
    process.stdout.write('PROMPT:' + prompt + ':' + sessionId + '\\n')
  }
}
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
process.on('SIGINT', () => {
  fs.appendFileSync(signalLog, JSON.stringify({ sessionId, signal: 'SIGINT' }) + '\\n', { mode: 0o600 })
  process.stdout.write('INTERRUPT:' + sessionId + '\\n')
})
process.stdin.on('data', (chunk) => { input += chunk; receive() })
process.stdin.on('end', () => { if (input) accept(input); process.exit(0) })
recordPrompt()
`)
  }
  executable(claude, `#!${process.execPath}
const fs = require('node:fs')
const { randomUUID } = require('node:crypto')
const log = ${JSON.stringify(claudeLog)}
const argv = process.argv.slice(2)
function refuse(message) {
  fs.writeSync(2, message + '\\n')
  process.exit(64)
}
if (argv.length === 1 && argv[0] === '--version') {
  fs.writeSync(1, '2.1.0\\n')
  process.exit(0)
}
function optionValue(name) {
  const index = argv.indexOf(name)
  return index < 0 ? undefined : argv[index + 1]
}
if (argv.includes('--print') || argv.includes('-p') ||
    optionValue('--input-format') !== 'stream-json' || optionValue('--output-format') !== 'stream-json') {
  refuse('claude fixture only supports stream-json SDK mode')
}
const sessionId = 'fixture-claude-' + randomUUID()
let initialized = false
let userSeen = false
let input = ''
function send(message) {
  process.stdout.write(JSON.stringify(message) + '\\n')
}
function fail(message) {
  fs.writeSync(2, message + '\\n')
  process.exit(64)
}
function respond(message) {
  if (!message || typeof message !== 'object' || typeof message.type !== 'string') {
    fail('claude fixture received an invalid stream message')
  }
  if (message.type === 'control_request') {
    const requestId = message.request_id
    const subtype = message.request && message.request.subtype
    if (typeof requestId !== 'string') fail('claude fixture received a control request without an id')
    if (subtype === 'initialize' && !initialized) {
      initialized = true
      send({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response: {} } })
      send({ type: 'system', subtype: 'init', session_id: sessionId, model: 'fixture-claude' })
      return
    }
    if (subtype === 'interrupt' && initialized) {
      send({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response: {} } })
      return
    }
    fail('claude fixture refuses unsupported control request: ' + String(subtype))
  }
  if (message.type !== 'user' || !initialized || userSeen) {
    fail('claude fixture refuses unsupported stream message: ' + message.type)
  }
  const content = message.message && message.message.content
  const prompt = typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.filter((block) => block && block.type === 'text').map((block) => block.text).join('\\n')
      : null
  if (typeof prompt !== 'string') fail('claude fixture received a user message without text')
  userSeen = true
  fs.appendFileSync(log, JSON.stringify({ type: 'user', prompt, sessionId }) + '\\n', { mode: 0o600 })
  send({
    type: 'assistant',
    message: {
      id: 'fixture-message-' + sessionId,
      type: 'message',
      role: 'assistant',
      model: 'fixture-claude',
      content: [{ type: 'text', text: 'CLAUDE_ACK:fixture-claude-loop-tick:' + sessionId }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 }
    },
    parent_tool_use_id: null,
    session_id: sessionId
  })
  send({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: 'fixture result:' + sessionId,
    session_id: sessionId,
    duration_ms: 0,
    duration_api_ms: 0,
    num_turns: 1,
    total_cost_usd: 0,
    usage: { input_tokens: 1, output_tokens: 1 }
  })
}
function receive() {
  for (;;) {
    const index = input.indexOf('\\n')
    if (index < 0) return
    const line = input.slice(0, index)
    input = input.slice(index + 1)
    if (!line) continue
    try { respond(JSON.parse(line)) }
    catch (error) {
      fail(error instanceof Error ? error.message : 'claude fixture could not parse stream input')
    }
  }
}
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => { input += chunk; receive() })
process.stdin.on('end', () => {
  if (input.trim()) {
    try { respond(JSON.parse(input)) }
    catch (error) { fail(error instanceof Error ? error.message : 'claude fixture could not parse final input') }
  }
  process.stdout.end(() => process.exit(0))
})
`)

  writeFileSync(loopCheck, `const fs = require('node:fs')
const log = ${JSON.stringify(loopCheckLog)}
const previous = fs.readFileSync(log, 'utf8').split('\\n').filter(Boolean)
const invocation = previous.length + 1
const exitCode = invocation === 1 ? 1 : invocation === 2 ? 0 : 2
const stdout = invocation <= 2 ? 'fixture-check:' + invocation : 'fixture-check-error:' + invocation
fs.appendFileSync(log, JSON.stringify({ invocation, exitCode, stdout }) + '\\n', { mode: 0o600 })
if (invocation > 2) fs.writeSync(2, 'unexpected fixture invocation ' + invocation + '\\n')
else fs.writeSync(1, stdout + '\\n')
process.exit(exitCode)
`, { mode: 0o600 })


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

  for (const name of ['gemini', 'opencode', 'cursor-agent', 'amp', 'aider', 'copilot', 'goose', 'kiro', 'droid', 'kimi', 'gh', 'glab', 'curl', 'ssh']) {
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
    claude,
    codexFixture: codexFixture.executable,
    agy,
    security,
    orca,
    shell,
    codexLog: codexFixture.logPath,
    codexEnvironmentLog: codexFixture.environmentLogPath,
    ompLog,
    ompInputLog,
    ompSignalLog,
    claudeLog,
    claudeUsageLog,
    loopCheck,
    loopCheckLog,
    agyLog,
    securityLog,
    orcaLog,
    egressLog,
    networkPreload,
    askSpec,
    worktreesRoot,
    failedDaemonEntry,
    ompPromptArgvRelease,
    ompPromptTerminalRelease
  }
}
