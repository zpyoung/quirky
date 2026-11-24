import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as loginShell from '../startup/login-shell-environment'
import type * as runProcessModule from '@quirky/process-host'
import { resolveAgainAfterRefreshOnMissingProgram } from '../native-chat/structured-agent-command-resolution'
import {
  createStructuredAgentEnvironmentResolvers,
  structuredAgentBaseEnvironment
} from './structured-agent-shell-environment'

const { runProcessMock, spawnProcessMock } = vi.hoisted(() => ({
  runProcessMock: vi.fn(),
  spawnProcessMock: vi.fn()
}))

vi.mock('@quirky/process-host', async (importOriginal) => {
  const real = await importOriginal<typeof runProcessModule>()
  return {
    ...real,
    runProcess: runProcessMock,
    // Unmocked calls spawn for real, so a stub login shell runs through the production capture.
    spawnProcess: (...args: Parameters<typeof real.spawnProcess>) =>
      spawnProcessMock(...args) ?? real.spawnProcess(...args)
  }
})

const INHERIT_ALL = { inheritAll: true, names: [] }

afterEach(loginShell.resetLoginShellEnvironmentCacheForTests)

const shellEnv = {
  PATH: '/shell/bin',
  LANG: 'en_US.UTF-8',
  SSH_AUTH_SOCK: '/tmp/agent.sock',
  CODEX_LB_API_KEY: 'lb-key',
  ANTHROPIC_API_KEY: 'shell-key',
  CLAUDE_CONFIG_DIR: '/shell/claude',
  UNSET: undefined
}

const processEnv = { PATH: '/quirky/bin', HOME: '/home/me', QUIRKY_USER_DATA_PATH: '/quirky' }

describe('structuredAgentBaseEnvironment', () => {
  it('is the whole shell snapshot, and nothing else, when inheriting all', () => {
    expect(
      structuredAgentBaseEnvironment({
        shellEnv,
        policy: INHERIT_ALL,
        processEnv,
        platform: 'darwin'
      })
    ).toEqual({
      PATH: '/shell/bin',
      LANG: 'en_US.UTF-8',
      SSH_AUTH_SOCK: '/tmp/agent.sock',
      CODEX_LB_API_KEY: 'lb-key',
      ANTHROPIC_API_KEY: 'shell-key',
      CLAUDE_CONFIG_DIR: '/shell/claude'
    })
  })

  it('passes only the baseline and listed shell names over Quirky env when off', () => {
    expect(
      structuredAgentBaseEnvironment({
        shellEnv,
        policy: { inheritAll: false, names: ['CODEX_LB_API_KEY'] },
        processEnv,
        platform: 'darwin'
      })
    ).toEqual({
      PATH: '/shell/bin',
      HOME: '/home/me',
      QUIRKY_USER_DATA_PATH: '/quirky',
      LANG: 'en_US.UTF-8',
      SSH_AUTH_SOCK: '/tmp/agent.sock',
      CODEX_LB_API_KEY: 'lb-key'
    })
  })
})

