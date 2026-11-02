import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { spawnPty } from '../../pty-host/src/pty-process'
import { buildSessionEnv, commandArgv, installIntegrationFiles, shellArgv } from '../src/launch'
import { InteractivePath, readInteractivePath } from '../src/interactive-path'
import { makeTempHome, waitFor } from './helpers'
import daemonPackage from '../package.json'
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

describe('inherited agent session markers', () => {
  test('a session does not inherit the markers of the Claude Code session that started Quirky', () => {
    const env = sessionEnv('/bin/zsh', 'shell', {
      CLAUDECODE: '1',
      CLAUDE_CODE_CHILD_SESSION: '1',
      CLAUDE_CODE_ENTRYPOINT: 'cli',
      CLAUDE_CODE_SESSION_ID: 'abc',
      CLAUDE_CODE_MESSAGING_TOKEN: 'secret',
      CLAUDE_PID: '42',
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: '64000'
    })
    // FORCE_SYNC_OUTPUT is Quirky's own, not inherited
    expect(Object.keys(env).filter((key) => key.startsWith('CLAUDE'))).toEqual(['CLAUDE_CODE_MAX_OUTPUT_TOKENS', 'CLAUDE_CODE_FORCE_SYNC_OUTPUT'])
  })
})

describe('terminal identity', () => {
  test('a session names Quirky as its terminal, not the terminal that started the daemon', () => {
    const env = sessionEnv('/bin/zsh', 'shell', { TERM_PROGRAM: 'Orca', TERM_PROGRAM_VERSION: '1.4.234' })
    expect(env.TERM_PROGRAM).toBe('Quirky')
    expect(env.TERM_PROGRAM_VERSION).toBe(daemonPackage.version)
  })

  test('Claude Code wraps its frames in synchronized output even though Quirky does not answer XTVERSION', () => {
    expect(sessionEnv('/bin/zsh', 'claude').CLAUDE_CODE_FORCE_SYNC_OUTPUT).toBe('1')
  })
})

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

