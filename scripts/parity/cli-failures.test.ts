import { expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { PassThrough } from 'node:stream'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { delimiter, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { SUPPRESSION_PROMPT } from '../../plugins/quirky.ask/src/core/claude-flags'
import { createCliEnvironment, createCliWorld, type CliFilesWorld } from './cli-world'
import { createCliFixtures, installCliFixtureTools } from './cli-fixtures'
import { createActorReceiptStore, parseActorReceipt, quotePosixShellLiteral } from './cli-actor'
import { collectBracketedPaste, parseWorkerPreamble } from './cli-worker-actor'
import * as runner from './cli-run'
import * as files from './cli-files'
import { CLI_FILE_OBSERVATION_BINDINGS, loadCliTable, type CliTableRow } from './cli-table'
import * as probes from './cli-checks'
import { captureCliChild } from './cli-world'
import * as cliWorldModule from './cli-world'

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

type CliFilesTestWorld = {
  home: string
  env: Record<string, string>
  daemonPid: number
  cliEntry: string
  pages: readonly { isClosed(): boolean }[]
  records: readonly { index: number; connId: number; worktree: string; open: boolean }[]
  worktrees: readonly { id: string; path: string; repoId: string; isMain: boolean }[]
  tools: { fixtureBin: string; fetchPreload: string }
  buildElapsedMs: number
  execute(argv: string[], options?: { signal?: AbortSignal; timeoutMs?: number; cwd?: string }): Promise<{
    stdout: string; stderr: string; exitCode: number; stdoutBytes: number; elapsedMs: number
  }>
  prepare(argv: string[], cwd: string): Promise<unknown>
  cleanup(): Promise<void>
  cleanupEvidence: { identities: Array<{ kind: string; pid: number; gone: boolean }>; homeRemoved: boolean }
}
type CliFilesFactory = (options?: { signal?: AbortSignal }, dependencies?: Record<string, unknown>) => Promise<CliFilesTestWorld>
const cliFilesFactory = (cliWorldModule as unknown as { createCliFilesWorld?: CliFilesFactory }).createCliFilesWorld

function requireCliFilesFactory(): CliFilesFactory {
  if (typeof cliFilesFactory !== 'function') throw new Error('createCliFilesWorld is not exported')
  return cliFilesFactory
}

function cliFilesStandIns(overrides: {
  startupFailure?: Error
  buildFailure?: Error
  browserFailure?: Error
  browserStopFailure?: Error
  worldStopFailure?: Error
  chromeMissing?: boolean
  runResult?: { stdout: string; stderr: string; exitCode: number; stdoutBytes: number; elapsedMs: number }
  runCli?: (argv: string[], options?: { signal?: AbortSignal }) => Promise<{ stdout: string; stderr: string; exitCode: number; stdoutBytes: number; elapsedMs: number }>
} = {}) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'quirky-cli-files-world-')))
  const uiDir = join(home, 'ui-dist')
  const repoRoot = realpathSync(resolve(import.meta.dir, '../..'))
  const fixtureBin = join(home, 'fixture-bin')
  const fetchPreload = join(home, 'fetch-preload.cjs')
  const tools = { fixtureBin, fetchPreload }
  const events: string[] = []
  const state = {
    connIds: [41, 42],
    runtimePid: 701,
    pageClosed: [false, false],
    records: [
      { index: 0, connId: 41, worktree: 'wt-a', open: true, shown: true, lastRequestAgeSeconds: 0, requests: 1, sockets: 1, pageErrors: 0, pageErrorExamples: [] },
      { index: 1, connId: 42, worktree: 'wt-b', open: true, shown: true, lastRequestAgeSeconds: 0, requests: 1, sockets: 1, pageErrors: 0, pageErrorExamples: [] }
    ],
    livePids: new Set<number>()
  }
  const worktrees = [
    { id: 'wt-a', path: join(home, 'repos', 'a'), repoId: 'repo-a', name: 'a', isMain: false, status: 'idle' },
    { id: 'wt-b', path: join(home, 'repos', 'b'), repoId: 'repo-b', name: 'b', isMain: false, status: 'idle' }
  ]
  mkdirSync(worktrees[0]!.path, { recursive: true })
  mkdirSync(worktrees[1]!.path, { recursive: true })
  const scope = {
    home,
    env: { QUIRKY_HOME: home, QUIRKY_TEST_SCOPE: 'owned-test-scope' },
    spawn: () => { throw new Error('stand-in must not spawn an arbitrary process') },
    track: () => {},
    cleanup: async () => { events.push('scope.cleanup') },
    killNow: () => {}
  }
  const control = {
    callAny: async (method: string) => {
      if (method === 'ui.state') return { windows: state.connIds.map((connId) => ({ connId })) }
      throw new Error(`unexpected soak RPC ${method}`)
    },
    close: () => {}
  }
  const soakWorld = {
    home,
    runtime: { pid: 701, port: 43123, token: 'fixture-token', hookToken: 'fixture-hook-token', entryHash: 'fixture-entry' },
    get daemonPid() { return state.runtimePid },
    env: {},
    workers: [],
    ptyHostPid: () => null,
    updatePtyHostPid: () => {},
    fixtures: { worktrees },
    control,
    track: () => {},
    stop: async () => {
      events.push('world.stop')
      if (overrides.worldStopFailure) throw overrides.worldStopFailure
      state.livePids.delete(701)
    }
  }
  const pages = [
    { isClosed: () => state.pageClosed[0]! },
    { isClosed: () => state.pageClosed[1]! }
  ]
  const windows = {
    pages,
    browserPid: 801,
    finish: async () => ({ records: state.records.map((record) => ({ ...record })), requests: [] }),
    stop: async () => {
      events.push('browser.stop')
      if (overrides.browserStopFailure) throw overrides.browserStopFailure
      state.livePids.delete(801)
    }
  }
  const cliCalls: string[][] = []
  const dependencies: Record<string, unknown> = {
    repoRoot,
    createScope: () => {
      events.push('scope.create')
      return scope
    },
    installCliFixtureTools: (ownedHome: string) => {
      events.push('tools.install')
      if (ownedHome !== home) throw new Error('fixture tools installed outside the owned home')
      return tools
    },
    createCliEnvironment: (ownedHome: string, checkout: string, installedBin: string, installedPreload: string) => {
      events.push('environment.create')
      if (ownedHome !== home || checkout !== repoRoot || installedBin !== fixtureBin || installedPreload !== fetchPreload) throw new Error('incorrect environment inputs')
      return {
        HOME: home, QUIRKY_HOME: home, QUIRKY_PORT: '0', QUIRKY_AGENT_SEARCH_DIRS: '',
        PATH: `${fixtureBin}:/usr/bin:/bin`, BUN_OPTIONS: `--preload=${fetchPreload}`,
        QUIRKY_CLI_ENTRY: join(repoRoot, 'packages/cli/src/main.ts')
      }
    },
    verifyEgressGuard: async (options: { env: Record<string, string>; tools: typeof tools; repoRoot: string }) => {
      events.push('egress.verify')
      if (options.env.QUIRKY_HOME !== home || options.tools !== tools || options.repoRoot !== repoRoot) {
        throw new Error('egress verification did not use the owned environment and tools')
      }
    },
    startWorld: async (options: Record<string, unknown>, dependenciesForWorld: Record<string, unknown>) => {
      events.push('soak.start')
      if (options.workers !== false || options.windows !== 2) throw new Error('soak world must be worker-free with two windows')
      const createScope = dependenciesForWorld.createScope as (() => unknown) | undefined
      if (!createScope) throw new Error('startWorld did not receive the owned createScope callback')
      createScope()
      if (overrides.startupFailure) {
        await scope.cleanup()
        throw overrides.startupFailure
      }
      const prepare = dependenciesForWorld.prepareCaptureFixtureHome as ((home: string, options: { env: Record<string, string> }) => Promise<unknown>) | undefined
      if (!prepare) throw new Error('startWorld did not receive the fixture preparation callback')
      const helperEnv = {
        HOME: '/poison/home', QUIRKY_HOME: home, QUIRKY_UI_DIR: uiDir,
        QUIRKY_PORT: '1234', QUIRKY_AGENT_SEARCH_DIRS: '/poison/agents',
        PATH: '/poison/bin', HTTP_PROXY: 'http://proxy.invalid', OPENAI_API_KEY: 'poison',
        QUIRKY_SESSION_TOKEN: 'poison', GIT_CONFIG_GLOBAL: '/poison/gitconfig', NODE_OPTIONS: '--require=poison'
      }
      await prepare(home, { env: helperEnv })
      events.push('ui.build')
      if (overrides.buildFailure) {
        await scope.cleanup()
        throw overrides.buildFailure
      }
      mkdirSync(uiDir, { recursive: true })
      if (helperEnv.QUIRKY_UI_DIR !== uiDir) throw new Error('safe environment replacement lost the owned UI output')
      events.push('daemon.spawn')
      state.livePids.add(701)
      soakWorld.env = helperEnv
      return soakWorld
    },
    prepareCaptureFixtureHome: async (_home: string, options: { env: Record<string, string> }) => {
      events.push('fixtures.prepare')
      const env = options.env
      if (env.QUIRKY_HOME !== home || env.QUIRKY_PORT !== '0' || env.QUIRKY_AGENT_SEARCH_DIRS !== ''
        || env.QUIRKY_UI_DIR !== uiDir || env.HTTP_PROXY !== undefined || env.OPENAI_API_KEY !== undefined
        || env.QUIRKY_SESSION_TOKEN !== undefined || env.GIT_CONFIG_GLOBAL !== undefined || env.NODE_OPTIONS !== undefined
        || env.HOME !== home || !env.PATH?.startsWith(`${fixtureBin}:`)) {
        throw new Error('fixture preparation did not receive the restricted CLI environment')
      }
      return { ready: true }
    },
    registerCaptureFixtures: async () => ({ worktrees }),
    openWindows: async (options: Record<string, unknown>) => {
      events.push('windows.open')
      if (options.count !== 2 || options.world !== soakWorld || typeof options.executable !== 'string') {
        throw new Error('openWindows did not receive the owned two-window world and installed browser')
      }
      if (overrides.browserFailure) throw overrides.browserFailure
      state.livePids.add(801)
      return windows
    },
    findChrome: () => overrides.chromeMissing ? undefined : '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    readRuntime: () => ({ pid: state.runtimePid, home, port: 43123, token: 'fixture-token', hookToken: 'fixture-hook-token', entryHash: 'fixture-entry' }),
    isDaemonAlive: async () => state.livePids.has(701),
    processSnapshot: () => new Map([...state.livePids].map((pid) => [pid, {
      pid, ppid: process.pid, pgid: process.pid, started: `owned-${pid}`, state: 'S', command: pid === 701 ? 'quirky-daemon' : 'chromium'
    }])),
    runCli: async (argv: string[], options?: { signal?: AbortSignal }) => {
      cliCalls.push([...argv])
      if (overrides.runCli) return overrides.runCli(argv, options)
      return overrides.runResult ?? { stdout: '{"ok":true}', stderr: '', exitCode: 0, stdoutBytes: 11, elapsedMs: 1 }
    },
    runPreparation: async (argv: string[]) => {
      cliCalls.push([...argv])
      return { stdout: '', stderr: '', exitCode: 0, stdoutBytes: 0, elapsedMs: 1 }
    }
  }
  return { home, uiDir, repoRoot, fixtureBin, fetchPreload, tools, events, state, worktrees, scope, soakWorld, windows, cliCalls, dependencies }
}


