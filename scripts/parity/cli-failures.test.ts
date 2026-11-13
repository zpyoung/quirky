import { expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { PassThrough } from 'node:stream'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { delimiter, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { SUPPRESSION_PROMPT } from '../../plugins/quirky.ask/src/core/claude-flags'
import { createCliEnvironment, createCliWorld } from './cli-world'
import { createCliFixtures, installCliFixtureTools } from './cli-fixtures'
import { createActorReceiptStore, parseActorReceipt, quotePosixShellLiteral } from './cli-actor'
import { collectBracketedPaste, parseWorkerPreamble } from './cli-worker-actor'
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

async function withHomeAsync(run: (home: string) => Promise<void>): Promise<void> {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'quirky-cli-world-')))
  try {
    await run(home)
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
      BUN_OPTIONS: '--smol',
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
    const child = spawnSync(process.execPath, [
      '-e',
      `import { createCliEnvironment } from ${JSON.stringify(new URL('./cli-world.ts', import.meta.url).href)}; process.stdout.write(JSON.stringify(createCliEnvironment(${JSON.stringify(home)}, ${JSON.stringify(repoRoot)}, ${JSON.stringify(tools.fixtureBin)}, ${JSON.stringify(tools.fetchPreload)})))`
    ], { env: { ...createIsolatedRuntimeEnvironment(home, { repoRoot }), ...poisoned }, cwd: repoRoot, encoding: 'utf8', timeout: 5_000 })
    expect(child.error).toBeUndefined()
    expect(child.status, child.stderr).toBe(0)
    const env: Record<string, string> = JSON.parse(child.stdout)
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
    expect(env.BUN_OPTIONS).toBe(`--preload=${tools.fetchPreload}`)
    expect(env.NODE_OPTIONS).toBeUndefined()
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
  })
})