describe('createStructuredAgentEnvironmentResolvers', () => {
  it.skipIf(process.platform === 'win32')(
    'keeps the last good snapshot when a later login-shell capture fails',
    async () => {
      const dir = await mkdtemp(join(tmpdir(), 'quirky-structured-shell-env-'))
      const counter = join(dir, 'count')
      const shell = join(dir, 'shell.sh')
      // Run 1 has the profile PATH, run 2 fails like a timed-out or broken profile, later runs succeed.
      await writeFile(
        shell,
        [
          '#!/bin/sh',
          `n=$(cat '${counter}' 2>/dev/null || echo 0); n=$((n+1)); echo $n > '${counter}'`,
          'case $n in 1) p=/profile/A ;; 2) exit 1 ;; *) p=/profile/B ;; esac',
          'printf \'\\000__QUIRKY_LOGIN_SHELL_ENV_START__\\000PATH=%s\\000\\000__QUIRKY_LOGIN_SHELL_ENV_END__\\000\' "$p"',
          ''
        ].join('\n')
      )
      await chmod(shell, 0o755)
      const originalShell = process.env.SHELL
      process.env.SHELL = shell
      vi.useFakeTimers({ toFake: ['Date'] })
      try {
        const resolvers = createStructuredAgentEnvironmentResolvers({
          resolveShellEnvironmentPolicy: () => INHERIT_ALL
        })
        expect((await resolvers.resolveBaseEnvironment()).PATH).toBe('/profile/A')
        const served: (string | undefined)[] = []
        for (let start = 0; start < 200 && served.at(-1) !== '/profile/B'; start += 1) {
          // Every start is past the TTL, so each one after a refresh settles starts the next run.
          vi.advanceTimersByTime(10_000)
          served.push((await resolvers.resolveBaseEnvironment()).PATH)
          await new Promise((resolve) => setTimeout(resolve, 20))
        }
        expect(Number(await readFile(counter, 'utf8'))).toBeGreaterThanOrEqual(3)
        expect(served.at(-1)).toBe('/profile/B')
        // The failed run never served Quirky's own env in place of the profile's.
        expect(served.filter((path) => path !== '/profile/A' && path !== '/profile/B')).toEqual([])
      } finally {
        vi.useRealTimers()
        if (originalShell === undefined) {
          delete process.env.SHELL
        } else {
          process.env.SHELL = originalShell
        }
        loginShell.resetLoginShellEnvironmentCacheForTests()
        await rm(dir, { recursive: true, force: true })
      }
    }
  )

  it.skipIf(process.platform === 'win32')(
    'shares the login-shell run an earlier reader started instead of running the shell again',
    async () => {
      const dir = await mkdtemp(join(tmpdir(), 'quirky-structured-shell-runs-'))
      const counter = join(dir, 'count')
      const shell = join(dir, 'shell.sh')
      await writeFile(
        shell,
        [
          '#!/bin/sh',
          `echo run >> '${counter}'`,
          "printf '\\000__QUIRKY_LOGIN_SHELL_ENV_START__\\000PATH=/profile/bin\\000\\000__QUIRKY_LOGIN_SHELL_ENV_END__\\000'",
          ''
        ].join('\n')
      )
      await chmod(shell, 0o755)
      const originalShell = process.env.SHELL
      process.env.SHELL = shell
      try {
        // Startup readers such as the Claude account router capture before the runtime exists.
        const early = loginShell.resolveLoginShellEnvironment()
        const resolvers = createStructuredAgentEnvironmentResolvers({
          resolveShellEnvironmentPolicy: () => INHERIT_ALL
        })
        expect((await resolvers.resolveBaseEnvironment()).PATH).toBe('/profile/bin')
        expect((await early).PATH).toBe('/profile/bin')
        expect((await readFile(counter, 'utf8')).trim().split('\n')).toHaveLength(1)
      } finally {
        if (originalShell === undefined) {
          delete process.env.SHELL
        } else {
          process.env.SHELL = originalShell
        }
        loginShell.resetLoginShellEnvironmentCacheForTests()
        await rm(dir, { recursive: true, force: true })
      }
    }
  )

  it.skipIf(process.platform === 'win32')(
    'retries a launch on a shell run started after it looked, not on one that predates an install',
    async () => {
      const dir = await mkdtemp(join(tmpdir(), 'quirky-structured-shell-install-'))
      const [counter, pathFile, hold, shell] = ['count', 'path', 'hold', 'shell.sh'].map((name) =>
        join(dir, name)
      )
      // Run 2 reads PATH, then waits while `hold` exists: a background rerun still going.
      await writeFile(
        shell,
        [
          '#!/bin/sh',
          `echo run >> '${counter}'; n=$(wc -l < '${counter}'); p=$(cat '${pathFile}')`,
          `if [ $n -eq 2 ]; then while [ -f '${hold}' ]; do sleep 0.02; done; fi`,
          'printf \'\\000__QUIRKY_LOGIN_SHELL_ENV_START__\\000PATH=%s\\000\\000__QUIRKY_LOGIN_SHELL_ENV_END__\\000\' "$p"',
          ''
        ].join('\n')
      )
      await chmod(shell, 0o755)
      await writeFile(pathFile, '/old')
      const originalShell = process.env.SHELL
      process.env.SHELL = shell
      vi.useFakeTimers({ toFake: ['Date'] })
      try {
        const resolvers = createStructuredAgentEnvironmentResolvers({
          resolveShellEnvironmentPolicy: () => INHERIT_ALL
        })
        expect((await resolvers.resolveBaseEnvironment()).PATH).toBe('/old')
        await writeFile(hold, '')
        vi.advanceTimersByTime(10_000)
        await resolvers.resolveBaseEnvironment()
        await vi.waitFor(async () =>
          expect((await readFile(counter, 'utf8')).trim().split('\n')).toHaveLength(2)
        )
        await writeFile(pathFile, '/installed')
        vi.advanceTimersByTime(1)
        const launch = resolveAgainAfterRefreshOnMissingProgram(
          async () => {
            const { PATH } = await resolvers.resolveBaseEnvironment()
            return { command: PATH === '/installed' ? '/installed/agent' : 'agent', PATH }
          },
          resolvers.refreshAfterMissingProgram,
          { env: ({ PATH }) => ({ PATH }) }
        )
        await new Promise((resolve) => setTimeout(resolve, 300))
        await rm(hold, { force: true })
        expect((await launch).command).toBe('/installed/agent')
      } finally {
        vi.useRealTimers()
        if (originalShell === undefined) {
          delete process.env.SHELL
        } else {
          process.env.SHELL = originalShell
        }
        await rm(dir, { recursive: true, force: true })
      }
    }
  )

  it.skipIf(process.platform === 'win32')(
    'holds a miss for at most one shell timeout when the login shell hangs, keeping the snapshot',
    async () => {
      const dir = await mkdtemp(join(tmpdir(), 'quirky-structured-shell-hang-'))
      const [counter, shell] = ['count', 'shell.sh'].map((name) => join(dir, name))
      // Run 1 answers; every later run hangs, as a profile stuck on a prompt does.
      await writeFile(
        shell,
        [
          '#!/bin/sh',
          `echo run >> '${counter}'; n=$(wc -l < '${counter}')`,
          'if [ $n -gt 1 ]; then exec sleep 30; fi',
          "printf '\\000__QUIRKY_LOGIN_SHELL_ENV_START__\\000PATH=/profile/A\\000\\000__QUIRKY_LOGIN_SHELL_ENV_END__\\000'",
          ''
        ].join('\n')
      )
      await chmod(shell, 0o755)
      const originalShell = process.env.SHELL
      process.env.SHELL = shell
      try {
        const resolvers = createStructuredAgentEnvironmentResolvers({
          resolveShellEnvironmentPolicy: () => INHERIT_ALL
        })
        expect((await resolvers.resolveBaseEnvironment()).PATH).toBe('/profile/A')
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
        let released = false
        void resolvers.refreshAfterMissingProgram(Date.now()).then(() => {
          released = true
        })
        await vi.advanceTimersByTimeAsync(4_999)
        expect(released).toBe(false)
        await vi.advanceTimersByTimeAsync(1)
        expect(released).toBe(true)
        expect((await resolvers.resolveBaseEnvironment()).PATH).toBe('/profile/A')
      } finally {
        vi.useRealTimers()
        if (originalShell === undefined) {
          delete process.env.SHELL
        } else {
          process.env.SHELL = originalShell
        }
        await rm(dir, { recursive: true, force: true })
      }
    },
    // Real shell spawns; a loaded runner can take seconds for the first one.
    20_000
  )

  it('rereads settings on every acquisition while the shell env is read once', async () => {
    let overlay = 'A'
    const resolveEnvironment = vi.fn(async () => ({ PATH: '/shell/A' }))
    const resolvers = createStructuredAgentEnvironmentResolvers({
      resolveEnvironment,
      resolveShellEnvironmentPolicy: () => INHERIT_ALL,
      resolveAgentLaunchEnv: () => ({ CURRENT_SETTING: overlay })
    })
    expect(await resolvers.resolveAgentEnvironment('codex')).toEqual({
      PATH: '/shell/A',
      CURRENT_SETTING: 'A'
    })
    overlay = 'B'
    expect(await resolvers.resolveAgentEnvironment('codex')).toEqual({
      PATH: '/shell/A',
      CURRENT_SETTING: 'B'
    })
    expect(resolveEnvironment).toHaveBeenCalledOnce()
  })

  it("gives every agent the same base, with each agent's own overlay on it", async () => {
    const resolvers = createStructuredAgentEnvironmentResolvers({
      resolveEnvironment: async () => ({ PATH: '/shell/bin', SHELL_ONLY: '1' }),
      resolveShellEnvironmentPolicy: () => INHERIT_ALL,
      resolveAgentLaunchEnv: (agent): Record<string, string> =>
        agent === 'codex' ? { CODEX_PROFILE: 'p' } : {}
    })
    expect(await resolvers.resolveBaseEnvironment()).toEqual({
      PATH: '/shell/bin',
      SHELL_ONLY: '1'
    })
    expect(await resolvers.resolveAgentEnvironment('claude')).toEqual({
      PATH: '/shell/bin',
      SHELL_ONLY: '1'
    })
    expect(await resolvers.resolveAgentEnvironment('codex')).toEqual({
      PATH: '/shell/bin',
      SHELL_ONLY: '1',
      CODEX_PROFILE: 'p'
    })
  })
})
