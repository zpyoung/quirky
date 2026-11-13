import { expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { captureCliChild, type CliBoundedChild } from './cli-world'
import { createGoalLoopWorld, type GoalLoopWorld } from './goal-loop-world'
import type { GoalLoopFixtureFaults } from './goal-loop-fixtures'
import { createCodexAppServerFixture } from '../../plugins/quirky.structured/test/fakes/codex-app-server'

type World = GoalLoopWorld

test('a slow guardian bootstrap still supports real CLI operations and owned teardown', async () => {
  const directory = mkdtempSync('/tmp/quirky-guardian-delay-')
  const preload = join(directory, 'delay.cjs')
  // the injected delay must happen in the real bootstrap process, not the test clock
  writeFileSync(preload, 'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 400)\n', { mode: 0o600 })
  const originalSpawn = Bun.spawnSync
  let delayed = false
  let world: GoalLoopWorld | undefined
  let daemonPid: number | undefined
  try {
    Bun.spawnSync = new Proxy(originalSpawn, {
      apply(target, receiver, args: unknown[]) {
        const [command, options] = args
        if (Array.isArray(command) && command[2] === '--bootstrap') {
          delayed = true
          return Reflect.apply(target, receiver, [[command[0], `--preload=${preload}`, ...command.slice(1)], options])
        }
        return Reflect.apply(target, receiver, args)
      }
    })
    world = await createGoalLoopWorld({ deadline: Date.now() + 120_000 })
    await world.start()
    daemonPid = world.daemonPid
    const receipt = await world.cli(['repo', 'add', world.repoPath])
    expect(receipt.exitCode, receipt.stderr + receipt.stdout).toBe(0)
    expect(JSON.parse(receipt.stdout)).toMatchObject({ kind: 'git', path: world.repoPath })
    expect(delayed).toBe(true)
  } finally {
    Bun.spawnSync = originalSpawn
    if (world) {
      await world.cleanup()
      expect(existsSync(world.root)).toBe(false)
    }
    if (daemonPid) {
      const pid = daemonPid
      expect(() => process.kill(pid, 0)).toThrow()
    }
    rmSync(directory, { recursive: true, force: true })
  }
}, 45_000)

test('owned provider and OMP fixtures enforce their exact contracts', async () => {
  const world = await createGoalLoopWorld()
  try {
    const run = async (argv: string[], input?: string, env = world.env) => {
      const child = world.scope.spawn(argv, {
        cwd: world.root,
        env,
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe'
      })
      if (input !== undefined) {
        child.stdin.write(input)
        child.stdin.end()
      }
      return captureCliChild(child as unknown as CliBoundedChild, { timeoutMs: 3_000 })
    }

    const version = await run([world.paths.agy, '--version'])
    expect(version.exitCode).toBe(0)
    expect(version.stdout).toBe('1.1.11\n')
    expect(version.stderr).toBe('')

    const expectedUsage = {
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
    const usage = await run([world.paths.agy, '-p', '/usage', '--output-format', 'json', '--print-timeout', '20s'])
    expect(usage.exitCode).toBe(0)
    expect(usage.stdout).toBe(`${JSON.stringify(expectedUsage)}\n`)
    expect(usage.stderr).toBe('')

    for (const argv of [
      ['/usage'],
      ['-p', '/usage'],
      ['--version', 'extra'],
      ['-p', '/usage', '--output-format', 'json', '--print-timeout', '21s']
    ]) {
      const refused = await run([world.paths.agy, ...argv])
      expect(refused.exitCode).toBe(2)
    }

    const agyLog = (await world.readLog('agy')).trim().split('\n').map((line) => JSON.parse(line))
    expect(agyLog).toEqual([
      { argv: ['--version'], autoUpdateDisabled: true },
      { argv: ['-p', '/usage', '--output-format', 'json', '--print-timeout', '20s'], autoUpdateDisabled: true },
      { argv: ['/usage'], autoUpdateDisabled: true },
      { argv: ['-p', '/usage'], autoUpdateDisabled: true },
      { argv: ['--version', 'extra'], autoUpdateDisabled: true },
      { argv: ['-p', '/usage', '--output-format', 'json', '--print-timeout', '21s'], autoUpdateDisabled: true }
    ])

    const ompEnv = { ...world.env, QUIRKY_SESSION_ID: 'fixture-session-a' }
    const omp = await run([world.paths.omp, '--prompt', 'fixture-initial-a'], 'fixture-nudge-a\n', ompEnv)
    expect(omp.exitCode).toBe(0)
    expect(omp.stdout).toBe('PROMPT:fixture-initial-a:fixture-session-a\nACK:fixture-nudge-a\n')
    expect(omp.stderr).toBe('')
    expect((await world.readLog('omp')).trim().split('\n').map((line) => JSON.parse(line))).toEqual([
      { sessionId: 'fixture-session-a', argv: ['--prompt', 'fixture-initial-a'], prompt: 'fixture-initial-a' }
    ])
    expect((await world.readLog('omp-input')).trim().split('\n').map((line) => JSON.parse(line))).toEqual([
      { sessionId: 'fixture-session-a', line: 'fixture-nudge-a', rawLine: 'fixture-nudge-a' }
    ])

    const codexVersion = await run([world.paths.codex, '--version'])
    expect(codexVersion.exitCode).toBe(0)
    expect(codexVersion.stdout).toBe('codex-cli 0.120.0\n')
    expect(codexVersion.stderr).toBe('')

    const deniedSecurity = await run([world.paths.security, 'find-generic-password'])
    expect(deniedSecurity.exitCode).toBe(44)
    expect(await world.readLog('security')).toContain('find-generic-password')
  } finally {
    await world.cleanup()
  }
})

test('OMP fixture decodes bracketed paste while retaining the received bytes', async () => {
  const world = await createGoalLoopWorld()
  try {
    const rawLine = '\u001b[200~pasted input\u001b[201~'
    const child = world.scope.spawn([world.paths.omp, '--prompt', 'paste-check'], {
      cwd: world.root,
      env: { ...world.env, QUIRKY_SESSION_ID: 'paste-session' },
      stdin: 'pipe', stdout: 'pipe', stderr: 'pipe'
    })
    child.stdin.write(`${rawLine}\n`)
    child.stdin.end()
    const result = await captureCliChild(child as unknown as CliBoundedChild, { timeoutMs: 3_000 })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('PROMPT:paste-check:paste-session\nACK:pasted input\n')
    expect(JSON.parse((await world.readLog('omp-input')).trim())).toEqual({
      sessionId: 'paste-session', line: 'pasted input', rawLine
    })
  } finally {
    await world.cleanup()
  }
})

test('Codex quota fixture responds only when configured and preserves method-not-found by default', async () => {
  const world = await createGoalLoopWorld()
  try {
    const request = [
      JSON.stringify({ id: 1, method: 'initialize', params: {} }),
      JSON.stringify({ method: 'initialized', params: {} }),
      JSON.stringify({ id: 2, method: 'account/rateLimits/read', params: {} })
    ].join('\n') + '\n'
    const expected = {
      primary: { usedPercent: 31, windowDurationMins: 300, resetsAt: 1_893_456_000 },
      secondary: { usedPercent: 12, windowDurationMins: 10_080, resetsAt: 1_893_456_000 },
      rateLimitResetCredits: { availableCount: 1 }
    }
    const configured = createCodexAppServerFixture(join(world.root, 'fixtures', 'codex-with-quota'), { rateLimitsRead: expected })
    const result = await world.scope.spawn([process.execPath, configured.executable, 'app-server'], {
      cwd: world.root,
      env: world.env,
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe'
    })
    result.stdin.write(request)
    result.stdin.end()
    const captured = await captureCliChild(result as unknown as CliBoundedChild, { timeoutMs: 3_000 })
    expect(captured.exitCode).toBe(0)
    const response = captured.stdout.split('\n').filter(Boolean).map((line) => JSON.parse(line)).find((message) => message.id === 2)
    expect(response).toEqual({ id: 2, result: expected })
    expect(configured.requests().map((entry) => entry.method)).toContain('account/rateLimits/read')

    const defaultFixture = createCodexAppServerFixture(join(world.root, 'fixtures', 'codex-default'))
    const defaultChild = world.scope.spawn([process.execPath, defaultFixture.executable, 'app-server'], {
      cwd: world.root,
      env: world.env,
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe'
    })
    defaultChild.stdin.write(request)
    defaultChild.stdin.end()
    const defaultResult = await captureCliChild(defaultChild as unknown as CliBoundedChild, { timeoutMs: 3_000 })
    const defaultResponse = defaultResult.stdout.split('\n').filter(Boolean).map((line) => JSON.parse(line)).find((message) => message.id === 2)
    expect(defaultResponse).toEqual({ id: 2, error: { code: -32601, message: 'Method not found' } })
  } finally {
    await world.cleanup()
  }
})

test('network preload blocks external fetch and allows loopback fetch', async () => {
  const world = await createGoalLoopWorld()
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: () => new Response('loopback-ok')
  })
  try {
    const run = async (script: string, env = world.env, preloadArgs: string[] = []) => {
      const child = world.scope.spawn([process.execPath, ...preloadArgs, '-e', script], {
        cwd: world.root,
        env,
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe'
      })
      return captureCliChild(child as unknown as CliBoundedChild, { timeoutMs: 3_000 })
    }

    const upstreamStub = join(world.root, 'fetch-upstream-stub.cjs')
    writeFileSync(upstreamStub, `globalThis.fetch = async () => { throw new Error('upstream fetch reached') }
require(${JSON.stringify(world.paths.networkPreload)})
`, { mode: 0o600 })
    const directEnv = { ...world.env }
    delete directEnv.NODE_OPTIONS
    const external = await run(`if (!globalThis[Symbol.for('quirky.goal-loop.fetch-guard')]) process.exit(10); fetch('https://example.invalid/path').then(() => process.exit(9), error => { if (!String(error).includes('non-loopback fetch refused')) process.exit(8); process.stdout.write('blocked') })`, directEnv, [`--preload=${upstreamStub}`])
    expect(external.exitCode).toBe(0)
    expect(external.stdout).toBe('blocked')
    expect(await world.readLog('egress')).toBe('https://example.invalid/path\n')

    const lookalike = await run(`fetch('http://127.example.invalid/path').then(() => process.exit(9), error => { if (!String(error).includes('non-loopback fetch refused')) process.exit(8); process.stdout.write('blocked') })`, directEnv, [`--preload=${upstreamStub}`])
    expect(lookalike.exitCode).toBe(0)
    expect(lookalike.stdout).toBe('blocked')
    expect(await world.readLog('egress')).toBe('https://example.invalid/path\nhttp://127.example.invalid/path\n')
    const preload = await run(`if (!globalThis[Symbol.for('quirky.goal-loop.fetch-guard')]) process.exit(8); process.stdout.write('preloaded')`)
    expect(preload.exitCode).toBe(0)
    expect(preload.stdout).toBe('preloaded')

    const local = await run(`fetch('http://127.0.0.1:${server.port}/').then(async response => process.stdout.write(await response.text()), () => process.exit(7))`)
    expect(local.exitCode).toBe(0)
    expect(local.stdout).toBe('loopback-ok')
    expect(await world.readLog('egress')).toBe('https://example.invalid/path\nhttp://127.example.invalid/path\n')
  } finally {
    server.stop(true)
    await world.cleanup()
  }
})