test('fixture repository refs and the user-owned Codex hook are exact', async () => {
  await withHomeAsync(async (home) => {
    const tools = installCliFixtureTools(home)
    const env = createCliEnvironment(home, repoRoot, tools.fixtureBin, tools.fetchPreload)
    const run = async (argv: string[], cwd: string) => {
      const result = spawnSync(argv[0]!, argv.slice(1), { cwd, env, encoding: 'utf8', timeout: 5_000 })
      if (result.error) throw result.error
      return { stdout: result.stdout ?? '', stderr: result.stderr ?? '', exitCode: result.status ?? -1 }
    }
    const paths = await createCliFixtures({ home, repoRoot, tools, run })

    const hook = { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo user-owned-hook' }] }] } }
    expect(paths.codexHooksFile).toBe(join(home, 'codex', 'hooks.json'))
    expect(paths.userHookDocument).toBe(JSON.stringify(hook))
    expect(readFileSync(paths.codexHooksFile, 'utf8')).toBe(paths.userHookDocument)

    const branches = await run(['git', 'branch', '--list', 'cli-parity-*'], paths.repository)
    expect(branches.exitCode).toBe(0)
    expect(branches.stdout.trim().split('\n').map((branch) => branch.trim())).toEqual(['cli-parity-both', 'cli-parity-topic'])
    const tags = await run(['git', 'tag', '--list', 'cli-parity-*'], paths.repository)
    expect(tags.exitCode).toBe(0)
    expect(tags.stdout.trim().split('\n')).toEqual(['cli-parity-both', 'cli-parity-v1'])
  })
}, 30_000)

test('provider stand-ins enforce exact login argv and write token-free private credentials', () => {
  withHome((home) => {
    const tools = installCliFixtureTools(home)
    expect(tools.claudeWrapper).toBe(join(tools.fixtureBin, 'claude'))
    expect(tools.claudeLoginLog).toBe(join(home, 'fixtures', 'logs', 'claude-login.log'))
    expect(tools.codexLoginLog).toBe(join(home, 'fixtures', 'logs', 'codex-login.log'))
    const env = createCliEnvironment(home, repoRoot, tools.fixtureBin, tools.fetchPreload)
    const run = (executable: string, args: string[], childEnv = env) =>
      spawnSync(executable, args, { env: childEnv, encoding: 'utf8', timeout: 3_000, input: '' })

    const claudeVersion = run(tools.claudeWrapper, ['--version'])
    expect(claudeVersion.status).toBe(0)
    expect(claudeVersion.stdout).toBe('2.1.80 (Claude Code)\n')
    const claudeDenied = run(tools.claudeWrapper, ['auth', 'login'])
    expect(claudeDenied.status).toBe(64)
    expect(claudeDenied.stderr).toBe('claude fixture refuses unsupported arguments\n')
    const claudeExtra = run(tools.claudeWrapper, ['auth', 'login', '--claudeai', 'extra'])
    expect(claudeExtra.status).toBe(64)
    expect(existsSync(tools.claudeLoginLog)).toBe(true)
    expect(readFileSync(tools.claudeLoginLog, 'utf8')).toBe('')

    const claudeConfig = join(home, 'claude')
    mkdirSync(claudeConfig)
    const claudeLogin = run(tools.claudeWrapper, ['auth', 'login', '--claudeai'], { ...env, CLAUDE_CONFIG_DIR: claudeConfig })
    expect(claudeLogin.status).toBe(0)
    expect(readFileSync(tools.claudeLoginLog, 'utf8')).toBe('login\n')
    const claudeProfile = join(claudeConfig, '.claude.json')
    const claudeCredentials = join(claudeConfig, '.credentials.json')
    expect(JSON.parse(readFileSync(claudeProfile, 'utf8'))).toEqual({
      oauthAccount: { emailAddress: 'claude-parity@example.invalid', organizationName: 'CLI parity fixture' }
    })
    expect(readFileSync(claudeProfile, 'utf8')).not.toMatch(/accessToken|access_token/)
    expect(JSON.parse(readFileSync(claudeCredentials, 'utf8'))).toEqual({
      claudeAiOauth: { refreshToken: 'cli-parity-fixture-refresh' }
    })
    expect(statSync(claudeCredentials).mode & 0o777).toBe(0o600)
    expect(readFileSync(claudeCredentials, 'utf8')).not.toMatch(/accessToken|access_token/)

    const codexVersion = run(tools.codexWrapper, ['--version'])
    expect(codexVersion.status).toBe(0)
    expect(codexVersion.stdout).toBe('codex-cli 0.120.0\n')
    const codexAppServer = run(tools.codexWrapper, ['app-server'])
    expect(codexAppServer.status).toBe(0)
    const codexDenied = run(tools.codexWrapper, ['login'])
    expect(codexDenied.status).toBe(8)
    expect(existsSync(join(home, 'codex', 'auth.json'))).toBe(false)
    expect(readFileSync(tools.codexLoginLog, 'utf8')).toBe('')
    const codexUnsupported = run(tools.codexWrapper, ['login', '--device-auth'])
    expect(codexUnsupported.status).toBe(64)
    expect(codexUnsupported.stderr).toBe('codex fixture refuses unsupported arguments\n')

    writeFileSync(join(home, 'codex', 'config.toml'), 'cli_auth_credentials_store = "file"\n')
    const codexLogin = run(tools.codexWrapper, ['login'])
    expect(codexLogin.status).toBe(0)
    expect(readFileSync(tools.codexLoginLog, 'utf8')).toBe('login\n')
    const codexAuth = join(home, 'codex', 'auth.json')
    expect(JSON.parse(readFileSync(codexAuth, 'utf8'))).toEqual({
      auth_mode: 'chatgpt',
      tokens: {
        id_token: 'header.eyJlbWFpbCI6ImNvZGV4LXBhcml0eUBleGFtcGxlLmludmFsaWQifQ.signature',
        account_id: 'cli-parity-codex-workspace'
      }
    })
    expect(statSync(codexAuth).mode & 0o777).toBe(0o600)
    expect(readFileSync(codexAuth, 'utf8')).not.toMatch(/accessToken|access_token/)
  })
}, 20_000)
test('Claude worker mode accepts only the session-attested default launch argv', () => {
  withHome((home) => {
    const tools = installCliFixtureTools(home)
    const env = createCliEnvironment(home, repoRoot, tools.fixtureBin, tools.fetchPreload)
    const run = (argv: string[], childEnv = env) => spawnSync(tools.claudeWrapper, argv, {
      env: childEnv, cwd: repoRoot, encoding: 'utf8', timeout: 5_000, input: ''
    })
    const json = '{"hooks":{}}'
    const yolo = '--dangerously-skip-permissions'
    const disallowed = '--disallowedTools'
    const appendPrompt = '--append-system-prompt'
    const settings = '--settings'
    const valid = [yolo, disallowed, 'AskUserQuestion', appendPrompt, SUPPRESSION_PROMPT, settings, json]
    const expectedLog = `7 ${yolo} ${disallowed} ${appendPrompt} ${settings}\n`
    const log = tools.claudeWorkerLog
    const refused = [
      [],
      [yolo],
      [yolo, settings, json],
      [...valid, 'extra'],
      ...Array.from({ length: valid.length + 1 }, (_, index) => [...valid.slice(0, index), '--', ...valid.slice(index)]),
      [yolo, appendPrompt, SUPPRESSION_PROMPT, disallowed, 'AskUserQuestion', settings, json],
      [yolo, disallowed, 'Bash', appendPrompt, SUPPRESSION_PROMPT, settings, json],
      [yolo, disallowed, 'AskUserQuestion', appendPrompt, `${SUPPRESSION_PROMPT}.`, settings, json],
      [...valid.slice(0, -1), 'not-json']
    ]

    const noToken = run(valid)
    expect(noToken.status).toBe(64)
    expect(noToken.stderr).toBe('claude fixture refuses unsupported arguments\n')
    expect(readFileSync(log, 'utf8')).toBe('')
    const workerEnv = {
      ...env,
      QUIRKY_SESSION_ID: 'worker-session',
      QUIRKY_SESSION_TOKEN: 'worker-session-token',
      QUIRKY_WORKTREE_ID: 'worker-worktree'
    }
    for (const argv of refused) {
      const result = run(argv, workerEnv)
      expect(result.error).toBeUndefined()
      expect(result.status).toBe(64)
      expect(result.stderr).toBe('claude fixture refuses unsupported arguments\n')
      expect(readFileSync(log, 'utf8')).toBe('')
    }

    const worker = run(valid, workerEnv)
    expect(worker.error).toBeUndefined()
    expect(worker.status).toBe(1)
    expect(worker.stderr).toBe('fixture worker requires a terminal\n')
    expect(worker.stdout).toBe(
      '\x1b[?2004h' +
      '\x1b]0;✳ Claude Code\x07\r\n● Ready.\r\n╭─────────────────────────────────────────────╮\r\n│ >                                           │\r\n╰─────────────────────────────────────────────╯\r\n  ? for shortcuts\r\n'
    )
    expect(readFileSync(log, 'utf8')).toBe(expectedLog)
    expect(readFileSync(tools.egressLog, 'utf8')).toBe('')

    const version = run(['--version'])
    expect(version.status).toBe(0)
    expect(version.stdout).toBe('2.1.80 (Claude Code)\n')
    expect(readFileSync(log, 'utf8')).toBe(expectedLog)
  })
}, 20_000)

test('worker preambles preserve identity across carriage-return terminal transport', () => {
  const text = [
    'Your own Quirky session ID is: session_fixture',
    'Your workspace ID is: worktree_fixture',
    'Your Run ID is: run_fixture',
    'Your Task ID is: task_fixture',
    'Your Dispatch ID is: ctx_fixture',
    '=== TASK ===',
    'cli-parity-worker-hold'
  ].join('\r')
  expect(parseWorkerPreamble(text)).toEqual({
    sessionId: 'session_fixture', worktreeId: 'worktree_fixture', runId: 'run_fixture',
    taskId: 'task_fixture', dispatchId: 'ctx_fixture', mode: 'hold'
  })
})

test('worker paste waits for Enter and preserves delimiters split across stdin chunks', async () => {
  const input = new PassThrough()
  try {
    const result = collectBracketedPaste(input)
    let completed = false
    void result.then(() => { completed = true })
    for (const chunk of ['noise\x1b[20', '0~Your Task\rλ', '\x1b[2', '01', '~']) input.write(chunk)
    await Promise.resolve()
    expect(completed).toBe(false)
    input.write('\r')
    expect(await result).toBe('Your Task\rλ')
  } finally {
    input.destroy()
  }
})

test('worker actor rejects every unsupported argv before creating its receipt root', () => {
  withHome((home) => {
    const tools = installCliFixtureTools(home)
    const env = {
      ...createCliEnvironment(home, repoRoot, tools.fixtureBin, tools.fetchPreload),
      QUIRKY_SESSION_ID: 'worker-session',
      QUIRKY_SESSION_TOKEN: 'worker-session-token',
      QUIRKY_WORKTREE_ID: 'worker-worktree'
    }
    for (const args of [[], ['coordinator', 'extra'], ['other']]) {
      const result = spawnSync(process.execPath, [tools.workerActorEntry, ...args], {
        env, cwd: repoRoot, encoding: 'utf8', timeout: 5_000, input: ''
      })
      expect(result.error).toBeUndefined()
      expect(result.stdout).toBe('')
      expect(result.stderr).toBe('')
      expect(result.status).toBe(2)
      expect(existsSync(tools.workerActorRoot)).toBe(false)
    }
  })
}, 20_000)

test('generic actor receipt stores preserve the private manifest format', () => {
  withHome((home) => {
    const receipt = {
      id: 'workers-run-use',
      argv: [process.execPath, join(repoRoot, 'packages/cli/src/main.ts'), 'orchestration', 'run-use', '--runtime', 'local', '--json'],
      stdout: '{"run":{"id":"run_test"}}',
      stderr: '',
      exitCode: 0,
      stdoutBytes: Buffer.byteLength('{"run":{"id":"run_test"}}'),
      elapsedMs: 1,
      format: 'json' as const
    }
    const directory = join(home, 'cli-worker-actor', 'coordinator')
    const store = createActorReceiptStore(directory)
    store.append(receipt)
    expect(store.read()).toEqual([receipt])
    expect(statSync(join(directory, 'receipt-index.json')).mode & 0o077).toBe(0)
    expect(statSync(join(directory, 'receipts', `${receipt.id}.json`)).mode & 0o077).toBe(0)
  })
})

test('importActorRefusal records refusal outcomes without allowing proof', async () => {
  const outputs = [
    { exitCode: 0, stdout: '{"ok":true}' },
    { exitCode: 2, stdout: '{"error":{"code":"conflict","message":"wrong exit"}}' },
    { exitCode: 1, stdout: 'not an error envelope' },
    { exitCode: 1, stdout: '{"error":{"code":"conflict","message":"consumer_fenced","data":{"reason":"fenced"}}}' },
    { exitCode: 1, stdout: '{"error":{"code":"conflict","message":"non-zero import"}}' }
  ]
  const ids = ['actor-refusal-zero', 'actor-refusal-exit-two', 'actor-refusal-malformed', 'actor-refusal-good', 'actor-import-nonzero']
  const observed: string[] = []
  const report = await runner.runCliParity({
    createWorld: createCliWorld,
    runChecks: async (context) => {
      const entry = context.world.paths.cliEntry
      const actorReceipt = (id: string, index: number) => {
        const output = outputs[index]!
        return {
          id,
          argv: [process.execPath, entry, 'orchestration', 'run-use', '--runtime', 'local', '--json'],
          ...output,
          stderr: '',
          stdoutBytes: Buffer.byteLength(output.stdout),
          elapsedMs: 1,
          format: 'json' as const
        }
      }
      for (const [index, kind] of ['unexpected-success', 'cli-exit', 'malformed-output'].entries()) {
        try {
          context.importActorRefusal(actorReceipt(ids[index]!, index))
          observed.push('returned')
        } catch (error) {
          observed.push(error instanceof runner.CliRunFailure ? error.kind : String(error))
        }
        expect(kind).toBe(observed[index])
      }

      const refusal = context.importActorRefusal(actorReceipt(ids[3]!, 3))
      observed.push(`${refusal.code}:${refusal.message}:${JSON.stringify(refusal.data)}`)
      try {
        context.prove(ids[3]!, {})
      } catch (error) {
        observed.push(error instanceof runner.CliRunFailure ? error.kind : String(error))
      }
      try {
        context.importActor([actorReceipt(ids[4]!, 4)])
      } catch (error) {
        observed.push(error instanceof runner.CliRunFailure ? error.kind : String(error))
      }
    },
    cleanupChecks: async () => {}
  })

  expect(observed).toEqual([
    'unexpected-success',
    'cli-exit',
    'malformed-output',
    'conflict:consumer_fenced:{"reason":"fenced"}',
    'missing-receipt',
    'cli-exit'
  ])
  expect(report.receipts.filter((receipt) => ids.includes(receipt.id)).map((receipt) => receipt.exitCode)).toEqual([0, 2, 1, 1, 1])
}, 90_000)


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
      '-e',
      'fetch("https://example.invalid/credential-probe").then(() => process.exit(3), (error) => { if (!error.message.includes("non-loopback")) process.exit(4) })'
    ], { env, encoding: 'utf8', timeout: 5_000 })
    expect(egress.error).toBeUndefined()
    expect(egress.status).toBe(0)
    expect(readFileSync(tools.egressLog, 'utf8')).toBe('https://example.invalid/credential-probe\n')
  })
})

