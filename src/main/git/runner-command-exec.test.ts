import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { execFileMock, execFileSyncMock, spawnMock } = vi.hoisted(() => ({
  execFileMock: vi.fn(),
  execFileSyncMock: vi.fn(),
  spawnMock: vi.fn()
}))

vi.mock('node:child_process', () => ({
  execFile: execFileMock,
  execFileSync: execFileSyncMock,
  spawn: spawnMock
}))

import {
  commandExecFileAsync,
  ghExecFileAsync,
  gitExecFileAsync,
  glabExecFileAsync,
  gitStreamStdout
} from './runner'
import { _resetGitAdmissionForTests } from './command-runner/git-subprocess-admission'

afterEach(() => _resetGitAdmissionForTests())

type MockChildProcess = EventEmitter & {
  stdout: EventEmitter
  stderr: EventEmitter
  pid: number
  kill: ReturnType<typeof vi.fn>
  unref?: ReturnType<typeof vi.fn>
}

function createMockChildProcess(pid: number): MockChildProcess {
  const child = new EventEmitter() as MockChildProcess
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.pid = pid
  child.kill = vi.fn()
  return child
}

/**
 * Spawn stand-in for the gh/glab deadline tests: the CLI hangs, while the `ps`
 * quiescence probe the tree termination runs answers immediately.
 */
function mockWedgedCliSpawn(child: MockChildProcess): void {
  spawnMock.mockImplementation((program: string) => {
    if (program !== 'ps') {
      return child
    }
    const probe = createMockChildProcess(9100)
    queueMicrotask(() => probe.emit('close', 0, null))
    return probe
  })
}

/** Signals succeed; the existence probe reports the group already gone. */
function mockProcessGroupSignals(): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(process, 'kill').mockImplementation(((_pid: number, signal?: unknown) => {
    if (signal === 0) {
      throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' })
    }
    return true
  }) as typeof process.kill)
}