test('CLI files world installs the owned environment before soak preparation and preserves real window identities', async () => {
  const createWorld = requireCliFilesFactory()
  const fixture = cliFilesStandIns()
  const world = await createWorld({}, fixture.dependencies)
  try {
    expect(fixture.events.indexOf('tools.install')).toBeLessThan(fixture.events.indexOf('fixtures.prepare'))
    expect(fixture.events.indexOf('environment.create')).toBeLessThan(fixture.events.indexOf('fixtures.prepare'))
    expect(fixture.events).toContain('egress.verify')
    expect(fixture.events.indexOf('egress.verify')).toBeLessThan(fixture.events.indexOf('soak.start'))
    expect(fixture.events.indexOf('egress.verify')).toBeLessThan(fixture.events.indexOf('fixtures.prepare'))
    expect(fixture.events.indexOf('fixtures.prepare')).toBeLessThan(fixture.events.indexOf('ui.build'))
    expect(fixture.events.indexOf('ui.build')).toBeLessThan(fixture.events.indexOf('daemon.spawn'))
    expect(world.home).toBe(fixture.home)
    expect(JSON.parse(readFileSync(join(world.home, '.claude', '.credentials.json'), 'utf8')))
      .toEqual({ claudeAiOauth: { refreshToken: 'cli-parity-fixture-refresh' } })
    expect(world.daemonPid).toBe(701)
    expect(world.buildElapsedMs).toBeGreaterThanOrEqual(0)
    expect(world.tools).toEqual(fixture.tools)
    expect(world.pages).toHaveLength(2)
    expect(world.records.map(({ index, connId, worktree }) => ({ index, connId, worktree }))).toEqual([
      { index: 0, connId: 41, worktree: 'wt-a' },
      { index: 1, connId: 42, worktree: 'wt-b' }
    ])
    expect(world.worktrees.map(({ id }) => id)).toEqual(world.records.map(({ worktree }) => worktree))
    expect(new Set(world.worktrees.map(({ id }) => id)).size).toBe(2)

    const argv = [process.execPath, world.cliEntry, 'api', '--runtime', 'local', '--json']
    await expect(world.execute(argv)).resolves.toMatchObject({ stdout: '{"ok":true}', exitCode: 0 })
    expect(fixture.cliCalls).toEqual([argv])
    await expect(world.prepare(['/usr/bin/git', 'status', '--short'], fixture.worktrees[0]!.path)).resolves.toMatchObject({ exitCode: 0 })
    await expect(world.prepare(['/bin/sh', '-c', 'touch pwned'], fixture.home)).rejects.toThrow()
  } finally {
    await world.cleanup()
  }
})