test('network preload never follows a native loopback redirect', async () => {
  const world = await createGoalLoopWorld()
  let targetRequests = 0
  const target = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: () => {
      targetRequests += 1
      return new Response('redirect-target')
    }
  })
  const source = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: () => Response.redirect(`http://127.0.0.1:${target.port}/target`, 302)
  })
  try {
    const run = async (script: string) => {
      const child = world.scope.spawn([process.execPath, '-e', script], {
        cwd: world.root,
        env: world.env,
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe'
      })
      return captureCliChild(child as unknown as CliBoundedChild, { timeoutMs: 3_000 })
    }
    const sourceUrl = `http://127.0.0.1:${source.port}/redirect`
    const guarded = await run(`fetch(${JSON.stringify(sourceUrl)}).then(response => process.stdout.write(String(response.status)), () => process.exit(7))`)
    expect(guarded.exitCode).toBe(0)
    expect(guarded.stdout).toBe('302')
    expect(targetRequests).toBe(0)

    const explicitFollow = await run(`fetch(${JSON.stringify(sourceUrl)}, { redirect: 'follow' }).then(response => process.stdout.write(String(response.status)), () => process.exit(7))`)
    expect(explicitFollow.exitCode).toBe(0)
    expect(explicitFollow.stdout).toBe('302')
    expect(targetRequests).toBe(0)
  } finally {
    source.stop(true)
    target.stop(true)
    await world.cleanup()
  }
})

