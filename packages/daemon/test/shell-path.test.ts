import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { spawnPty } from '../../pty-host/src/pty-process'
import { buildSessionEnv, commandArgv, installIntegrationFiles, shellArgv } from '../src/launch'
import { makeTempHome, waitFor } from './helpers'
import { createProcessScope, type ProcessScope } from '../../../scripts/test-support/process-scope'

let root: string
let userHome: string
let quirkyHome: string
let scope: ProcessScope

const started: { pid: number; kill(): void }[] = []
const bashBinary = resolve(process.env.QUIRKY_TEST_BASH ?? '/bin/bash')

beforeEach(() => {
  root = makeTempHome('qd-shell-')
  userHome = join(root, 'user')
  quirkyHome = join(root, 'q')
  scope = createProcessScope(quirkyHome)
  mkdirSync(userHome, { recursive: true })
  installIntegrationFiles(quirkyHome, '/opt/quirky/cli/main.ts')
})
afterEach(async () => {
  let failed = false
  let firstError: unknown
  for (const proc of started.splice(0)) {
    try {
      proc.kill()
    } catch (error) {
      if (!failed) firstError = error
      failed = true
    }
  }
  try {
    await scope.cleanup()
  } catch (error) {
    if (!failed) firstError = error
    failed = true
  }
  try {
    rmSync(root, { recursive: true, force: true })
  } catch (error) {
    if (!failed) firstError = error
    failed = true
  }
  if (failed) throw firstError
})

const RESET_PATH = 'export PATH=/usr/bin:/bin:/usr/sbin:/sbin'

function write(path: string, content: string) {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, content)
}

function sessionEnv(
  shell: string,
  agent: 'shell' | 'claude' = 'shell',
  extra: Record<string, string> = {},
  shellInit?: string
) {
  return buildSessionEnv({
    home: quirkyHome,
    sessionId: 's_test',
    worktreeId: 'wt_test',
    hookUrl: 'http://127.0.0.1:1/hook',
    hookToken: 'tok',
    shell,
    agent,
    ...(shellInit === undefined ? {} : { shellInit }),
    base: { HOME: userHome, PATH: '/usr/bin:/bin', SHELL: shell, ...extra }
  })
}