test('CLI files world refuses a lost renderer, stale connection, or mismatched daemon before executing', async () => {
  const createWorld = requireCliFilesFactory()
  const fixture = cliFilesStandIns()
  const world = await createWorld({}, fixture.dependencies)
  const argv = [process.execPath, world.cliEntry, 'api', '--runtime', 'local', '--json']
  try {
    fixture.state.pageClosed[1] = true
    await expect(world.execute(argv)).rejects.toThrow()
    fixture.state.pageClosed[1] = false
    fixture.state.connIds = [41]
    await expect(world.execute(argv)).rejects.toThrow()
    fixture.state.connIds = [41, 42]
    fixture.state.runtimePid = 999
    await expect(world.execute(argv)).rejects.toThrow()
    expect(fixture.cliCalls).toEqual([])
  } finally {
    await world.cleanup()
  }
})

test('CLI files world preserves startup and browser failures while stopping any acquired browser before the world', async () => {
  for (const fault of ['startup', 'browser'] as const) {
    const createWorld = requireCliFilesFactory()
    const failure = new Error(`${fault} stand-in failure`)
    const fixture = cliFilesStandIns(fault === 'startup' ? { startupFailure: failure } : { browserFailure: failure })
    await expect(createWorld({}, fixture.dependencies)).rejects.toThrow(`${fault} stand-in failure`)
    expect(fixture.events.indexOf('browser.stop') < 0 || fixture.events.indexOf('browser.stop') < fixture.events.indexOf('world.stop')).toBe(true)
    if (fault === 'startup') expect(fixture.events).toContain('scope.cleanup')
    else expect(fixture.events).toContain('world.stop')
    expect(existsSync(fixture.home)).toBe(false)
  }
})

test('CLI files world rejects oversized and malformed child output instead of accepting it as a receipt', async () => {
  const createWorld = requireCliFilesFactory()
  for (const result of [
    { stdout: 'x'.repeat(16 * 1024 * 1024 + 1), stderr: '', exitCode: 0, stdoutBytes: 16 * 1024 * 1024 + 1, elapsedMs: 1 },
    { stdout: '{', stderr: '', exitCode: 0, stdoutBytes: 1, elapsedMs: 1 },
    { stdout: '{"error":{"message":"denied"}}', stderr: '', exitCode: 0, stdoutBytes: 30, elapsedMs: 1 },
    { stdout: '{}', stderr: 'failure', exitCode: 1, stdoutBytes: 2, elapsedMs: 1 }
  ]) {
    const fixture = cliFilesStandIns({ runResult: result })
    const world = await createWorld({}, fixture.dependencies)
    try {
      await expect((async () => {
        const raw = await world.execute([process.execPath, world.cliEntry, 'api', '--runtime', 'local', '--json'])
        runner.parseCliOutput(raw.stdout, 'json', raw.exitCode)
      })()).rejects.toThrow()
    } finally {
      await world.cleanup()
    }
  }
})

test('CLI files world cleanup is idempotent, verifies process disappearance, and preserves cleanup errors', async () => {
  const createWorld = requireCliFilesFactory()
  const fixture = cliFilesStandIns()
  const world = await createWorld({}, fixture.dependencies)
  const sentinel = Bun.spawn([process.execPath, '-e', 'process.stdin.resume()'], {
    stdin: 'pipe', env: { ...world.env, BUN_OPTIONS: '' }, stdout: 'ignore', stderr: 'ignore'
  })
  try {
    await world.cleanup()
    await world.cleanup()
    expect(fixture.events.filter((event) => event === 'browser.stop')).toHaveLength(1)
    expect(fixture.events.filter((event) => event === 'world.stop')).toHaveLength(1)
    expect(fixture.events.indexOf('browser.stop')).toBeLessThan(fixture.events.indexOf('world.stop'))
    expect(world.cleanupEvidence).toMatchObject({
      identities: [
        { kind: 'daemon', pid: 701, gone: true },
        { kind: 'browser', pid: 801, gone: true }
      ],
      homeRemoved: true
    })
    expect(existsSync(fixture.home)).toBe(false)
    expect(sentinel.exitCode).toBeNull()
  } finally {
    sentinel.kill('SIGKILL')
    await sentinel.exited
  }
})

test('CLI files world reports a missing installed browser and cleans the owned startup world', async () => {
  const createWorld = requireCliFilesFactory()
  const fixture = cliFilesStandIns({ chromeMissing: true })
  await expect(createWorld({}, fixture.dependencies)).rejects.toThrow(/chrome/i)
  expect(fixture.events).toContain('world.stop')
  expect(fixture.events).not.toContain('windows.open')
  expect(existsSync(fixture.home)).toBe(false)
})

test('CLI files world cleans a browser that resolves after interruption', async () => {
  const createWorld = requireCliFilesFactory()
  const fixture = cliFilesStandIns()
  const controller = new AbortController()
  const { promise: started, resolve: markStarted } = Promise.withResolvers<void>()
  const { promise: stopped, resolve: markStopped } = Promise.withResolvers<void>()
  const { promise: lateWindows, resolve: resolveWindows } = Promise.withResolvers<typeof fixture.windows>()
  const stop = fixture.windows.stop
  fixture.windows.stop = async () => {
    await stop()
    markStopped()
  }
  fixture.dependencies.openWindows = async () => {
    markStarted()
    return lateWindows
  }

  const opening = createWorld({ signal: controller.signal }, fixture.dependencies)
  await started
  controller.abort(new Error('renderer startup interrupted'))
  resolveWindows(fixture.windows)
  await expect(opening).rejects.toThrow(/interrupt/i)
  await stopped
  expect(fixture.events.indexOf('browser.stop')).toBeLessThan(fixture.events.indexOf('world.stop'))
  expect(existsSync(fixture.home)).toBe(false)
})

test('CLI files world passes interruption to a running CLI child and refuses its result', async () => {
  const createWorld = requireCliFilesFactory()
  const { promise: started, resolve: markStarted } = Promise.withResolvers<void>()
  const fixture = cliFilesStandIns({
    runCli: (_argv, options) => new Promise((_resolve, reject) => {
      markStarted()
      options?.signal?.addEventListener('abort', () => reject(options.signal?.reason), { once: true })
    })
  })
  const world = await createWorld({}, fixture.dependencies)
  const controller = new AbortController()
  const execution = world.execute([process.execPath, world.cliEntry, 'api', '--runtime', 'local', '--json'], { signal: controller.signal })
  const refused = execution.then(
    () => { throw new Error('interrupted child unexpectedly succeeded') },
    error => error as Error
  )
  try {
    const begun = await Promise.race([started.then(() => ({ started: true })), refused.then(error => ({ error }))])
    if ('error' in begun) throw begun.error
    controller.abort(new Error('child interrupted'))
    const error = await refused
    expect(error).toBeInstanceOf(Error)
    expect(error.message).toBe('child interrupted')
  } finally {
    await world.cleanup()
  }
})

