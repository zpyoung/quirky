import { expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { delimiter, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { createCliEnvironment } from './cli-world'
import { installCliFixtureTools } from './cli-fixtures'
import { parseActorReceipt, quotePosixShellLiteral } from './cli-actor'

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
