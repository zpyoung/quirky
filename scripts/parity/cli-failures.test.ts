import { expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { delimiter, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { createCliEnvironment } from './cli-world'
import { installCliFixtureTools } from './cli-fixtures'
import { parseActorReceipt, quotePosixShellLiteral } from './cli-actor'
import * as runner from './cli-run'
import type { CliTableRow } from './cli-table'
import * as probes from './cli-checks'
import { captureCliChild } from './cli-world'

import { createProcessScope } from '../test-support/process-scope'
import { createIsolatedRuntimeEnvironment } from '../ui-review/fixtures'
import type { CliParityReport, CliReceipt } from './cli-run'

const repoRoot = resolve(import.meta.dir, '../..')

function withHome(run: (home: string) => void): void {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'quirky-cli-world-')))
  try {
    run(home)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}

test('owned CLI environment ignores poisoned parent identity, provider, proxy and Git settings', () => {
  withHome((home) => {
    const tools = installCliFixtureTools(home)
    const poisoned: Record<string, string> = {
      HOME: '/poison/home',
      QUIRKY_HOME: '/poison/quirky',
      XDG_CONFIG_HOME: '/poison/config',
      CODEX_HOME: '/poison/codex',
      CLAUDE_CONFIG_DIR: '/poison/claude',
      QUIRKY_RUNTIME: 'paired',
      QUIRKY_PAIRING: '/poison/pairing',
      QUIRKY_SESSION_ID: 'poison-session',
      QUIRKY_SESSION_TOKEN: 'poison-token',
      QUIRKY_WORKTREE_ID: 'poison-worktree',
      HTTP_PROXY: 'http://proxy.invalid:8118',
      HTTPS_PROXY: 'http://proxy.invalid:8118',
      ALL_PROXY: 'socks5://proxy.invalid:1080',
      GIT_DIR: '/poison/git',
      GIT_WORK_TREE: '/poison/worktree',
      GIT_CONFIG_GLOBAL: '/poison/gitconfig',
      GIT_CONFIG_PARAMETERS: 'credential.helper=poison',
      PATH: '/poison/bin',
      NODE_OPTIONS: '--require=/poison/preload.cjs'
    }
    const previous = new Map(Object.keys(poisoned).map((key) => [key, process.env[key]]))
    try {
      Object.assign(process.env, poisoned)
      const env = createCliEnvironment(home, repoRoot, tools.fixtureBin, tools.fetchPreload)
      expect(env.HOME).toBe(home)
      expect(env.QUIRKY_HOME).toBe(home)
      expect(env.XDG_CONFIG_HOME).toBe(join(home, 'config'))
      expect(env.CODEX_HOME).toBe(join(home, 'codex'))
      expect(env.SHELL).toBe(tools.shell)
      expect(env.QUIRKY_AGENT_SEARCH_DIRS).toBe('')
      expect(env.QUIRKY_CLI_ENTRY).toBe(join(repoRoot, 'packages/cli/src/main.ts'))
      expect(env.PATH?.split(delimiter)).toEqual([
        tools.fixtureBin,
        '/usr/bin', '/bin', '/usr/sbin', '/sbin'
      ])
      expect(env.NODE_OPTIONS).toContain(tools.fetchPreload)
      for (const key of [
        'QUIRKY_RUNTIME', 'QUIRKY_PAIRING', 'QUIRKY_SESSION_ID', 'QUIRKY_SESSION_TOKEN',
        'QUIRKY_WORKTREE_ID', 'CLAUDE_CONFIG_DIR', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY',
        'GIT_DIR', 'GIT_WORK_TREE'
      ]) expect(env[key]).toBeUndefined()
      expect(env.GIT_CONFIG_GLOBAL).toBe('/dev/null')
      expect(env.GIT_CONFIG_PARAMETERS).toBe('')
      expect(env).not.toHaveProperty('ANTHROPIC_API_KEY')
      expect(env).not.toHaveProperty('OPENAI_API_KEY')
      expect(env).not.toHaveProperty('CODEX_API_KEY')
    } finally {
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  })
})

test('owned wrappers deny real providers and login profiles while preserving fixture behavior', () => {
  withHome((home) => {
    const tools = installCliFixtureTools(home)
    const env = createCliEnvironment(home, repoRoot, tools.fixtureBin, tools.fetchPreload)
    const version = spawnSync(tools.codexWrapper, ['--version'], { env, encoding: 'utf8', timeout: 3_000 })
    expect(version.error).toBeUndefined()
    expect(version.status).toBe(0)
    expect(version.stdout).toBe('codex-cli 0.120.0\n')
    const deniedCodex = spawnSync(tools.codexWrapper, ['login'], { env, encoding: 'utf8', timeout: 3_000 })
    expect(deniedCodex.status).not.toBe(0)

    const omp = spawnSync(tools.ompWrapper, ['--prompt', 'cli-parity-prompt'], { env, encoding: 'utf8', timeout: 3_000 })
    expect(omp.error).toBeUndefined()
    expect(omp.status).toBe(0)
    expect(omp.stdout).toContain('PROMPT:cli-parity-prompt')
    expect(readFileSync(tools.ompLog, 'utf8').match(/cli-parity-prompt/g)).toHaveLength(1)

    writeFileSync(join(home, '.profile'), `touch ${join(home, 'login-profile-ran')}\n`)
    const shell = spawnSync(tools.shell, ['-l', '-c', 'printf shell-without-login-profile'], { env, encoding: 'utf8', timeout: 3_000 })
    expect(shell.error).toBeUndefined()
    expect(shell.status).toBe(0)
    expect(shell.stdout).toBe('shell-without-login-profile')
    expect(existsSync(join(home, 'login-profile-ran'))).toBe(false)

    const orca = spawnSync(tools.orcaShim, ['version'], { env, encoding: 'utf8', timeout: 3_000 })
    expect(orca.status).toBe(97)
    expect(readFileSync(tools.orcaLog, 'utf8')).toContain('version')
    const security = spawnSync(tools.securityShim, ['find-generic-password'], { env, encoding: 'utf8', timeout: 3_000 })
    expect(security.status).toBe(44)
    expect(readFileSync(tools.securityLog, 'utf8')).toContain('find-generic-password')

    const egress = spawnSync(process.execPath, [
      '--preload', tools.fetchPreload, '-e',
      'fetch("https://example.invalid/credential-probe").then(() => process.exit(3), (error) => { if (!error.message.includes("non-loopback")) process.exit(4) })'
    ], { env, encoding: 'utf8', timeout: 5_000 })
    expect(egress.error).toBeUndefined()
    expect(egress.status).toBe(0)
    expect(readFileSync(tools.egressLog, 'utf8')).toContain('https://example.invalid/credential-probe')
  })
})

test('POSIX literal quoting keeps dangerous path bytes inert inside the owned root', () => {
  withHome((home) => {
    const touchPath = join(home, 'should-not-exist')
    const value = join(home, `space and 'quote' $(touch ${touchPath}); semicolon`)
    expect(quotePosixShellLiteral(value)).toBe(`'${value.replaceAll("'", `'\\''`)}'`)
    const output = join(home, 'literal.txt')
    const child = spawnSync('/bin/sh', ['-c', `printf '%s' ${quotePosixShellLiteral(value)} > ${quotePosixShellLiteral(output)}`], {
      env: createCliEnvironment(home, repoRoot, join(home, 'bin'), join(home, 'fetch-preload.cjs')), cwd: home, timeout: 2_000
    })
    expect(child.status).toBe(0)
    expect(readFileSync(output, 'utf8')).toBe(value)
    expect(existsSync(touchPath)).toBe(false)
  })
})

test('actor receipt parser preserves raw CLI output and rejects malformed or credential-shaped receipts', () => {
  const receipt = {
    id: 'ask-register',
    argv: ['/absolute/bun', '/checkout/packages/cli/src/main.ts', 'ask', '--runtime', 'local', '--json'],
    exitCode: 0,
    stdout: '{"status":"registered"}\n{"status":"pending"}\n',
    stderr: '',
    stdoutBytes: Buffer.byteLength('{"status":"registered"}\n{"status":"pending"}\n'),
    elapsedMs: 12,
    format: 'jsonl' as const
  }
  expect(parseActorReceipt(JSON.stringify(receipt))).toEqual(receipt)
  expect(() => parseActorReceipt('{ not json')).toThrow()
  expect(() => parseActorReceipt(JSON.stringify({ ...receipt, argv: ['ask', 4] }))).toThrow()
  expect(() => parseActorReceipt(JSON.stringify({ ...receipt, sessionToken: 'must-not-be-published' }))).toThrow()
})
test('ordinary CLI errors and Ask JSONL are not accepted as successful evidence', () => {
  expect(runner.parseCliOutput('{"id":"owned"}', 'json', 0)).toEqual({ id: 'owned' })
  expect(runner.parseCliOutput('{"type":"registered"}\n{"type":"pending"}\n', 'jsonl', 0)).toEqual([{ type: 'registered' }, { type: 'pending' }])
  expect(() => runner.parseCliOutput('{"error":{"message":"fixture refusal"}}', 'json', 1)).toThrow('fixture refusal')
  for (const [stdout, format, code] of [
    ['{', 'json', 0], ['{"ok":true}\n{"ok":true}', 'json', 0],
    ['{"error":"denied"}', 'json', 0], ['{}', 'json', 1],
    ['{}\ninvalid\n', 'jsonl', 0], ['[]\n', 'jsonl', 0], ['', 'jsonl', 0]
  ] as const) expect(() => runner.parseCliOutput(stdout, format, code)).toThrow()
})

test('only proven real receipts upgrade covered rows; declared gaps cannot hide failed work', () => {
  const covered: CliTableRow = { id: 'repo-list', command: 'repo list', provenance: 'orca repo list', equivalent: 'repo list', checks: ['repo-list'], disposition: 'covered', reason: '' }
  const mapped: CliTableRow = { ...covered, id: 'account-rm', command: 'account rm', equivalent: 'accounts remove', disposition: 'mapped-only', checks: [], followUp: 'local' }
  const gap: CliTableRow = { ...covered, id: 'serve', command: 'serve', equivalent: '', disposition: 'gap', checks: [], reason: 'No foreground startup', followUp: 'startup' }
  const receipt: CliReceipt = { id: 'repo-list', command: 'repo list', argv: ['repo', 'list', '--runtime', 'local', '--json'], exitCode: 0, format: 'json', stdoutBytes: 2, elapsedMs: 1, evidence: { path: 'owned' } }
  const refs = new Map([['repo-list', ['repo list']], ['account-rm', ['accounts remove']]])
  expect(runner.reduceCliRows([covered], [], new Set(['repo-list']), refs)[0]!.status).toBe('not-run')
  expect(runner.reduceCliRows([covered], [receipt], new Set(), refs)[0]!.status).toBe('not-run')
  expect(runner.reduceCliRows([covered, mapped, gap], [receipt], new Set(['repo-list']), refs)).toMatchObject([
    { status: 'passed', executed: true }, { status: 'mapped-only', executed: false }, { status: 'gap', executed: false }
  ])
  expect(runner.reduceCliRows([covered, gap], [], new Set(), refs, { checkId: 'repo-list', kind: 'transport', message: 'dead daemon' })).toMatchObject([
    { status: 'failed', executed: false, error: { checkId: 'repo-list' } }, { status: 'gap', executed: false }
  ])
  expect(runner.reduceCliRows([covered], [{ ...receipt, exitCode: 1 }], new Set(), refs, { checkId: 'repo-list', kind: 'cli-exit', message: 'failed child' })).toMatchObject([
    { status: 'failed', executed: true }
  ])
})

test('the public rehearsal accepts no caller-selected runtime, command or filesystem paths', () => {
  expect(runner.parseCliArgs([])).toEqual({ json: false, help: false })
  expect(runner.parseCliArgs(['--json'])).toEqual({ json: true, help: false })
  expect(runner.parseCliArgs(['--help'])).toEqual({ json: false, help: true })
  for (const args of [['--home', '/tmp/borrowed'], ['--runtime', 'remote'], ['--repo', '/tmp/repo'], ['--command', 'touch pwned'], ['--agent-bin', '/bin/sh'], ['--out', '/tmp/out'], ['extra'], ['--unknown'], ['--json', '--json'], ['--help', '--json']]) {
    expect(() => runner.parseCliArgs(args)).toThrow()
  }
})

test('a final report preserves both the original failure and cleanup failure', () => {
  const report = runner.buildCliReport({
    rows: [], receipts: [], proven: new Set(), catalogRefs: new Map(), elapsedMs: 42,
    failure: { checkId: 'terminal-send', kind: 'missing-ack', message: 'No independent ACK' },
    cleanupError: 'Unable to remove owned worktree'
  })
  expect(report).toMatchObject({
    ok: false, parityComplete: false, elapsedMs: 42,
    error: { stage: 'terminal-send', kind: 'missing-ack', message: 'No independent ACK' },
    cleanup: { ok: false, error: 'Unable to remove owned worktree' }
  })
})

test('stdout overflow is rejected rather than truncated into apparently valid evidence', () => {
  expect(() => runner.parseCliOutput(JSON.stringify({ data: 'x'.repeat(16 * 1024 * 1024) }), 'json', 0)).toThrow()
})

for (const fault of ['startup', 'daemon-death', 'sigterm'] as const) {
  test(`owned lifecycle reaps processes after ${fault} without killing a sentinel`, async () => {
    const scope = createProcessScope()
    const env = createIsolatedRuntimeEnvironment(scope.home, { repoRoot })
    env.TZ = 'Pacific/Honolulu'
    mkdirSync(env.TMPDIR!, { recursive: true })
    // A real unrelated process is required to detect overbroad process-group cleanup.
    const sentinel = Bun.spawn([process.execPath, '-e', 'setInterval(() => {}, 1000)'], { env, stdout: 'ignore', stderr: 'ignore' })
    const marker = join(scope.home, 'observed.json')
    const entry = join(scope.home, 'failure-child.ts')
    writeFileSync(entry, `
      import { writeFileSync } from 'node:fs'
      import { main } from ${JSON.stringify(new URL('./cli.ts', import.meta.url).href)}
      let world
      const record = phase => {
        if (world) writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ phase, home: world.home, pids: [world.daemonPid, world.ptyPid].filter(Boolean) }))
      }
      process.exitCode = await main(['--json'], {
        hooks: {
          beforeStart: () => { if (${JSON.stringify(fault)} === 'startup') throw new Error('fixture startup failure') },
          afterReady: value => {
            world = value
            record('ready')
            if (${JSON.stringify(fault)} === 'daemon-death') process.kill(value.daemonPid, 'SIGKILL')
          }
        },
        onActorLive: () => { record('actor-live'); process.kill(process.pid, 'SIGTERM') }
      })
    `)
    try {
      const child = scope.spawn([process.execPath, entry], { cwd: repoRoot, env, stdout: 'pipe', stderr: 'pipe', timeout: 40_000 })
      const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
      expect(exit, stderr + '\n' + stdout).toBe(1)
      const report: CliParityReport = JSON.parse(stdout)
      expect(report).toMatchObject({ ok: false, parityComplete: false, cleanup: { ok: true } })
      expect(report.error).toBeTruthy()
      if (fault === 'startup') expect(report.error?.message).toContain('fixture startup failure')
      expect(report.rows.some(row => row.status === 'not-run')).toBe(true)
      expect(report.elapsedMs).toBeLessThan(40_000)
      if (fault !== 'startup') {
        const observed: { phase: string; home: string; pids: number[] } = JSON.parse(readFileSync(marker, 'utf8'))
        expect(observed.pids.length).toBeGreaterThan(0)
        expect(observed.phase).toBe(fault === 'sigterm' ? 'actor-live' : 'ready')
        if (fault === 'sigterm') expect(report.error?.kind).toBe('interrupted')
        expect(existsSync(observed.home)).toBe(false)
        for (const pid of observed.pids) expect(() => process.kill(pid, 0)).toThrow()
      }
      expect(sentinel.exitCode).toBeNull()
    } finally {
      sentinel.kill('SIGKILL')
      await sentinel.exited
      await scope.cleanup()
    }
  }, 40_000)
}

test('delivery proof rejects terminal echo, missing input and duplicate prompt/input delivery', () => {
  expect(probes.assertOmpPromptEvidence(['omp', 'cli-parity-prompt'], 'PROMPT:cli-parity-prompt', 'cli-parity-prompt')).toBe(1)
  expect(() => probes.assertOmpPromptEvidence([], 'PROMPT:cli-parity-prompt', 'cli-parity-prompt')).toThrow()
  expect(() => probes.assertOmpPromptEvidence(['cli-parity-prompt', 'cli-parity-prompt'], 'PROMPT:cli-parity-prompt', 'cli-parity-prompt')).toThrow()
  expect(() => probes.assertOmpPromptEvidence(['cli-parity-prompt'], 'cli-parity-prompt', 'cli-parity-prompt')).toThrow()
  probes.assertTerminalAckEvidence(['cli-parity-input'], 'ACK:cli-parity-input', 'cli-parity-input')
  for (const [lines, output] of [
    [[], 'ACK:cli-parity-input'],
    [['cli-parity-input', 'cli-parity-input'], 'ACK:cli-parity-input'],
    [['cli-parity-input'], 'cli-parity-input']
  ] as const) expect(() => probes.assertTerminalAckEvidence(lines, output, 'cli-parity-input')).toThrow()
})

test('a cap pause cannot be certified from a completed, wrong-iteration or scheduled loop', () => {
  const cap = { iterationsCompleted: 1, state: 'paused', pauseReason: 'cap-iterations', nextIterationAt: null, pacing: { kind: 'on-idle' }, sessionPolicy: 'fresh' }
  expect(probes.assertLoopCapSnapshot(cap, 1)).toMatchObject(cap)
  for (const bad of [{ ...cap, state: 'completed' }, { ...cap, iterationsCompleted: 2 }, { ...cap, pauseReason: null }, { ...cap, nextIterationAt: 123 }]) {
    expect(() => probes.assertLoopCapSnapshot(bad, 1)).toThrow()
  }
})

test('Ask receipts require a registered/pending pair for one actual ID', () => {
  expect(probes.assertActorAskEnvelope('{"status":"registered","askId":"owned"}\n{"status":"pending","askId":"owned"}\n')).toEqual({ askId: 'owned' })
  for (const output of ['not-json', '{"status":"registered","askId":"owned"}', '{"status":"registered","askId":"owned"}\n{"status":"pending","askId":"other"}\n']) {
    expect(() => probes.assertActorAskEnvelope(output)).toThrow()
  }
})

test('Run identity, file bytes and native automation output require independent exact observations', () => {
  const run = { id: 'owned-run', objective: 'cli-parity-objective', coordinatorSessionId: 'actor' }
  const expected = { runId: run.id, objective: run.objective, sessionId: run.coordinatorSessionId }
  expect(probes.assertActorRunState({ run }, expected)).toMatchObject(run)
  expect(() => probes.assertActorRunState({ run: { ...run, coordinatorSessionId: 'unrelated' } }, expected)).toThrow()
  probes.assertExactUtf8Content('first\nsecond λ\n', 'first\nsecond λ\n', 'file')
  expect(() => probes.assertExactUtf8Content('first\nsecond ?\n', 'first\nsecond λ\n', 'file')).toThrow()
  const automation = { id: 'owned-auto-run', status: 'completed', trigger: 'manual', sessionKind: 'structured', outputSnapshot: { content: 'Codex: cli-parity-auto' } }
  expect(probes.assertAutomationRunEvidence(automation, automation.id, 1)).toMatchObject({ status: 'completed', content: 'Codex: cli-parity-auto', promptCount: 1 })
  for (const bad of [{ ...automation, status: 'failed' }, { ...automation, outputSnapshot: { content: 'wrong' } }, { ...automation, sessionKind: 'terminal' }]) {
    expect(() => probes.assertAutomationRunEvidence(bad, automation.id, 1)).toThrow()
  }
  expect(() => probes.assertAutomationRunEvidence(automation, automation.id, 2)).toThrow()
})

for (const fault of ['deadline', 'overflow'] as const) {
  test(`bounded CLI capture rejects ${fault} and reaps its child`, async () => {
    const scope = createProcessScope()
    const env = createIsolatedRuntimeEnvironment(scope.home, { repoRoot })
    const source = fault === 'overflow'
      ? 'process.stdout.write(Buffer.alloc(16 * 1024 * 1024 + 1, 120)); setInterval(() => {}, 1000)'
      : 'setInterval(() => {}, 1000)'
    const child = scope.spawn([process.execPath, '-e', source], { env, stdout: 'pipe', stderr: 'pipe' })
    try {
      // This deadline exercises real child termination; faking the clock cannot reap an OS process.
      await expect(captureCliChild(child, { timeoutMs: fault === 'deadline' ? 25 : 2_000 })).rejects.toMatchObject({
        kind: fault === 'deadline' ? 'command-timeout' : 'stdout-overflow',
        stdoutBytes: expect.any(Number), elapsedMs: expect.any(Number), exitCode: expect.any(Number)
      })
      expect(await child.exited).not.toBe(0)
      expect(() => process.kill(child.pid, 0)).toThrow()
    } finally { await scope.cleanup() }
  }, 20_000)
}

test('bounded CLI capture drains a large stderr stream without truncating JSON stdout', async () => {
  const scope = createProcessScope()
  const env = createIsolatedRuntimeEnvironment(scope.home, { repoRoot })
  const child = scope.spawn([process.execPath, '-e', 'process.stderr.write(\"x\".repeat(100_000)); process.stdout.write(JSON.stringify({owned:true}))'], { env, stdout: 'pipe', stderr: 'pipe' })
  try {
    const captured = await captureCliChild(child, { timeoutMs: 2_000 })
    expect(captured.exitCode).toBe(0)
    expect(Buffer.byteLength(captured.stderr)).toBeLessThanOrEqual(8 * 1024)
    expect(JSON.parse(captured.stdout)).toEqual({ owned: true })
    expect(captured.stdoutBytes).toBe(Buffer.byteLength(captured.stdout))
  } finally { await scope.cleanup() }
}, 20_000)