test('CLI files world cleanup attempts both stops and preserves browser and world cleanup failures', async () => {
  const createWorld = requireCliFilesFactory()
  const fixture = cliFilesStandIns({
    browserStopFailure: new Error('browser stop failed'),
    worldStopFailure: new Error('world stop failed')
  })
  const world = await createWorld({}, fixture.dependencies)
  await expect(world.cleanup()).rejects.toThrow(/browser stop failed.*world stop failed|world stop failed.*browser stop failed/)
  await expect(world.cleanup()).rejects.toThrow(/browser stop failed.*world stop failed|world stop failed.*browser stop failed/)
  expect(fixture.events.indexOf('browser.stop')).toBeLessThan(fixture.events.indexOf('world.stop'))
  expect(existsSync(fixture.home)).toBe(true)
})

test('CLI files world cleans an owned UI build failure after preserving the startup error', async () => {
  const createWorld = requireCliFilesFactory()
  const fixture = cliFilesStandIns({ buildFailure: new Error('UI build stand-in failure') })
  await expect(createWorld({}, fixture.dependencies)).rejects.toThrow('UI build stand-in failure')
  expect(fixture.events).toContain('fixtures.prepare')
  expect(fixture.events).toContain('ui.build')
  expect(fixture.events).not.toContain('windows.open')
  expect(existsSync(fixture.home)).toBe(false)
})

test('CLI files world refuses mismatched page connection and fixture worktree correlation', async () => {
  for (const fault of ['connection', 'worktree', 'duplicate'] as const) {
    const fixture = cliFilesStandIns()
    if (fault === 'connection') fixture.state.records[1].connId = 404
    else if (fault === 'worktree') fixture.state.records[1].worktree = 'not-owned'
    else fixture.state.records[1].worktree = fixture.state.records[0].worktree
    try {
      await expect(requireCliFilesFactory()({}, fixture.dependencies)).rejects.toThrow()
    } finally {
      rmSync(fixture.home, { recursive: true, force: true })
    }
  }
})

test('CLI files world cannot certify cleanup without a process table or with a surviving identity', async () => {
  const createWorld = requireCliFilesFactory()
  for (const fault of ['missing-table', 'survivor'] as const) {
    const fixture = cliFilesStandIns()
    const snapshot = fixture.dependencies.processSnapshot as () => Map<number, unknown>
    let unavailable = false
    fixture.dependencies.processSnapshot = () => {
      if (unavailable) throw new Error('process table unavailable')
      return snapshot()
    }
    if (fault === 'survivor') fixture.soakWorld.stop = async () => { fixture.events.push('world.stop') }
    const world = await createWorld({}, fixture.dependencies)
    unavailable = fault === 'missing-table'
    try {
      await expect(world.cleanup()).rejects.toThrow()
      expect(world.cleanupEvidence.homeRemoved).toBe(false)
    } finally {
      rmSync(fixture.home, { recursive: true, force: true })
    }
  }
})

test('CLI files world refuses an inactive egress guard before fixture preparation or daemon startup', async () => {
  const createWorld = requireCliFilesFactory()
  const fixture = cliFilesStandIns()
  fixture.dependencies.verifyEgressGuard = async () => { throw new Error('egress guard self-test failed') }
  await expect(createWorld({}, fixture.dependencies)).rejects.toThrow('egress guard self-test failed')
  expect(fixture.events).not.toContain('fixtures.prepare')
  expect(fixture.events).not.toContain('daemon.spawn')
  expect(existsSync(fixture.home)).toBe(false)
})

test('CLI files world keeps both connections live when the first window navigates to the second worktree', async () => {
  const createWorld = requireCliFilesFactory()
  const fixture = cliFilesStandIns()
  const world = await createWorld({}, fixture.dependencies)
  fixture.state.records[0].shown = false
  try {
    await expect(world.execute([process.execPath, world.cliEntry, 'api', '--runtime', 'local', '--json'])).resolves.toMatchObject({ exitCode: 0 })
  } finally {
    await world.cleanup()
  }
})

test('CLI files world permits bounded owned-tab teardown with a separate signal after work aborts', async () => {
  const createWorld = requireCliFilesFactory()
  const fixture = cliFilesStandIns()
  const work = new AbortController()
  const teardown = new AbortController()
  const world = await createWorld({ signal: work.signal }, fixture.dependencies)
  const argv = [process.execPath, world.cliEntry, 'editor', 'close', '--buffer-id', 'owned-buffer', '--runtime', 'local', '--json']
  work.abort(new Error('work interrupted'))
  try {
    await expect(world.execute(argv)).rejects.toThrow('work interrupted')
    expect(fixture.cliCalls).toEqual([])
    await expect(world.execute(argv, { signal: teardown.signal, timeoutMs: 1000 })).resolves.toMatchObject({ exitCode: 0 })
    expect(fixture.cliCalls).toEqual([argv])
  } finally {
    await world.cleanup()
  }
})

test('CLI files world aborts renderer acquisition when startup times out before stopping the world', async () => {
  const fixture = cliFilesStandIns()
  const late = Promise.withResolvers<typeof fixture.windows>()
  const expired = Promise.withResolvers<void>()
  const waitingForLate = Promise.withResolvers<void>()
  const setTimer = globalThis.setTimeout
  let rendererSignal: AbortSignal | undefined
  let abortedBeforeWorldStop = false
  let abortedBeforeLateWait = false
  const stopWorld = fixture.soakWorld.stop
  fixture.soakWorld.stop = async () => {
    abortedBeforeWorldStop = rendererSignal?.aborted === true
    await stopWorld()
  }
  fixture.dependencies.openWindows = async (options: { signal: AbortSignal }) => {
    rendererSignal = options.signal
    return late.promise
  }
  globalThis.setTimeout = ((callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
    if (ms === 25_000) {
      abortedBeforeLateWait = rendererSignal?.aborted === true
      waitingForLate.resolve()
    }
    return setTimer(() => {
      callback(...args)
      if (ms === 30_000) expired.resolve()
    }, ms === 30_000 ? 0 : ms)
  }) as typeof setTimeout
  try {
    const opening = requireCliFilesFactory()({}, fixture.dependencies).then(
      () => { throw new Error('timed-out renderer startup unexpectedly succeeded') },
      error => error as Error
    )
    await expired.promise
    fixture.state.livePids.add(801)
    await waitingForLate.promise
    late.resolve(fixture.windows)
    expect((await opening).message).toContain('renderer startup')
    expect(abortedBeforeWorldStop).toBe(true)
    expect(abortedBeforeLateWait).toBe(true)
    expect(fixture.events.indexOf('browser.stop')).toBeLessThan(fixture.events.indexOf('world.stop'))
    expect(existsSync(fixture.home)).toBe(false)
  } finally {
    globalThis.setTimeout = setTimer
    late.resolve(fixture.windows)
  }
})

