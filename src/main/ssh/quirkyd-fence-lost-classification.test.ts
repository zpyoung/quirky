import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ClientChannel } from 'ssh2'
import { execQuirkydStateMutation } from '../managed-server/host-state/quirkyd-state-mutation-exec'
import {
  execQuirkydRemote,
  execQuirkydRemoteOr
} from '../managed-server/install/quirkyd-remote-runtime-control'
import {
  QUIRKYD_FENCE_LOST_MARKER,
  QuirkydFenceLostError,
  isQuirkydFenceLost,
  posixQuirkydFenceGuard,
  runWithQuirkydFence
} from '../managed-server/activation/quirkyd-activation-fence-scope'
import {
  isUnconfirmedSshCommandTermination,
  sshCommandExitError
} from './remote-exec/remote-exec-command'
import { getRemoteHostPlatform } from './ssh-remote-platform'
import type { QuirkydHostTransport } from './quirkyd-host-transport'

/** An ssh2 exec channel; the host never acknowledges a close, as when the link is down. */
class HostChannel extends EventEmitter {
  readonly stderr = Object.assign(new EventEmitter(), { resume: () => {} })
  readonly stdin = this
  close(): void {}
  resume(): void {}
  exit(code: number, stdout: string): void {
    this.emit('data', Buffer.from(stdout))
    this.emit('close', code)
  }
}

let channel: HostChannel
const commands: string[] = []
const conn = {
  exec: async (command: string) => {
    commands.push(command)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: execCommand reads only the channel events, close() and resume() HostChannel implements.
    return channel as unknown as ClientChannel
  },
  usesSystemSshTransport: () => false
}
const target = {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only exec and usesSystemSshTransport are read.
  conn: conn as unknown as QuirkydHostTransport,
  host: getRemoteHostPlatform('linux-x64')
}
const fence = {
  lockDir: '/home/u/.quirky-remote/.quirkyd-activation-transaction/.install-lock',
  token: 't1'
}

// As serializedStateMutationCommand builds it: the guard leads the mutation.
const mutation = `${posixQuirkydFenceGuard(fence)} restore`

function fenced<T>(run: () => Promise<T>): Promise<T> {
  return runWithQuirkydFence(fence, run)
}

async function settledAfter(step: Promise<unknown>, answer: () => void): Promise<unknown> {
  const settled = step.catch((error: unknown) => error)
  await vi.advanceTimersByTimeAsync(0)
  answer()
  return settled
}

beforeEach(() => {
  vi.useFakeTimers()
  channel = new HostChannel()
  commands.length = 0
})
afterEach(() => {
  vi.useRealTimers()
})

// Round 13: the real exec error quotes the command, and every fenced command carries the marker.
describe('a fenced step through the real exec', () => {
  it('stays an ordinary failure when the step itself exits nonzero', async () => {
    const error = await settledAfter(
      fenced(() => execQuirkydRemote(target, 'false')),
      () => channel.exit(1, 'boom\n')
    )
    expect(commands[0]).toContain(QUIRKYD_FENCE_LOST_MARKER)
    expect(error).not.toBeInstanceOf(QuirkydFenceLostError)
    expect(error).toMatchObject({ exitCode: 1, stdout: 'boom\n' })
  })

  it('lets a failed step fall back', async () => {
    const answer = await settledAfter(
      fenced(() => execQuirkydRemoteOr(target, 'false', 'FALLBACK')),
      () => channel.exit(1, '')
    )
    expect(answer).toBe('FALLBACK')
  })

  it('keeps a timed-out step unconfirmed, so the fence is not released under it', async () => {
    const settled = fenced(() => execQuirkydRemoteOr(target, 'sleep 99', 'FALLBACK')).catch(
      (error: unknown) => error
    )
    await vi.advanceTimersByTimeAsync(60_000)
    const error = await settled
    expect(error).not.toBeInstanceOf(QuirkydFenceLostError)
    expect(isUnconfirmedSshCommandTermination(error)).toBe(true)
  })

  it('reads the guard’s own exit as a lost fence', async () => {
    const error = await settledAfter(
      fenced(() => execQuirkydRemote(target, 'true')),
      () => channel.exit(75, `${QUIRKYD_FENCE_LOST_MARKER}\n`)
    )
    expect(error).toBeInstanceOf(QuirkydFenceLostError)
  })

  it('does not read a marker-free exit 75 as a lost fence', async () => {
    const error = await settledAfter(
      fenced(() => execQuirkydRemote(target, 'true')),
      () => channel.exit(75, 'other\n')
    )
    expect(error).not.toBeInstanceOf(QuirkydFenceLostError)
  })
})

describe('a fenced state mutation through the real exec', () => {
  it('stays an ordinary failure when the mutation exits nonzero', async () => {
    const error = await settledAfter(
      fenced(() => execQuirkydStateMutation(target, mutation)),
      () => channel.exit(2, 'no snapshot\n')
    )
    expect(error).not.toBeInstanceOf(QuirkydFenceLostError)
    expect(isUnconfirmedSshCommandTermination(error)).toBe(false)
  })

  it('reads the guard’s own exit as a lost fence', async () => {
    const error = await settledAfter(
      fenced(() => execQuirkydStateMutation(target, mutation)),
      () => channel.exit(75, `${QUIRKYD_FENCE_LOST_MARKER}\n`)
    )
    expect(error).toBeInstanceOf(QuirkydFenceLostError)
  })
})

describe('a Windows host op whose exit PowerShell flattened to 1', () => {
  it('is a lost fence only when the host script printed the marker', () => {
    const op = `powershell.exe -Command "& 'node.exe' 'host.js' --fence d t ${QUIRKYD_FENCE_LOST_MARKER}"`
    expect(isQuirkydFenceLost(sshCommandExitError(op, 1, `${QUIRKYD_FENCE_LOST_MARKER}\r\n`))).toBe(
      true
    )
    expect(isQuirkydFenceLost(sshCommandExitError(op, 1, 'ENOENT\r\n'))).toBe(false)
  })
})
