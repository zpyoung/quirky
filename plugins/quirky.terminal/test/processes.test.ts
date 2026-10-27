import { afterEach, describe, expect, test } from 'bun:test'
import { defaultPs, parsePsOutput, runningChildOf, type ProcessRow } from '../src/processes'

const TABLE = `    1     0 /sbin/launchd
  100     1 /usr/bin/login
  101   100 -zsh
  250   101 /bin/sleep
  251   101 /usr/bin/vim
  300     1 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome
  301   300 /Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Helper
`

describe('parsePsOutput', () => {
  test('reads pid, ppid and the command basename', () => {
    expect(parsePsOutput(TABLE).slice(0, 4)).toEqual([
      { pid: 1, ppid: 0, command: 'launchd' },
      { pid: 100, ppid: 1, command: 'login' },
      { pid: 101, ppid: 100, command: '-zsh' },
      { pid: 250, ppid: 101, command: 'sleep' }
    ])
  })

  test('keeps commands whose path contains spaces', () => {
    expect(parsePsOutput(TABLE).filter((r) => r.pid >= 300)).toEqual([
      { pid: 300, ppid: 1, command: 'Google Chrome' },
      { pid: 301, ppid: 300, command: 'Google Chrome Helper' }
    ])
  })

  test('skips blank and malformed lines', () => {
    expect(parsePsOutput('\n  12 3\nPID PPID COMM\nx y z\n  7 1 /bin/ok\n')).toEqual([{ pid: 7, ppid: 1, command: 'ok' }])
    expect(parsePsOutput('')).toEqual([])
  })
})

describe('runningChildOf', () => {
  test('returns the first direct child with its command basename', () => {
    expect(runningChildOf(101, () => TABLE)).toEqual({ command: 'sleep' })
  })

  test('grandchildren do not count', () => {
    expect(runningChildOf(1, () => '1 0 /sbin/launchd\n2 1 /bin/zsh\n3 2 /bin/sleep\n')).toEqual({ command: 'zsh' })
    expect(runningChildOf(250, () => TABLE)).toBeNull()
  })

  test('a process with no children, or an unknown one, has none', () => {
    expect(runningChildOf(300000, () => TABLE)).toBeNull()
  })

  test('any failure reading the table gives null', () => {
    expect(
      runningChildOf(101, () => {
        throw new Error('no ps')
      })
    ).toBeNull()
  })

  const started: Bun.Subprocess[] = []
  afterEach(() => {
    for (const child of started.splice(0)) child.kill('SIGKILL')
  })

  test('a real ps call sees the sleep this test started as its child', async () => {
    const sleeper = Bun.spawn(['sleep', '30'], { stdio: ['ignore', 'ignore', 'ignore'] })
    started.push(sleeper)
    let row: ProcessRow | undefined
    for (let i = 0; i < 40 && row?.command !== 'sleep'; i++) {
      row = parsePsOutput(defaultPs()).find((r) => r.pid === sleeper.pid)
      if (row?.command !== 'sleep') await Bun.sleep(25)
    }
    expect(row).toEqual({ pid: sleeper.pid, ppid: process.pid, command: 'sleep' })
    expect(runningChildOf(process.pid)).not.toBeNull()
  })

  test('a real ps call names the child of a shell', async () => {
    const shell = Bun.spawn(['/bin/sh', '-c', 'sleep 30 & wait'], { stdio: ['ignore', 'ignore', 'ignore'] })
    started.push(shell)
    let found: { command: string } | null = null
    for (let i = 0; i < 40 && !found; i++) {
      found = runningChildOf(shell.pid)
      if (!found) await Bun.sleep(25)
    }
    expect(found).toEqual({ command: 'sleep' })
    shell.kill('SIGKILL')
    await shell.exited
    expect(runningChildOf(shell.pid)).toBeNull()
  })
})