type FixtureTab = {
  kind: string; id: string; viewId: string; title: string; key: string; input: Record<string, unknown>
}
type FixtureBuffer = {
  id: string; worktreeId: string; root: string; path: string; mode: string; tabId: string
  view?: { byTabId: Record<string, { cursor?: { line: number; column: number }; line?: number; column?: number }> }
}
type FixturePublicWindow = {
  connId: number
  receiptIds: { window: string; workspace: string; editor: string }
  windowState: { connId: number; layout: { worktree: string; view: { id: string } } }
  workspace: { workspace: { id: string; activeGroup: string; root: { kind: string; id: string; activeTab: string; tabs: FixtureTab[] } } }
  editor: { buffers: FixtureBuffer[]; tabs: Array<{ tabId: string; bufferId: string; mode: string }> }
}
type EditorFixtureEvidence = {
  request: { worktreeId: string; relativePath: string; absolutePath: string; content: string; mode: string; focus: boolean; line: number; column: number }
  public: { before: FixturePublicWindow[]; after: FixturePublicWindow[] }
  dom: { before: files.CliFileDomWindow[]; after: files.CliFileDomWindow[] }
  background: { public: FixturePublicWindow[]; dom: files.CliFileDomWindow[] }
}
type EditorEvidenceFixture = {
  receipts: CliReceipt[]
  observation: Omit<files.CliFileObservation, 'evidence'> & { evidence: EditorFixtureEvidence }
}

function editorEvidenceFixture(): EditorEvidenceFixture {
  const root = '/tmp/cli-fixture/worktrees'
  const receipts: CliReceipt[] = []
  const receipt = (id: string, argv: string[], result: unknown, exitCode = 0) => {
    receipts.push({ id, command: argv.slice(0, 2).join(' '), argv: [...argv, '--runtime', 'local', '--json'], exitCode, format: 'json', stdoutBytes: JSON.stringify(result).length, elapsedMs: 1, evidence: { result: structuredClone(result) } })
  }
  const makeSample = (phase: string, focused: boolean, background = false) => {
    const publicWindows: FixturePublicWindow[] = []
    const dom: files.CliFileDomWindow[] = []
    const snapshots: files.CliFileSnapshot[] = []
    for (const [index, label] of ['A', 'B'].entries()) {
      const connId = 11 + index
      const workspaceId = `wt-${label}`
      const groupId = `grp-${label}`
      const sentinel = `sentinel-${label}`
      const hasTarget = label === 'A' && (focused || background)
      const selected = label === 'A' && focused ? 'tab-A' : sentinel
      const path = `${root}/${label.toLowerCase()}/${selected === 'tab-A' ? 'src/app.ts' : 'docs/review-notes.md'}`
      const sentinelBuffer = { id: `buf-s-${label}`, worktreeId: workspaceId, root: `${root}/${label.toLowerCase()}`, path: `${root}/${label.toLowerCase()}/docs/review-notes.md`, mode: 'source', tabId: sentinel }
      const targetBuffer = { id: 'buf-A', worktreeId: 'wt-A', root: `${root}/a`, path: `${root}/a/src/app.ts`, mode: 'source', tabId: 'tab-A', view: { byTabId: { 'tab-A': focused ? { cursor: { line: 2, column: 3 } } : { line: 2, column: 3 } } } }
      const tabs: FixtureTab[] = [{ kind: 'view', id: sentinel, viewId: 'view:quirky.editor/document', title: 'Review notes', key: `buf-s-${label}`, input: { bufferId: `buf-s-${label}`, mode: 'source' } }]
      if (hasTarget) tabs.push({ kind: 'view', id: 'tab-A', viewId: 'view:quirky.editor/document', title: 'app.ts', key: 'buf-A', input: { bufferId: 'buf-A', mode: 'source' } })
      const windowState = { connId, layout: { worktree: workspaceId, view: { id: 'view:quirky.session/worktree' } } }
      const workspace = { workspace: { id: workspaceId, activeGroup: groupId, root: { kind: 'group', id: groupId, activeTab: selected, tabs } } }
      const editor: FixturePublicWindow['editor'] = { buffers: [sentinelBuffer, ...(hasTarget ? [targetBuffer] : [])], tabs: [{ tabId: sentinel, bufferId: sentinelBuffer.id, mode: 'edit' }, ...(hasTarget ? [{ tabId: 'tab-A', bufferId: 'buf-A', mode: 'edit' }] : [])] }
      const ids = { window: `${phase}-${label}-window`, workspace: `${phase}-${label}-workspace`, editor: `${phase}-${label}-editor` }
      receipt(ids.window, ['api', 'call', 'ui.window.state', '--conn-id', String(connId)], windowState)
      receipt(ids.workspace, ['api', 'call', 'quirky.terminal/workspace', '--workspace', workspaceId], workspace)
      receipt(ids.editor, ['editor', 'state', '--worktree', workspaceId], editor)
      publicWindows.push({ connId, receiptIds: ids, windowState, workspace, editor })
      const sample: files.CliFileDomWindow = { connId, workspaceId, groupId, selectedTabId: selected, renderedTabId: selected, path, documentHasFocus: label === 'A', activeElement: { tag: 'DIV', role: 'textbox', inDocument: true }, activeElementHostedTabId: selected, activeElementIsSource: true, reviewTabMounted: false, caret: selected === 'tab-A' ? { line: 2, column: 3 } : null, lines: selected === 'tab-A' ? ['first A', 'second A', ''] : [`notes ${label}`, ''], reviewCards: [] }
      dom.push(sample)
      const { lines, reviewCards, activeElementHostedTabId, activeElementIsSource, reviewTabMounted, ...snapshot } = sample
      snapshots.push({ ...snapshot, windowWorktree: workspaceId, windowViewId: 'view:quirky.session/worktree' })
    }
    return { public: publicWindows, dom, snapshots }
  }
  const before = makeSample('before', false)
  const background = makeSample('background', false, true)
  const after = makeSample('after', true)
  const open = { id: 'buf-A', worktreeId: 'wt-A', root: `${root}/a`, path: `${root}/a/src/app.ts`, openedTabId: 'tab-A' }
  const argv = ['editor', 'open', 'src/app.ts', '--worktree', 'wt-A', '--mode', 'source', '--line', '2', '--column', '3']
  receipt('open-a-bg', argv, open)
  receipt('open-a-focus', [...argv, '--focus'], open)
  receipt('read-a', ['editor', 'read', '--buffer-id', 'buf-A', '--action', 'buffer'], { buffer: { id: 'buf-A', worktreeId: 'wt-A', path: open.path, content: 'first A\nsecond A\n' }, eof: true, size: Buffer.byteLength('first A\nsecond A\n') })
  return {
    receipts,
    observation: {
      id: 'files-editor-local', status: 'observed', receiptIds: receipts.map(entry => entry.id),
      before: before.snapshots, after: after.snapshots,
      evidence: {
        request: { worktreeId: 'wt-A', relativePath: 'src/app.ts', absolutePath: open.path, content: 'first A\nsecond A\n', mode: 'source', focus: true, line: 2, column: 3 },
        public: { before: before.public, after: after.public },
        dom: { before: before.dom, after: after.dom },
        background: { public: background.public, dom: background.dom }
      }
    }
  }
}