describe('runner execFile timeout handling', () => {
  beforeEach(() => {
    execFileMock.mockReset()
    spawnMock.mockReset()
    execFileSyncMock.mockReset()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('rejects command executions when execFile never calls back after timeout', async () => {
    const child = createMockChildProcess(1234)
    execFileMock.mockReturnValue(child)

    const promise = commandExecFileAsync('git', ['status'], {
      cwd: '/repo',
      timeout: 1000
    })
    const rejection = expect(promise).rejects.toThrow(/git(?:\.exe)? timed out\./i)
    await vi.advanceTimersByTimeAsync(1000)

    await rejection
    expect(child.kill).toHaveBeenCalled()
  })

  it('rejects git executions when execFile never calls back after timeout', async () => {
    const child = createMockChildProcess(1234)
    execFileMock.mockReturnValue(child)

    const promise = gitExecFileAsync(['status'], {
      cwd: '/repo',
      timeout: 1000
    })
    const rejection = expect(promise).rejects.toThrow('git timed out.')
    await vi.waitFor(() => expect(execFileMock).toHaveBeenCalledOnce())
    await vi.advanceTimersByTimeAsync(1000)

    await rejection
    expect(child.kill).toHaveBeenCalled()
  })

  it.skipIf(process.platform === 'win32')(
    'keeps a barrier Git abort pending until the process group closes',
    async () => {
      const child = createMockChildProcess(1234)
      spawnMock.mockImplementation((command: string) => {
        if (command !== 'ps') {
          return child
        }
        const probe = createMockChildProcess(4321)
        queueMicrotask(() => probe.emit('close', 0, null))
        return probe
      })
      const processKill = vi.spyOn(process, 'kill').mockImplementation(() => true)
      const controller = new AbortController()
      try {
        const pending = gitExecFileAsync(['status'], {
          cwd: '/repo',
          signal: controller.signal,
          terminationBarrier: true
        })
        let settled = false
        void pending.then(
          () => {
            settled = true
          },
          () => {
            settled = true
          }
        )

        await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled())
        controller.abort()
        child.emit('close', 0, null)
        await vi.advanceTimersByTimeAsync(1_999)
        expect(settled).toBe(false)
        await vi.advanceTimersByTimeAsync(1)
        expect(processKill).toHaveBeenCalledWith(-1234, 'SIGKILL')

        await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
      } finally {
        processKill.mockRestore()
      }
    }
  )

  // Why the group and not the child (#18234): `gh` and `glab` on PATH are often
  // shims, so the deadline has a chain to reap. Signalling only the direct child
  // leaves the rest of it running under init long after the deadline passed.
  it('signals the whole gh process group when gh never calls back', async () => {
    const child = createMockChildProcess(1234)
    mockWedgedCliSpawn(child)
    const processKill = mockProcessGroupSignals()
    try {
      const promise = ghExecFileAsync(['api', 'repos/stablyai/orca/issues/5388'], {
        cwd: '/repo'
      })
      const rejection = expect(promise).rejects.toThrow('gh timed out.')
      await vi.advanceTimersByTimeAsync(30_000)
      expect(spawnMock.mock.calls[0][2].detached).toBe(true)
      await vi.advanceTimersByTimeAsync(2_000)

      await rejection
      expect(processKill).toHaveBeenCalledWith(-1234, undefined)
    } finally {
      processKill.mockRestore()
    }
  })

  it('signals the whole glab process group when glab never calls back', async () => {
    const child = createMockChildProcess(1234)
    mockWedgedCliSpawn(child)
    const processKill = mockProcessGroupSignals()
    try {
      const promise = glabExecFileAsync(['api', 'projects/stablyai%2Fquirky/issues'], {
        cwd: '/repo'
      })
      const rejection = expect(promise).rejects.toThrow('glab timed out.')
      await vi.advanceTimersByTimeAsync(30_000)
      await vi.advanceTimersByTimeAsync(2_000)

      await rejection
      expect(processKill).toHaveBeenCalledWith(-1234, undefined)
    } finally {
      processKill.mockRestore()
    }
  })

  it('aborts glab retry backoff instead of starting another attempt', async () => {
    const controller = new AbortController()
    const transient = Object.assign(new Error('glab failed'), {
      stderr: 'HTTP 503 Service Unavailable'
    })
    spawnMock.mockImplementationOnce(() => {
      const child = createMockChildProcess(1234)
      queueMicrotask(() => {
        child.stderr.emit('data', Buffer.from(transient.stderr))
        child.emit('exit', 1, null)
        child.emit('close', 1, null)
      })
      return child
    })

    const promise = glabExecFileAsync(['api', 'projects'], {
      cwd: '/repo',
      signal: controller.signal
    })
    const rejection = expect(promise).rejects.toMatchObject({ name: 'AbortError' })
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(1))
    controller.abort()

    await rejection
    expect(spawnMock).toHaveBeenCalledTimes(1)
  })

  it('kills an active gh execution when its caller aborts', async () => {
    const child = createMockChildProcess(1234)
    mockWedgedCliSpawn(child)
    const processKill = mockProcessGroupSignals()
    try {
      const controller = new AbortController()
      const promise = ghExecFileAsync(['api', 'repos/stablyai/orca/issues/5388'], {
        cwd: '/repo',
        signal: controller.signal
      })
      const rejection = expect(promise).rejects.toMatchObject({ name: 'AbortError' })

      await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled())
      controller.abort()
      await vi.advanceTimersByTimeAsync(2_000)

      await rejection
      expect(processKill).toHaveBeenCalledWith(-1234, undefined)
    } finally {
      processKill.mockRestore()
    }
  })

  it('honors explicit gh timeouts', async () => {
    const child = createMockChildProcess(1234)
    mockWedgedCliSpawn(child)
    const processKill = mockProcessGroupSignals()
    try {
      const promise = ghExecFileAsync(['api', 'repos/stablyai/orca/issues/5388'], {
        cwd: '/repo',
        timeout: 1234
      })
      const rejection = expect(promise).rejects.toThrow('gh timed out.')
      await vi.advanceTimersByTimeAsync(1233)
      expect(processKill).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      await vi.advanceTimersByTimeAsync(2_000)

      await rejection
      expect(processKill).toHaveBeenCalledWith(-1234, undefined)
    } finally {
      processKill.mockRestore()
    }
  })

  it('runs gh non-interactively while preserving explicit env', async () => {
    let capturedEnv: NodeJS.ProcessEnv | undefined
    spawnMock.mockImplementation((_cmd, _args, opts) => {
      capturedEnv = opts.env
      const child = createMockChildProcess(1234)
      queueMicrotask(() => {
        child.stdout.emit('data', Buffer.from('ok'))
        child.emit('exit', 0, null)
        child.emit('close', 0, null)
      })
      return child
    })

    await ghExecFileAsync(['api', 'user'], {
      cwd: '/repo',
      env: { ...process.env, GH_PROMPT_DISABLED: '0', QUIRKY_TEST_ENV: 'kept' },
      timeout: 1234
    })

    expect(capturedEnv?.GH_PROMPT_DISABLED).toBe('0')
    expect(capturedEnv?.QUIRKY_TEST_ENV).toBe('kept')
  })

  // Issue #5308: git read-path calls must be forced non-interactive so a
  // credential / SSH host-key prompt fails fast instead of blocking forever on
  // stdin and wedging the serve runtime for all clients.
  it('runs git non-interactively so a prompt fails fast instead of hanging', async () => {
    const child = createMockChildProcess(1234)
    let capturedEnv: NodeJS.ProcessEnv | undefined
    execFileMock.mockImplementation((_cmd, _args, opts, cb) => {
      capturedEnv = opts.env
      cb(null, '', '')
      return child
    })

    await gitExecFileAsync(['worktree', 'list', '--porcelain', '-z'], {
      cwd: '/home5/Brian',
      env: { ...process.env, GIT_ASKPASS: undefined, SSH_ASKPASS: undefined }
    })

    expect(capturedEnv?.GIT_TERMINAL_PROMPT).toBe('0')
    expect(capturedEnv?.GIT_ASKPASS).toBe('')
    expect(capturedEnv?.SSH_ASKPASS).toBe('')
    expect(capturedEnv?.GIT_SSH_COMMAND).toContain('BatchMode=yes')
  })
})