test('world isolates inherited selectors, owns a local repository, and starts local provider adapters', async () => {
  const keys = [
    'TMPDIR', 'QUIRKY_HOME', 'HOME', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'QUIRKY_RUNTIME', 'QUIRKY_PAIRING',
    'QUIRKY_PAIRING_CODE', 'QUIRKY_SESSION_ID', 'QUIRKY_SESSION_TOKEN', 'HTTP_PROXY', 'HTTPS_PROXY',
    'ALL_PROXY', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM', 'GIT_DIR', 'GIT_WORK_TREE'
  ]
  const previous = new Map(keys.map((key) => [key, process.env[key]]))
  for (const key of keys) process.env[key] = `poison-${key}`
  let world: World | undefined
  try {
    world = await createGoalLoopWorld()
    expect(world.root).toContain(' ')
    expect(world.root).toContain("'")
    expect(world.root).not.toContain('poison-TMPDIR')
    expect(world.repoPath).toContain("'")
    expect(world.env.HOME).toBe(world.root)
    expect(world.env.QUIRKY_HOME).toBe(world.root)
    expect(world.env.CODEX_HOME).toBe(join(world.root, 'codex'))
    expect(world.env.CLAUDE_CONFIG_DIR).toBe(join(world.root, 'claude'))
    expect(world.env.QUIRKY_RUNTIME).toBeUndefined()
    expect(world.env.QUIRKY_PAIRING).toBeUndefined()
    expect(world.env.QUIRKY_PAIRING_CODE).toBeUndefined()
    expect(world.env.QUIRKY_SESSION_ID).toBeUndefined()
    expect(world.env.QUIRKY_SESSION_TOKEN).toBeUndefined()
    expect(world.env.HTTP_PROXY).toBeUndefined()
    expect(world.env.HTTPS_PROXY).toBeUndefined()
    expect(world.env.GIT_DIR).toBeUndefined()
    expect(world.env.GIT_WORK_TREE).toBeUndefined()
    expect(world.env.PATH).toBe(`${world.paths.bin}:/usr/bin:/bin:/usr/sbin:/sbin`)
    expect(world.env.GIT_CONFIG_GLOBAL).toBe('/dev/null')
    expect(world.env.XDG_CONFIG_HOME).toBe(join(world.root, 'config'))
    expect(world.env.XDG_DATA_HOME).toBe(join(world.root, 'data'))
    expect(world.env.XDG_CACHE_HOME).toBe(join(world.root, 'cache'))
    expect(world.env.XDG_STATE_HOME).toBe(join(world.root, 'state'))
    expect(world.env.XDG_RUNTIME_DIR).toBe(join(world.root, 'runtime'))
    expect(existsSync(join(world.env.CODEX_HOME, 'auth.json'))).toBe(true)
    expect(readFileSync(join(world.env.CODEX_HOME, 'auth.json'), 'utf8')).toBe('{"tokens":{"access_token":"fixture-token-not-a-credential","account_id":"fixture-account"}}\n')
    expect(await world.readLog('orca')).toBe('')

    const pluginNames = [
      'quirky.accounts', 'quirky.agent-status', 'quirky.agents', 'quirky.ask', 'quirky.checks', 'quirky.cli',
      'quirky.loops', 'quirky.repo', 'quirky.session', 'quirky.structured', 'quirky.terminal', 'quirky.worktree'
    ]
    expect(readdirSync(world.env.QUIRKY_BUILTIN_PLUGINS_DIR!).sort()).toEqual(pluginNames)
    expect(readFileSync(join(world.repoPath, '.git', 'HEAD'), 'utf8')).toBe('ref: refs/heads/main\n')

    writeFileSync(join(world.root, '.profile'), 'printf "loaded\\n" >> "$GOAL_LOOP_PROFILE_LOG"\n')
    writeFileSync(join(world.root, '.bash_profile'), 'printf "loaded\\n" >> "$GOAL_LOOP_PROFILE_LOG"\n')
    const shell = world.scope.spawn([world.paths.shell, '-l', '-c', 'printf "clean\\n"'], {
      cwd: world.root,
      env: { ...world.env, GOAL_LOOP_PROFILE_LOG: join(world.root, 'profile-loaded') },
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe'
    })
    const shellResult = await captureCliChild(shell as unknown as CliBoundedChild, { timeoutMs: 3_000 })
    expect(shellResult.exitCode).toBe(0)
    expect(shellResult.stdout).toBe('clean\n')
    expect(existsSync(join(world.root, 'profile-loaded'))).toBe(false)

    await world.start()
    const codex = await world.cli(['accounts', 'refresh', '--provider', 'codex'])
    expect(codex.exitCode).toBe(0)
    const agy = await world.cli(['accounts', 'refresh', '--provider', 'antigravity'])
    expect(agy.exitCode).toBe(0)
    const codexRequests = (await world.readLog('codex')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
    expect(codexRequests.some((entry) => entry.method === 'account/rateLimits/read')).toBe(true)
    const agyInvocations = (await world.readLog('agy')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
    expect(agyInvocations.map((entry) => entry.argv)).toEqual([
      ['--version'],
      ['-p', '/usage', '--output-format', 'json', '--print-timeout', '20s']
    ])
    expect(agyInvocations.every((entry) => entry.autoUpdateDisabled === true)).toBe(true)
    expect(await world.readLog('orca')).toBe('')
    expect(await world.readLog('egress')).toBe('')
  } finally {
    if (world) await world.cleanup()
    for (const key of keys) {
      const value = previous.get(key)
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}, 60_000)

test('fault options stay internal to the fixture module and startup failures clean the owned root', async () => {
  const faults: GoalLoopFixtureFaults = { missingAgent: true, malformedProvider: true, failedStartup: true }
  const world = await createGoalLoopWorld({ faults })
  try {
    expect(existsSync(world.paths.omp)).toBe(false)
    const malformed = world.scope.spawn([world.paths.agy, '-p', '/usage', '--output-format', 'json', '--print-timeout', '20s'], {
      cwd: world.root,
      env: world.env,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe'
    })
    const malformedResult = await captureCliChild(malformed as unknown as CliBoundedChild, { timeoutMs: 3_000 })
    expect(malformedResult.exitCode).toBe(0)
    expect(() => JSON.parse(malformedResult.stdout)).toThrow()
  } finally {
    await world.cleanup()
  }

  const failed = await createGoalLoopWorld({ faults: { failedStartup: true } })
  const root = failed.root
  await expect(failed.start()).rejects.toThrow()
  expect(() => process.kill(failed.daemonPid, 0)).toThrow()
  expect(existsSync(root)).toBe(false)
  await failed.cleanup()
}, 30_000)