test('file evidence rejects independent identity, content, focus, and visible-caret corruption', async () => {
  const fixture = editorEvidenceFixture()
  expect(() => files.assertCliFileObservation(fixture.observation as never, fixture.receipts as never)).not.toThrow()
  const mutations: Array<(value: EditorEvidenceFixture) => void> = [
    value => { value.observation.after[0].windowWorktree = 'wt-B' },
    value => { value.observation.after[0].connId = 99 },
    value => { value.observation.after[0].groupId = 'grp-wrong' },
    value => { value.observation.after[0].renderedTabId = 'another-tab' },
    value => { value.observation.evidence.public.after[0].workspace.workspace.root.tabs[1].viewId = 'view:quirky.git/diff' },
    value => { value.observation.evidence.public.after[0].workspace.workspace.root.tabs[1].input.bufferId = 'another-buffer' },
    value => { value.observation.evidence.dom.after[0].path = '/tmp/cli-fixture/worktrees/b/src/app.ts' },
    value => { value.observation.evidence.dom.after[0].selectedTabId = 'sentinel-A' },
    value => { value.observation.evidence.background.dom[0].activeElement.inDocument = false },
    value => { value.observation.evidence.background.dom[0].activeElementHostedTabId = 'tab-A' },
    value => { value.observation.evidence.dom.after[0].lines[1] = 'second B' },
    value => { value.observation.evidence.request.line = 3 },
    value => { value.observation.evidence.dom.after[0].caret = null },
    value => { value.observation.evidence.dom.after[0].caret = { line: 2, column: 1 } },
    value => {
      value.observation.evidence.dom.after[0].caret = null
      value.observation.after[0].caret = null
      const window = value.observation.evidence.public.after[0]
      window.editor.buffers[1].view!.byTabId['tab-A'] = { line: 2, column: 3 }
      value.receipts.find(entry => entry.id === window.receiptIds.editor)!.evidence.result = structuredClone(window.editor)
    },
    value => {
      value.observation.evidence.dom.after[0].renderedTabId = 'wrong-tab-with-correct-text'
      value.observation.after[0].renderedTabId = 'wrong-tab-with-correct-text'
    },
    value => {
      value.observation.evidence.dom.after[0].path = '/tmp/cli-fixture/worktrees/b/src/app.ts'
      value.observation.after[0].path = '/tmp/cli-fixture/worktrees/b/src/app.ts'
    },
    value => { value.observation.evidence.dom.after[0] = { ...value.observation.evidence.dom.after[1], lines: ['first A', 'second A', ''] } },
    value => { value.receipts[0].exitCode = 1 },
    value => { value.receipts.push(structuredClone(value.receipts[0])) },
    value => { value.receipts.splice(value.receipts.findIndex(entry => entry.id === 'read-a'), 1) },
    value => { value.observation.receiptIds.push(value.observation.receiptIds[0]) },
    value => { value.observation.evidence = { observed: true } as never }
  ]
  for (const [index, mutate] of mutations.entries()) {
    const corrupted = structuredClone(fixture)
    mutate(corrupted)
    expect(() => files.assertCliFileObservation(corrupted.observation as never, corrupted.receipts as never), `corruption ${index}`).toThrow()
  }
})

test('file evidence script rejects caller runtimes and refuses receipt-only certification', async () => {
  expect(files.parseCliFilesArgs(['--json'])).toEqual({ json: true, help: false })
  for (const argv of [['--home', '/tmp/other'], ['--runtime', 'remote'], ['--out', '/tmp/out'], ['--command', 'echo secret'], ['extra'], ['--json', '--json'], ['--help', '--json']]) expect(() => files.parseCliFilesArgs(argv)).toThrow()
  expect(() => files.assertCliFileObservation({ id: 'files-editor-local', status: 'observed', receiptIds: [], before: [], after: [], evidence: { observed: true } } as never, [])).toThrow()
})

test('file evidence reduction cannot promote no observations or an observed-only claim', async () => {
  const rows = loadCliTable()
  const expectedRows = rows.filter(row => Object.hasOwn(CLI_FILE_OBSERVATION_BINDINGS, row.id))
  const absent = files.reduceCliFilesRows(rows, [], [])
  expect(absent.map(row => row.id)).toEqual(expectedRows.map(row => row.id))
  expect(absent.every(row => row.status === 'not-run' && row.executed === false)).toBe(true)
  const claimed = files.reduceCliFilesRows(rows, [{
    id: 'files-editor-local', status: 'observed', receiptIds: [], before: [], after: [], evidence: { observed: true }
  } as never], [])
  expect(claimed.some(row => row.status === 'failed')).toBe(true)
  expect(claimed.every(row => row.status !== 'observed')).toBe(true)
})

test('file Git path readback preserves literal Unicode and shell-looking bytes in NUL framing', () => {
  const literal = "cli-parity/open '$(touch cli-injected); λ.txt"
  expect(files.parseCliFilesGitPaths(`?? ${literal}\0 M src/app.ts\0`)).toEqual([literal, 'src/app.ts'])
  expect(files.parseCliFilesGitPaths('R  new name\0old name\0')).toEqual(['new name'])
  for (const malformed of [' M missing terminator', 'bad\0', 'R  new\0']) expect(() => files.parseCliFilesGitPaths(malformed)).toThrow()
})