test('refuse records exact failures and a refusal receipt cannot prove success', async () => {
  const outcomes = [
    { exitCode: 0, stdout: '{"ok":true}' },
    { exitCode: 2, stdout: '{"error":{"code":"not-found","message":"missing"}}' },
    { exitCode: 1, stdout: '{"error":{"code":"not-found"}}' },
    { exitCode: 1, stdout: '{"error":{"code":"not-found","message":"missing"}}\n{"error":{"code":"not-found","message":"missing"}}' },
    { exitCode: 1, stdout: '{"error":{"code":"not-found","message":"missing","reason":"missing","data":{"reason":"missing"},"suggestions":["use an existing selector"]}}' },
    { exitCode: 1, stdout: '{"error":{"code":"conflict","message":"already exists"}}' }
  ]
  const ids = ['refuse-zero', 'refuse-non-one', 'refuse-malformed', 'refuse-multiple', 'refuse-expected', 'refuse-wrong-code']
  const observed: string[] = []
  const report = await runner.runCliParity({
    createWorld: async (options) => {
      const world = await createCliWorld(options)
      const execute = world.execute.bind(world)
      let outcomeIndex = 0
      return {
        ...world,
        execute: async (argv: string[], executeOptions?: Parameters<typeof world.execute>[1]) => {
          if (argv[2] === 'api') return execute(argv, executeOptions)
          const outcome = outcomes[outcomeIndex++]
          if (!outcome) throw new Error('unexpected fixture command')
          return {
            ...outcome,
            stderr: '',
            stdoutBytes: Buffer.byteLength(outcome.stdout),
            elapsedMs: 1
          }
        }
      }
    },
    runChecks: async (context) => {
      for (let index = 0; index < ids.length; index++) {
        const id = ids[index]!
        try {
          if (index === 5) context.check('refuse-code-check')
          const refusal = await context.refuse(id, ['repo', 'show', 'id:missing'])
          if (index === 4) {
            observed.push(`${refusal.code}:${refusal.message}:${JSON.stringify(refusal.data)}`)
            try {
              context.prove(id, {})
            } catch (error) {
              observed.push(error instanceof runner.CliRunFailure ? error.kind : String(error))
              continue
            }
            observed.push('proved')
            continue
          }
          if (index === 5 && refusal.code !== 'not-found') {
            throw new Error(`expected not-found, received ${refusal.code}`)
          }
          observed.push('returned')
        } catch (error) {
          if (index === 5) throw error
          observed.push(error instanceof runner.CliRunFailure ? error.kind : String(error))
          if (index === 0) {
            try {
              context.prove(id, {})
            } catch (proofError) {
              observed.push(proofError instanceof runner.CliRunFailure ? proofError.kind : String(proofError))
              continue
            }
            observed.push('proved')
          }
        }
      }
    },
    cleanupChecks: async () => {}
  })

  expect(observed).toEqual([
    'unexpected-success', 'missing-receipt', 'cli-exit', 'malformed-output', 'malformed-output',
    'not-found:missing:{"reason":"missing"}', 'missing-receipt'
  ])
  expect(report.error).toMatchObject({ kind: 'assertion', stage: 'refuse-code-check' })
  expect(report.receipts.filter((receipt) => ids.includes(receipt.id)).map((receipt) => receipt.exitCode)).toEqual([0, 2, 1, 1, 1, 1])
}, 90_000)

test('world cwd is restricted to its real checkout root or owned home', async () => {
  const world = await createCliWorld()
  try {
    expect(readFileSync(world.paths.egressLog, 'utf8')).toBe('https://cli-parity-guard.invalid/self-test\n')
    const argv = [process.execPath, world.paths.cliEntry, 'api', '--runtime', 'local', '--json']
    expect((await world.execute(argv, { cwd: world.paths.repoRoot })).exitCode).toBe(0)
    expect((await world.execute(argv, { cwd: join(world.home, 'codex') })).exitCode).toBe(0)

    const outsideLink = join(world.home, 'outside-link')
    symlinkSync(join(world.home, '..'), outsideLink, 'dir')
    for (const cwd of ['relative-directory', join(world.home, '..'), outsideLink]) {
      await expect(world.execute(argv, { cwd })).rejects.toMatchObject({ kind: 'invalid-cli-arguments' })
    }
  } finally {
    await world.cleanup()
  }
}, 90_000)

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
        expect(observed.phase, JSON.stringify(report.error)).toBe(fault === 'sigterm' ? 'actor-live' : 'ready')
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