describe('command sessions with the interactive shell PATH', () => {
  const userEnv = (shell: string) => ({ HOME: userHome, PATH: '/usr/bin:/bin', SHELL: shell })
  const rcBin = () => join(root, 'rc-bin')

  function installRcTool() {
    write(join(rcBin(), 'tool'), '#!/bin/sh\necho from-rc\n')
    chmodSync(join(rcBin(), 'tool'), 0o755)
  }

  test('a zsh command session finds a CLI that ~/.zshrc puts on PATH', async () => {
    installRcTool()
    write(join(userHome, '.zshrc'), `export PATH=${rcBin()}:$PATH`)
    const path = await readInteractivePath(quirkyHome, '/bin/zsh', userEnv('/bin/zsh'))
    const result = await run(commandArgv(quirkyHome, '/bin/zsh', 'tool', path), sessionEnv('/bin/zsh', 'claude'))
    expect(result.stdout).toBe('from-rc')
  })

  test('a bash command session finds a CLI that ~/.bashrc puts on PATH', async () => {
    installRcTool()
    write(join(userHome, '.bashrc'), `export PATH=${rcBin()}:$PATH`)
    const path = await readInteractivePath(quirkyHome, bashBinary, userEnv(bashBinary))
    const result = await run(commandArgv(quirkyHome, bashBinary, 'tool', path), sessionEnv(bashBinary, 'claude'))
    expect(result.stdout).toBe('from-rc')
  })

  test('output from rc files does not end up in the PATH', async () => {
    write(join(userHome, '.zshrc'), `echo noise\nexport PATH=${rcBin()}:$PATH\nprintf 'more noise'`)
    const path = await readInteractivePath(quirkyHome, '/bin/zsh', userEnv('/bin/zsh'))
    expect(path?.split(':')[0]).toBe(rcBin())
    expect(path).not.toContain('noise')
  })

  test('the bin dir comes first, then the interactive PATH without it', async () => {
    const bin = join(quirkyHome, 'bin')
    const argv = commandArgv(quirkyHome, '/bin/zsh', 'printenv PATH', `/usr/bin:${bin}:/bin`)
    const result = await run(argv, sessionEnv('/bin/zsh', 'claude'))
    expect(result.stdout.startsWith(`${bin}:/usr/bin:/bin:`)).toBe(true)
  })

  test('a CLI the login shell finds still resolves when the interactive PATH lacks it', async () => {
    const loginBin = join(root, 'login-bin')
    write(join(loginBin, 'tool'), '#!/bin/sh\necho from-login\n')
    chmodSync(join(loginBin, 'tool'), 0o755)
    write(join(userHome, '.zprofile'), `export PATH=${loginBin}:$PATH`)
    const result = await run(commandArgv(quirkyHome, '/bin/zsh', 'tool', '/usr/bin:/bin'), sessionEnv('/bin/zsh', 'claude'))
    expect(result.stdout).toBe('from-login')
  })

  const gone = (pid: number) => () => {
    try {
      process.kill(pid, 0)
      return false
    } catch {
      return true
    }
  }

  test('a shell that keeps running after printing its PATH is stopped at the timeout', async () => {
    const pidFile = join(root, 'logout.pid')
    write(join(userHome, '.zshrc'), `export PATH=${rcBin()}:$PATH`)
    write(join(userHome, '.zlogout'), `echo $$ > ${pidFile}\nsleep 30`)
    const path = await readInteractivePath(quirkyHome, '/bin/zsh', userEnv('/bin/zsh'), { timeoutMs: 3000 })
    expect(path?.split(':')[0]).toBe(rcBin())
    const pid = await waitFor(() => existsSync(pidFile) && Number(readFileSync(pidFile, 'utf8').trim()), 5000)
    await waitFor(gone(pid), 5000)
  })

  test('a shell that closes stdout before printing its PATH is stopped at the timeout', async () => {
    const pidFile = join(root, 'rc.pid')
    write(join(userHome, '.zshrc'), `exec >/dev/null\necho $$ > ${pidFile}\nsleep 30`)
    expect(await readInteractivePath(quirkyHome, '/bin/zsh', userEnv('/bin/zsh'), { timeoutMs: 3000 })).toBeUndefined()
    const pid = await waitFor(() => existsSync(pidFile) && Number(readFileSync(pidFile, 'utf8').trim()), 5000)
    await waitFor(gone(pid), 5000)
  })

  test('gives up on a shell that does not finish in time and stops it', async () => {
    const pidFile = join(root, 'rc.pid')
    write(join(userHome, '.zshrc'), `echo $$ > ${pidFile}\nsleep 30`)
    const startedAt = Date.now()
    expect(await readInteractivePath(quirkyHome, '/bin/zsh', userEnv('/bin/zsh'), { timeoutMs: 3000 })).toBeUndefined()
    expect(Date.now() - startedAt).toBeLessThan(10000)
    const pid = Number(readFileSync(pidFile, 'utf8').trim())
    await waitFor(() => {
      try {
        process.kill(pid, 0)
        return false
      } catch {
        return true
      }
    })
  })

  test('a shell without startup-file support is not probed', async () => {
    expect(await readInteractivePath(quirkyHome, '/usr/bin/fish', userEnv('/usr/bin/fish'))).toBeUndefined()
  })

  describe('cache', () => {
    const caches: InteractivePath[] = []
    afterEach(() => {
      for (const cache of caches.splice(0)) cache.dispose()
    })
    const cache = (shell: string, options: { maxAgeMs?: number; timeoutMs?: number } = {}) => {
      const created = new InteractivePath({ home: quirkyHome, shell, env: userEnv(shell), ...options })
      caches.push(created)
      return created
    }

    test('a PATH read once is kept under the home for the next daemon', async () => {
      write(join(userHome, '.zshrc'), `export PATH=${rcBin()}:$PATH`)
      const first = cache('/bin/zsh')
      expect(first.current()).toBeUndefined()
      await first.refresh()
      expect(first.current()?.split(':')[0]).toBe(rcBin())

      expect(cache('/bin/zsh').current()?.split(':')[0]).toBe(rcBin())
      expect(cache(bashBinary).current()).toBeUndefined()
    })

    test('a stale PATH is refreshed in the background when it is used', async () => {
      write(join(userHome, '.zshrc'), `export PATH=${rcBin()}:$PATH`)
      const stale = cache('/bin/zsh', { maxAgeMs: 0 })
      await stale.refresh()
      const changed = join(root, 'changed-bin')
      write(join(userHome, '.zshrc'), `export PATH=${changed}:$PATH`)
      expect(stale.current()?.split(':')[0]).toBe(rcBin())
      await waitFor(() => stale.current()?.split(':')[0] === changed, 10000)
    })

    test('dispose stops a running read', async () => {
      const pidFile = join(root, 'rc.pid')
      write(join(userHome, '.zshrc'), `echo $$ > ${pidFile}\nsleep 30`)
      const running = cache('/bin/zsh')
      const refreshed = running.refresh()
      const pid = await waitFor(() => existsSync(pidFile) && Number(readFileSync(pidFile, 'utf8').trim()), 5000)
      running.dispose()
      await refreshed
      expect(running.current()).toBeUndefined()
      await waitFor(() => {
        try {
          process.kill(pid, 0)
          return false
        } catch {
          return true
        }
      })
    })

    test('a failed refresh keeps the last PATH', async () => {
      write(join(userHome, '.zshrc'), `export PATH=${rcBin()}:$PATH`)
      const kept = cache('/bin/zsh', { timeoutMs: 3000 })
      await kept.refresh()
      write(join(userHome, '.zshrc'), 'sleep 30')
      await kept.refresh()
      expect(kept.current()?.split(':')[0]).toBe(rcBin())
    })
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
    // bash 5.1 runs every element of an array PROMPT_COMMAND, so one left after the arm step looks like a user command
    test('does not report a command for PROMPT_COMMAND array elements a profile added', async () => {
      const session = startInteractive(undefined, {}, `__qk_ran_element() { QK_ELEMENT=1; }\nPROMPT_COMMAND=('' __qk_ran_element)`)
      await session.awaitShellReady()
      const starts = () => session.output().split(`${ESC}]133;C${BEL}`).length - 1
      expect(starts()).toBe(0)
      await session.run('')
      expect(starts()).toBe(0)
      expect(session.finishedCodes()).toEqual([])
      await session.run('printf "element=%s\\n" "$QK_ELEMENT"')
      expect(session.output()).toContain('element=1')
      expect(session.finishedCodes()).toEqual([0])
    }, 30000)

    // systemd's shell profile sets PS0 to a command substitution, which inherits DEBUG under functrace
    test('does not report a command for a PS0 command substitution with functrace enabled', async () => {
      const session = startInteractive(undefined, {}, `set -T\nPS0='$(true)'`)
      await session.awaitShellReady()
      const starts = () => session.output().split(`${ESC}]133;C${BEL}`).length - 1
      await session.run('')
      expect(starts()).toBe(0)
      await session.run('false')
      expect(starts()).toBe(1)
      expect(session.finishedCodes()).toEqual([1])
    }, 30000)

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