function reviewEvidenceFixture(id: 'files-review-diff' | 'files-review-reuse' | 'files-review-changed') {
  const editor = editorEvidenceFixture()
  const receipts: CliReceipt[] = []
  const worktree = 'wt-B'
  const tabId = 'review-B'
  const key = `git-diff:${JSON.stringify([worktree, 'review'])}`
  const path = id === 'files-review-diff' ? 'src/app.ts' : id === 'files-review-reuse' ? 'docs/review-notes.md' : null
  const receipt = (name: string, argv: string[], result: unknown) => {
    receipts.push({ id: name, command: argv.slice(0, 2).join(' '), argv: [...argv, '--runtime', 'local', '--json'], exitCode: 0, format: 'json', stdoutBytes: JSON.stringify(result).length, elapsedMs: 1, evidence: { result: structuredClone(result) } })
  }
  const reviewWindow = (connId: number): FixturePublicWindow => {
    const window = structuredClone(editor.observation.evidence.public.before[1])
    window.connId = connId
    window.windowState.connId = connId
    window.workspace.workspace.root.activeTab = tabId
    window.workspace.workspace.root.tabs.push({
      kind: 'view', id: tabId, viewId: 'view:quirky.git/diff', title: 'Review', key,
      input: { mode: 'review', worktree, reveal: 'src/app.ts' }
    })
    return window
  }
  const reviewDom = (connId: number): files.CliFileDomWindow => ({
    ...structuredClone(editor.observation.evidence.dom.before[1]), connId, selectedTabId: tabId, renderedTabId: tabId,
    path: null, caret: null, lines: [], activeElement: { tag: 'DIV', role: null, inDocument: false },
    activeElementHostedTabId: null, activeElementIsSource: false, reviewTabMounted: true,
    reviewCards: [
      { path: 'src/app.ts', expanded: true, loaded: true, text: 'first\nsecond λ\n' },
      { path: 'docs/review-notes.md', expanded: true, loaded: true, text: 'review notes B changed\n' }
    ]
  })
  const sample = (phase: string, windows: FixturePublicWindow[], dom: files.CliFileDomWindow[]): files.CliFileSnapshot[] =>
    windows.map((window, index) => {
      const ids = { window: `${id}-${phase}-${index}-window`, workspace: `${id}-${phase}-${index}-workspace`, editor: `${id}-${phase}-${index}-editor` }
      window.receiptIds = ids
      receipt(ids.window, ['api', 'call', 'ui.window.state', '--conn-id', String(window.connId)], window.windowState)
      receipt(ids.workspace, ['api', 'call', 'quirky.terminal/workspace', '--workspace', window.windowState.layout.worktree], window.workspace)
      receipt(ids.editor, ['editor', 'state', '--worktree', window.windowState.layout.worktree], window.editor)
      const { lines, reviewCards, activeElementHostedTabId, activeElementIsSource, reviewTabMounted, ...snapshot } = dom[index]
      return { ...snapshot, windowWorktree: window.windowState.layout.worktree, windowViewId: window.windowState.layout.view.id }
    })
  const beforePublic = id === 'files-review-reuse' ? [reviewWindow(11), reviewWindow(12)] : structuredClone(editor.observation.evidence.public.before)
  const beforeDom = id === 'files-review-reuse' ? [reviewDom(11), reviewDom(12)] : structuredClone(editor.observation.evidence.dom.before)
  const publicAfter = [reviewWindow(11), reviewWindow(12)]
  const domAfter = [reviewDom(11), reviewDom(12)]
  const before = sample('before', beforePublic, beforeDom)
  const after = sample('after', publicAfter, domAfter)
  const command = id === 'files-review-changed' ? 'command:quirky.git/open-changes' : 'command:quirky.git/open-diff'
  const args = { worktree, ...(path === null ? {} : { path }) }
  receipt(`${id}-command`, ['api', 'call', 'ui.window.command.run', '--conn-id', '11', '--id', command, '--args', JSON.stringify(args)], {})
  const review: Record<string, unknown> = { worktreeId: worktree, path, targetConnectionId: 11, reviewKey: key, tabId }
  const evidence: files.CliFileObservationEvidence = {
    request: { worktreeId: worktree, path, absolutePath: `/tmp/cli-fixture/worktrees/b${path === null ? '' : `/${path}`}`, content: path === 'docs/review-notes.md' ? 'review notes B changed\n' : 'first\nsecond λ\n', targetConnectionId: 11, mode: 'review' },
    public: { before: beforePublic, after: publicAfter }, dom: { before: beforeDom, after: domAfter }, review
  }
  let repeat: FixturePublicWindow | undefined
  if (id === 'files-review-changed') {
    repeat = reviewWindow(11)
    const repeatDom = reviewDom(11)
    sample('repeat', [repeat], [repeatDom])
    review.repeatBefore = { public: repeat, dom: repeatDom }
    review.tabBeforeRepeat = tabId
    review.changedPaths = ['src/app.ts', 'docs/review-notes.md']
    review.supportingReceiptIds = []
    const status = { entries: [{ path: 'src/app.ts' }, { path: 'docs/review-notes.md' }] }
    receipt(`${id}-git-before`, ['api', 'call', 'quirky.git/status', '--worktree', worktree], status)
    receipt(`${id}-git-after`, ['api', 'call', 'quirky.git/status', '--worktree', worktree], status)
    evidence.git = { beforeReceiptId: `${id}-git-before`, afterReceiptId: `${id}-git-after`, before: status, after: status }
    receipt(`${id}-repeat-command`, ['api', 'call', 'ui.window.command.run', '--conn-id', '11', '--id', command, '--args', JSON.stringify(args)], {})
  }
  const observation: files.CliFileObservation = { id, status: 'observed', receiptIds: receipts.map(entry => entry.id), before, after, evidence }
  return { receipts, observation, publicAfter, repeat }
}

for (const id of ['files-review-diff', 'files-review-reuse', 'files-review-changed'] as const) {
  test(`file Review evidence rejects extra non-Review tabs from ${id}`, () => {
    const fixture = reviewEvidenceFixture(id)
    expect(() => files.assertCliFileObservation(fixture.observation, fixture.receipts)).not.toThrow()
    for (const window of [...fixture.publicAfter, ...(fixture.repeat ? [fixture.repeat] : [])]) {
      window.workspace.workspace.root.tabs.push({
        kind: 'view', id: 'unrequested-editor', viewId: 'view:quirky.editor/document', title: 'Unrequested', key: 'extra', input: { bufferId: 'extra' }
      })
      fixture.receipts.find(entry => entry.id === window.receiptIds.workspace)!.evidence.result = structuredClone(window.workspace)
    }
    expect(() => files.assertCliFileObservation(fixture.observation, fixture.receipts)).toThrow()
  })
}

test('file Review reuse proves the loaded revealed card even when stored reveal stays unchanged', () => {
  const fixture = reviewEvidenceFixture('files-review-reuse')
  expect(() => files.assertCliFileObservation(fixture.observation, fixture.receipts)).not.toThrow()
  for (const dom of fixture.observation.evidence.dom.after) {
    dom.reviewCards = dom.reviewCards.filter(card => card.path !== 'docs/review-notes.md')
  }
  expect(() => files.assertCliFileObservation(fixture.observation, fixture.receipts)).toThrow()
})

test('file runner retains startup and cleanup failures without certifying any observation', async () => {
  const failure = new cliWorldModule.CliWorldError('owned-startup', 'owned startup failed')
  failure.cleanupError = 'owned teardown failed'
  const report = await files.runCliFilesParity({ createWorld: async () => { throw failure } })
  expect(report).toMatchObject({
    ok: false, parityComplete: false,
    error: { stage: 'setup', kind: 'owned-startup', message: 'owned startup failed' },
    cleanup: { ok: false, error: expect.stringContaining('owned teardown failed') }
  })
  expect(report.observations.every(observation => observation.status === 'not-run')).toBe(true)
  expect(report.rows.every(row => !row.executed)).toBe(true)
})

test('file runner validates script arguments before constructing an owned world', async () => {
  let allocations = 0
  const createWorld = async (): Promise<never> => {
    allocations++
    throw new Error('world allocation must not run')
  }
  const diagnostic = console.error
  console.error = () => {}
  try {
    for (const args of [['--home', '/tmp/not-owned'], ['--runtime', 'remote'], ['--out', '/tmp/out'], ['extra']]) {
      expect(await files.main(args, { createWorld })).toBe(2)
    }
    expect(allocations).toBe(0)
  } finally {
    console.error = diagnostic
  }
})