describe('gitStreamStdout', () => {
  beforeEach(() => {
    spawnMock.mockReset()
  })

  it('streams chunks to onStdout and resolves cleanly on a zero exit', async () => {
    const child = createMockChildProcess(1234)
    spawnMock.mockReturnValue(child)

    const chunks: string[] = []
    const promise = gitStreamStdout(['status', '--porcelain=v2'], {
      cwd: '/repo',
      onStdout: (chunk) => {
        chunks.push(chunk)
      }
    })
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledOnce())
    child.stdout.emit('data', Buffer.from('? a.txt\n'))
    child.stdout.emit('data', Buffer.from('? b.txt\n'))
    child.emit('close', 0)

    await expect(promise).resolves.toEqual({ stoppedEarly: false })
    expect(chunks).toEqual(['? a.txt\n', '? b.txt\n'])
    expect(child.kill).not.toHaveBeenCalled()
  })

  it('kills git early and resolves stoppedEarly when onStdout requests a stop', async () => {
    const child = createMockChildProcess(1234)
    spawnMock.mockReturnValue(child)

    let calls = 0
    const promise = gitStreamStdout(['status'], {
      cwd: '/repo',
      // Stop after the first chunk — mirrors a parser hitting its entry limit.
      onStdout: () => {
        calls += 1
        return true
      }
    })
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledOnce())
    child.stdout.emit('data', Buffer.from('? a.txt\n'))

    await expect(promise).resolves.toEqual({ stoppedEarly: true })
    expect(child.kill).toHaveBeenCalled()
    expect(calls).toBe(1)
    child.emit('close', null, 'SIGTERM')
  })

  it('rejects when stdout exceeds the maxBuffer backstop', async () => {
    const child = createMockChildProcess(1234)
    spawnMock.mockReturnValue(child)

    const promise = gitStreamStdout(['status'], {
      cwd: '/repo',
      maxBuffer: 4,
      onStdout: () => {}
    })
    const rejection = expect(promise).rejects.toThrow('git stdout exceeded maxBuffer.')
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledOnce())
    child.stdout.emit('data', Buffer.from('way too much'))

    await rejection
    expect(child.kill).toHaveBeenCalled()
    child.emit('close', null, 'SIGTERM')
  })

  it('rejects on a non-zero exit with stderr context', async () => {
    const child = createMockChildProcess(1234)
    spawnMock.mockReturnValue(child)

    const promise = gitStreamStdout(['status'], { cwd: '/repo', onStdout: () => {} })
    const rejection = expect(promise).rejects.toThrow('git exited with 128')
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledOnce())
    child.stderr.emit('data', Buffer.from('fatal: not a git repository'))
    child.emit('close', 128)

    await rejection
  })

  it('rejects (not crashes) when the onStdout callback throws', async () => {
    const child = createMockChildProcess(1234)
    spawnMock.mockReturnValue(child)

    const promise = gitStreamStdout(['status'], {
      cwd: '/repo',
      onStdout: () => {
        throw new Error('parser blew up')
      }
    })
    const rejection = expect(promise).rejects.toThrow('parser blew up')
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledOnce())
    child.stdout.emit('data', Buffer.from('? a.txt\n'))

    await rejection
    expect(child.kill).toHaveBeenCalled()
    child.emit('close', null, 'SIGTERM')
  })

  it('handles a late spawn error after cancellation', async () => {
    const child = createMockChildProcess(0)
    spawnMock.mockReturnValue(child)
    const controller = new AbortController()

    const promise = gitStreamStdout(['status'], {
      cwd: '/repo',
      signal: controller.signal,
      onStdout: () => {}
    })
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledOnce())
    controller.abort()

    await expect(promise).rejects.toMatchObject({ name: 'AbortError' })
    expect(() => child.emit('error', new Error('spawn ENOENT'))).not.toThrow()
  })
})