async function run(argv: string[], env: Record<string, string>) {
  const proc = scope.spawn(argv, { env, cwd: root, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  await proc.exited
  return { stdout: stdout.trim(), stderr }
}

const shimPath = () => join(quirkyHome, 'bin', 'quirky')

describe('command sessions', () => {
  test('the shim stays on PATH when ~/.zshenv resets it', async () => {
    write(join(userHome, '.zshenv'), RESET_PATH)
    const fakeBin = join(root, 'fakebin')
    write(join(fakeBin, 'claude'), '#!/bin/sh\ncommand -v quirky\n')
    chmodSync(join(fakeBin, 'claude'), 0o755)
    write(join(userHome, '.zprofile'), `${RESET_PATH}:${fakeBin}`)
    const argv = commandArgv(quirkyHome, '/bin/zsh', 'claude')
    const result = await run(argv, sessionEnv('/bin/zsh', 'claude'))
    expect(result.stdout).toBe(shimPath())
  })
})

describe('zsh shell sessions', () => {
  const interactiveArgv = () => [...shellArgv(quirkyHome, '/bin/zsh'), '-i', '-c']

  test('the shim is found when ~/.zshenv, .zprofile, .zshrc and .zlogin reset PATH', async () => {
    for (const file of ['.zshenv', '.zprofile', '.zshrc', '.zlogin']) write(join(userHome, file), RESET_PATH)
    const result = await run([...interactiveArgv(), 'command -v quirky'], sessionEnv('/bin/zsh'))
    expect(result.stdout).toBe(shimPath())
  })

  test('the shim is found when only ~/.zshenv resets PATH', async () => {
    write(join(userHome, '.zshenv'), RESET_PATH)
    const result = await run([...interactiveArgv(), 'command -v quirky'], sessionEnv('/bin/zsh'))
    expect(result.stdout).toBe(shimPath())
  })

  test('the bin dir comes first even when a user file already listed it later', async () => {
    write(join(userHome, '.zshrc'), `export PATH=/usr/bin:${join(quirkyHome, 'bin')}:/bin`)
    const result = await run([...interactiveArgv(), 'print -r -- ${path[1]}'], sessionEnv('/bin/zsh'))
    expect(result.stdout).toBe(join(quirkyHome, 'bin'))
  })

  test('user files run in order with the user ZDOTDIR and the wrapper is restored after', async () => {
    const log = join(root, 'log')
    for (const file of ['.zshenv', '.zprofile', '.zshrc', '.zlogin']) {
      write(join(userHome, file), `print -r -- "${file} ZDOTDIR=\${ZDOTDIR-unset}" >> ${log}`)
    }
    const result = await run([...interactiveArgv(), 'print -r -- "final ${ZDOTDIR-unset}"'], sessionEnv('/bin/zsh'))
    const lines = readFileSync(log, 'utf8').trim().split('\n')
    expect(lines).toEqual([
      `.zshenv ZDOTDIR=${userHome}`,
      `.zprofile ZDOTDIR=${userHome}`,
      `.zshrc ZDOTDIR=${userHome}`,
      `.zlogin ZDOTDIR=${userHome}`
    ])
    expect(result.stdout).toBe(`final ${userHome}`)
  })

  test('honours a custom ZDOTDIR and leaves HISTFILE with the user', async () => {
    const zdot = join(root, 'zd')
    write(join(zdot, '.zshenv'), RESET_PATH)
    const env = sessionEnv('/bin/zsh', 'shell', { ZDOTDIR: zdot })
    expect(env.QUIRKY_ORIG_ZDOTDIR).toBe(zdot)
    const result = await run([...interactiveArgv(), 'print -r -- "$HISTFILE|$(command -v quirky)"'], env)
    const [histfile, shim] = result.stdout.split('|')
    expect(shim).toBe(shimPath())
    expect(histfile?.startsWith(join(quirkyHome, 'shell'))).toBe(false)
  })

  test('a missing set of user files is fine', async () => {
    const result = await run([...interactiveArgv(), 'command -v quirky'], sessionEnv('/bin/zsh'))
    expect(result.stdout).toBe(shimPath())
  })
})

describe('bash shell sessions', () => {
  const interactiveArgv = () => [bashBinary, ...shellArgv(quirkyHome, '/bin/bash').slice(1), '-c']

  test('the shim is found when .bash_profile and .bashrc reset PATH', async () => {
    write(join(userHome, '.bash_profile'), RESET_PATH)
    write(join(userHome, '.bashrc'), RESET_PATH)
    const result = await run([...interactiveArgv(), 'command -v quirky'], sessionEnv(bashBinary))
    expect(result.stdout).toBe(shimPath())
  })

  test('falls back to ~/.profile and does not source .bashrc twice when the profile does', async () => {
    const log = join(root, 'log')
    write(join(userHome, '.profile'), `[ -f ~/.bashrc ] && . ~/.bashrc`)
    write(join(userHome, '.bashrc'), `echo rc >> ${log}\n${RESET_PATH}`)
    const result = await run([...interactiveArgv(), 'command -v quirky'], sessionEnv(bashBinary))
    expect(result.stdout).toBe(shimPath())
    expect(readFileSync(log, 'utf8').trim().split('\n')).toEqual(['rc'])
  })
})

describe('integration files', () => {
  test('writes the wrappers under <home>/shell', () => {
    for (const file of ['.zshenv', '.zprofile', '.zshrc', '.zlogin']) {
      expect(existsSync(join(quirkyHome, 'shell', 'zsh', file))).toBe(true)
    }
    expect(existsSync(join(quirkyHome, 'shell', 'bash', 'rcfile'))).toBe(true)
  })

  test('other shells keep the env PATH with the bin dir first', () => {
    const env = sessionEnv('/usr/bin/fish')
    expect(env.PATH).toBe(`${join(quirkyHome, 'bin')}:/usr/bin:/bin`)
    expect(env.ZDOTDIR).toBeUndefined()
  })

  test('refuses a missing plugin shell init file before launch', () => {
    expect(() => sessionEnv('/bin/bash', 'shell', {}, join(quirkyHome, 'accounts', 'shell-init'))).toThrow(
      'plugin shell init file is unavailable'
    )
  })
})

describe.each([
  ['zsh', '/bin/zsh', '.zshrc'],
  ['bash', bashBinary, '.bashrc']
] as const)('%s shell integration', (_name, shell, rcFile) => {
  const ESC = '\x1b'
  const BEL = '\x07'

  /** Starts the shell exactly as a session would, on a real PTY, and returns what it has printed so far. */
  function startInteractive(shellInit?: string, extra: Record<string, string> = {}, rcPrelude = '') {
    write(join(userHome, rcFile), `${rcPrelude}\nPS1='$ '\nexport QK_MARK=user-rc-ran\n`)
    mkdirSync(join(root, 'sub'), { recursive: true })
    let out = ''
    const decoder = new TextDecoder()
    const argv = shellArgv(quirkyHome, _name === 'bash' ? '/bin/bash' : shell)
    argv[0] = shell
    const proc = spawnPty(argv, {
      env: { ...sessionEnv(shell, 'shell', extra, shellInit), ...scope.env },
      cwd: root,
      cols: 100,
      rows: 30,
      onData: (data) => {
        out += decoder.decode(data, { stream: true })
      },
      onClose: () => {}
    })
    scope.track(proc.pid)
    started.push(proc)
    const count = (marker: string) => out.split(marker).length - 1
    const prompts = () => count(`${ESC}]133;A${BEL}`)
    return {
      proc,
      output: () => out,
      /** Types one line and waits for the next prompt to be drawn. */
      async run(line: string) {
        const before = prompts()
        proc.terminal.write(`${line}\r`)
        await waitFor(() => prompts() > before, 10000)
      },
      awaitShellReady: () => waitFor(() => out.includes(`${ESC}]777;quirky-shell-ready${BEL}`), 10000),
      finishedCodes: () => [...out.matchAll(new RegExp(`${ESC}\\]133;D;(\\d+)${BEL}`, 'g'))].map((m) => Number(m[1]))
    }
  }
  test('sources the trusted init after user rc once and routes every command through the current pointer', async () => {
    const pointer = join(root, 'active-home')
    const firstHome = join(root, 'account-a')
    const secondHome = join(root, 'account-b')
    const init = join(root, 'account-init')
    const initLog = join(root, 'init.log')
    write(pointer, `${firstHome}\n`)
    write(
      init,
      `if [ -z "\${__quirky_account_init_sourced-}" ]; then
  __quirky_account_init_sourced=1
  printf 'init:%s\\n' "\${QK_MARK-unset}" >> ${initLog}
  printf 'account-init-sourced\\n'
fi
claude() {
  if [ -n "\${CLAUDE_CONFIG_DIR-}" ]; then
    printf 'route:%s\\n' "$CLAUDE_CONFIG_DIR"
  else
    __target=$(cat "$QK_TEST_POINTER")
    ( export CLAUDE_CONFIG_DIR="$__target"; printf 'route:%s\\n' "$CLAUDE_CONFIG_DIR" )
  fi
}`
    )
    const session = startInteractive(init, { QK_TEST_POINTER: pointer })
    await session.awaitShellReady()

    const ready = session.output().indexOf(`${ESC}]777;quirky-shell-ready${BEL}`)
    const sourced = session.output().indexOf('account-init-sourced')
    expect(sourced).toBeGreaterThanOrEqual(0)
    expect(sourced).toBeLessThan(ready)
    expect(readFileSync(initLog, 'utf8').trim()).toBe('init:user-rc-ran')

    await session.run('claude')
    expect(session.output()).toContain(`route:${firstHome}`)
    write(pointer, `${secondHome}\n`)
    await session.run('claude')
    expect(session.output()).toContain(`route:${secondHome}`)

    const wrapper = shell.endsWith('zsh') ? join(quirkyHome, 'shell', 'zsh', '.zshrc') : join(quirkyHome, 'shell', 'bash', 'rcfile')
    await session.run(`. ${wrapper}`)
    expect(readFileSync(initLog, 'utf8').trim().split('\n')).toEqual(['init:user-rc-ran'])
    session.proc.terminal.write('exit\r')
    await session.proc.exited
  }, 30000)

  test('a shell user home override wins over dynamic account routing', async () => {
    const pointer = join(root, 'active-home')
    const customHome = join(root, 'custom-home')
    const init = join(root, 'account-init')
    write(pointer, `${join(root, 'account-a')}\n`)
    write(
      init,
      `claude() {
  if [ -n "\${CLAUDE_CONFIG_DIR-}" ]; then
    printf 'route:%s\\n' "$CLAUDE_CONFIG_DIR"
  else
    __target=$(cat "$QK_TEST_POINTER")
    ( export CLAUDE_CONFIG_DIR="$__target"; printf 'route:%s\\n' "$CLAUDE_CONFIG_DIR" )
  fi
}`
    )
    const session = startInteractive(init, { QK_TEST_POINTER: pointer, CLAUDE_CONFIG_DIR: customHome })
    await session.awaitShellReady()
    await session.run('claude')
    expect(session.output()).toContain(`route:${customHome}`)
    session.proc.terminal.write('exit\r')
    await session.proc.exited
  }, 30000)


  test('does not report completions for empty, whitespace, or Bash comment input', async () => {
    const session = startInteractive()
    await session.awaitShellReady()
    await session.run('false')
    expect(session.finishedCodes()).toEqual([1])
    for (const line of ['', '   ']) {
      const before = session.finishedCodes()
      await session.run(line)
      expect(session.finishedCodes()).toEqual(before)
    }
    if (_name === 'bash') {
      const before = session.finishedCodes()
      await session.run('# ignored comment')
      expect(session.finishedCodes()).toEqual(before)
    }
    session.proc.terminal.write('exit\r')
    await session.proc.exited
  }, 30000)

  test('reports each command status for identical and compound commands and keeps the exit status', async () => {
    const session = startInteractive()
    await session.awaitShellReady()
    await session.run('true')
    await session.run('false')
    await session.run('false')
    await session.run("sh -c 'exit 7'")
    await session.run('false && true')
    await session.run('cd sub && echo "rc=$QK_MARK"')
    session.proc.terminal.write('exit 3\r')
    expect(await session.proc.exited).toBe(3)

    const output = session.output()
    expect(output.split(`${ESC}]777;quirky-shell-ready${BEL}`).length - 1).toBe(1)
    expect(session.finishedCodes()).toEqual([0, 1, 1, 7, 1, 0])
    expect(output).toMatch(new RegExp(`${ESC}\\]7;file://[^${BEL}]*/sub${BEL}`))
    expect(output).toContain('rc=user-rc-ran')
  }, 30000)

  if (_name === 'bash') {
    test('does not treat inherited prompt DEBUG hooks as commands with functrace enabled', async () => {
      const session = startInteractive(undefined, {}, 'set -T')
      await session.awaitShellReady()
      const starts = () => session.output().split(`${ESC}]133;C${BEL}`).length - 1
      expect(session.finishedCodes()).toEqual([])
      expect(starts()).toBe(0)
      for (const line of ['', '   ', '# no command']) {
        await session.run(line)
        expect(session.finishedCodes()).toEqual([])
        expect(starts()).toBe(0)
      }
      await session.run('false')
      await session.run('')
      expect(session.finishedCodes()).toEqual([1])
      expect(starts()).toBe(1)
      await session.run('false')
      await session.run('set +o history')
      await session.run("sh -c 'exit 7'")
      expect(session.finishedCodes()).toEqual([1, 1, 0, 7])
      expect(starts()).toBe(4)
      await session.run('qk_fail() { return 9; }; qk_fail')
      await session.run('')
      expect(session.finishedCodes()).toEqual([1, 1, 0, 7, 9])
      expect(starts()).toBe(5)
      session.proc.terminal.write('exit 3\r')
      expect(await session.proc.exited).toBe(3)
    }, 30000)

    test('reports the status of a command ignored by Bash history', async () => {
      const session = startInteractive(undefined, { HISTCONTROL: 'ignorespace' })
      await session.awaitShellReady()
      // No user DEBUG trap is installed; this exercises the integration-owned trap path.
      await session.run(' false')
      expect(session.finishedCodes()).toEqual([1])
      session.proc.terminal.write('exit\r')
      await session.proc.exited
    }, 30000)

    test('reports accurate statuses with Bash history disabled', async () => {
      const session = startInteractive()
      await session.awaitShellReady()
      await session.run('set +o history')
      await session.run("sh -c 'exit 7'")
      expect(session.finishedCodes()).toEqual([0, 7])
      const before = session.finishedCodes()
      await session.run('')
      expect(session.finishedCodes()).toEqual(before)
      session.proc.terminal.write('exit\r')
      await session.proc.exited
    }, 30000)
  }

  test('sourcing the wrapper again does not repeat the reports', async () => {
    const session = startInteractive()
    await session.awaitShellReady()
    const wrapper = shell.endsWith('zsh') ? join(quirkyHome, 'shell', 'zsh', '.zshrc') : join(quirkyHome, 'shell', 'bash', 'rcfile')
    await session.run(`. ${wrapper}`)
    await session.run('true')
    expect(session.finishedCodes()).toEqual([0, 0])
    session.proc.terminal.write('exit\r')
    await session.proc.exited
  }, 30000)
})