test('renderer evidence reads stop on interruption and retain late rejection handling', async () => {
  const controller = new AbortController()
  const pending = Promise.withResolvers<string>()
  const started = Promise.withResolvers<void>()
  const result = files.captureCliFilesRenderer(() => {
    started.resolve()
    return pending.promise
  }, controller.signal, 15_000).then(value => ({ value }), error => ({ error }))
  await started.promise
  controller.abort(new files.CliFilesFailure('interrupted', 'stop renderer read'))
  expect(await result).toMatchObject({ error: { kind: 'interrupted', message: 'stop renderer read' } })
  pending.reject(new Error('late renderer failure'))
})

function installCliFilesHealthClock(fixture: { dependencies: Record<string, unknown> }) {
  let currentTime = 0
  const sleeps: number[] = []
  fixture.dependencies.now = () => currentTime
  fixture.dependencies.sleep = async (milliseconds: number) => {
    sleeps.push(milliseconds)
    currentTime += milliseconds
  }
  return { sleeps, now: () => currentTime }
}

test('CLI files health retries transient failures during startup', async () => {
  const createWorld = requireCliFilesFactory()
  const fixture = cliFilesStandIns()
  const clock = installCliFilesHealthClock(fixture)
  let probes = 0
  fixture.dependencies.isDaemonAlive = async () => ++probes >= 3

  const world = await createWorld({}, fixture.dependencies)
  try {
    expect(probes).toBe(3)
    expect(clock.sleeps).toEqual([50, 50])
    expect(fixture.events).toContain('windows.open')
  } finally {
    await world.cleanup()
  }
})

test('CLI files health retries transient failures before executing', async () => {
  const createWorld = requireCliFilesFactory()
  const fixture = cliFilesStandIns()
  const clock = installCliFilesHealthClock(fixture)
  let probes = 0
  fixture.dependencies.isDaemonAlive = async () => {
    probes++
    return probes === 1 || probes === 4
  }
  const world = await createWorld({}, fixture.dependencies)
  const argv = [process.execPath, world.cliEntry, 'api', '--runtime', 'local', '--json']
  try {
    await expect(world.execute(argv)).resolves.toMatchObject({ stdout: '{"ok":true}', exitCode: 0 })
    expect(probes).toBe(4)
    expect(clock.sleeps).toEqual([50, 50])
    expect(fixture.cliCalls).toEqual([argv])
    expect(fixture.events.filter((event) => event === 'windows.open')).toHaveLength(1)
  } finally {
    await world.cleanup()
  }
})

test('CLI files health exhausts five seconds of false probes without launching renderers or a child', async () => {
  const createWorld = requireCliFilesFactory()
  const fixture = cliFilesStandIns()
  const clock = installCliFilesHealthClock(fixture)
  const probeTimeouts: number[] = []
  fixture.dependencies.isDaemonAlive = async (_runtime: unknown, timeoutMs: number) => {
    probeTimeouts.push(timeoutMs)
    return false
  }

  await expect(createWorld({}, fixture.dependencies)).rejects.toThrow('did not remain healthy')
  expect(clock.now()).toBe(5_000)
  expect(clock.sleeps).toHaveLength(100)
  expect(probeTimeouts).toHaveLength(100)
  expect(probeTimeouts.every((timeoutMs) => timeoutMs > 0 && timeoutMs <= 300)).toBe(true)
  expect(fixture.events).not.toContain('windows.open')
  expect(fixture.cliCalls).toEqual([])
  expect(existsSync(fixture.home)).toBe(false)
})

test('CLI files health rejects a positive probe if daemon or runtime identity changes during it', async () => {
  const createWorld = requireCliFilesFactory()
  for (const mutation of ['daemon-pid', 'runtime', 'process'] as const) {
    const fixture = cliFilesStandIns()
    installCliFilesHealthClock(fixture)
    let runtimePort = 43123
    let changedProcessIdentity = false
    const snapshot = fixture.dependencies.processSnapshot as () => Map<number, {
      pid: number; ppid: number; pgid: number; started: string; state: string; command: string
    }>
    fixture.dependencies.readRuntime = () => ({
      pid: fixture.state.runtimePid, home: fixture.home, port: runtimePort,
      token: 'fixture-token', hookToken: 'fixture-hook-token', entryHash: 'fixture-entry'
    })
    fixture.dependencies.processSnapshot = () => new Map([...fixture.state.livePids].map((pid) => {
      const identity = snapshot().get(pid)!
      return [pid, {
        ...identity,
        started: changedProcessIdentity && pid === 701 ? 'reused-701' : identity.started
      }] as const
    }))
    let probes = 0
    fixture.dependencies.isDaemonAlive = async () => {
      probes++
      if (probes === 2) {
        if (mutation === 'daemon-pid') fixture.state.runtimePid = 702
        else if (mutation === 'runtime') runtimePort++
        else changedProcessIdentity = true
      }
      return true
    }
    const world = await createWorld({}, fixture.dependencies)
    const argv = [process.execPath, world.cliEntry, 'api', '--runtime', 'local', '--json']
    try {
      await expect(world.execute(argv)).rejects.toThrow()
      expect(probes).toBe(2)
      expect(fixture.cliCalls).toEqual([])
    } finally {
      await world.cleanup()
    }
  }
})

test('CLI files health stops after interruption while a daemon probe is pending', async () => {
  const createWorld = requireCliFilesFactory()
  const fixture = cliFilesStandIns()
  installCliFilesHealthClock(fixture)
  const controller = new AbortController()
  const pendingProbe = Promise.withResolvers<boolean>()
  const probeStarted = Promise.withResolvers<void>()
  let probes = 0
  fixture.dependencies.isDaemonAlive = async () => {
    probes++
    probeStarted.resolve()
    return pendingProbe.promise
  }

  const opening = createWorld({ signal: controller.signal }, fixture.dependencies)
  await probeStarted.promise
  controller.abort(new Error('owned daemon health interrupted'))
  await expect(opening).rejects.toThrow('owned daemon health interrupted')
  pendingProbe.resolve(true)
  expect(probes).toBe(1)
  expect(fixture.events).not.toContain('windows.open')
  expect(fixture.cliCalls).toEqual([])
  expect(existsSync(fixture.home)).toBe(false)
})

test('CLI files health refuses a runtime that disappears during a successful probe', async () => {
  const fixture = cliFilesStandIns()
  const read = fixture.dependencies.readRuntime as () => unknown
  let vanished = false
  let ready = false
  fixture.dependencies.readRuntime = () => vanished ? null : read()
  fixture.dependencies.isDaemonAlive = async () => {
    if (ready) vanished = true
    return true
  }
  const world = await requireCliFilesFactory()({}, fixture.dependencies)
  ready = true
  try {
    await expect(world.execute([process.execPath, world.cliEntry, 'api', '--runtime', 'local', '--json']))
      .rejects.toMatchObject({ kind: 'daemon-exited' })
    expect(fixture.cliCalls).toEqual([])
  } finally { await world.cleanup() }
})
