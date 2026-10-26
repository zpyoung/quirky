import { describe, expect, test } from 'bun:test'
import { ShellReadyBarrier, type ShellState } from '../src/barrier'
import { concat, text, waitFor } from './helpers'

const bytes = (s: string) => new TextEncoder().encode(s)

function harness(overrides: { enabled?: boolean; timeoutMs?: number } = {}) {
  const delivered: Uint8Array[] = []
  const states: ShellState[] = []
  const logs: string[] = []
  const barrier = new ShellReadyBarrier({
    enabled: overrides.enabled ?? true,
    timeoutMs: overrides.timeoutMs ?? 50,
    deliver: (b) => delivered.push(b),
    onState: (s) => states.push(s),
    log: (m) => logs.push(m)
  })
  const output = () => text(concat(delivered))
  return { barrier, delivered, states, logs, output }
}

describe('ShellReadyBarrier', () => {
  test('a disabled barrier is unsupported and passes input straight through', async () => {
    const h = harness({ enabled: false })
    expect(h.barrier.state).toBe('unsupported')
    h.barrier.input(bytes('a'))
    expect(h.output()).toBe('a')
    h.barrier.ready()
    await Bun.sleep(100)
    expect(h.barrier.state).toBe('unsupported')
    expect(h.states).toEqual([])
    h.barrier.restart()
    expect(h.barrier.state).toBe('unsupported')
    h.barrier.input(bytes('b'))
    expect(h.output()).toBe('ab')
  })

  test('input is held in order until ready, then delivered once', () => {
    const h = harness({ timeoutMs: 5000 })
    expect(h.barrier.state).toBe('pending')
    for (let i = 0; i < 20; i++) h.barrier.input(bytes(`${i},`))
    expect(h.delivered).toEqual([])
    h.barrier.ready()
    expect(h.barrier.state).toBe('ready')
    expect(h.output()).toBe(Array.from({ length: 20 }, (_, i) => `${i},`).join(''))
    expect(h.states).toEqual(['ready'])
    h.barrier.dispose()
  })

  test('queued input is copied, so later mutation of the caller buffer does not leak in', () => {
    const h = harness({ timeoutMs: 5000 })
    const buf = bytes('abc')
    h.barrier.input(buf)
    buf.fill(0x7a)
    h.barrier.ready()
    expect(h.output()).toBe('abc')
  })

  test('the timeout flushes the queue and moves to timed_out', async () => {
    const h = harness()
    h.barrier.input(bytes('late'))
    await waitFor(() => h.barrier.state === 'timed_out', 2000, 'timeout')
    expect(h.output()).toBe('late')
    expect(h.states).toEqual(['timed_out'])
  })

  test('input after ready goes straight through', () => {
    const h = harness({ timeoutMs: 5000 })
    h.barrier.ready()
    h.barrier.input(bytes('now'))
    expect(h.output()).toBe('now')
  })

  test('input after the timeout goes straight through', async () => {
    const h = harness()
    await waitFor(() => h.barrier.state === 'timed_out', 2000, 'timeout')
    h.barrier.input(bytes('now'))
    expect(h.output()).toBe('now')
  })

  test('ready after the timeout changes nothing', async () => {
    const h = harness()
    h.barrier.input(bytes('x'))
    await waitFor(() => h.barrier.state === 'timed_out', 2000, 'timeout')
    h.barrier.ready()
    expect(h.barrier.state).toBe('timed_out')
    expect(h.output()).toBe('x')
    expect(h.states).toEqual(['timed_out'])
  })

  test('the timer does not fire after ready', async () => {
    const h = harness()
    h.barrier.ready()
    await Bun.sleep(120)
    expect(h.barrier.state).toBe('ready')
    expect(h.states).toEqual(['ready'])
  })

  test('the queue is capped at 1 MiB; the overflow is dropped and logged once', () => {
    const h = harness({ timeoutMs: 5000 })
    const MiB = 1024 * 1024
    h.barrier.input(new Uint8Array(MiB - 10).fill(0x61))
    h.barrier.input(new Uint8Array(100).fill(0x62))
    h.barrier.input(new Uint8Array(50).fill(0x63))
    expect(h.logs).toHaveLength(1)
    expect(h.logs[0]).toContain('90')
    h.barrier.ready()
    const all = concat(h.delivered)
    expect(all.length).toBe(MiB)
    expect(all[MiB - 11]).toBe(0x61)
    expect(all[MiB - 10]).toBe(0x62)
    expect(all[MiB - 1]).toBe(0x62)
    expect(h.logs).toHaveLength(1)
  })

  test('restart returns an enabled barrier to pending with an empty queue and a fresh timer', async () => {
    const h = harness()
    h.barrier.input(bytes('old'))
    h.barrier.ready()
    expect(h.output()).toBe('old')

    h.barrier.restart()
    expect(h.barrier.state).toBe('pending')
    h.barrier.input(bytes('new'))
    expect(h.output()).toBe('old')
    await waitFor(() => h.barrier.state === 'timed_out', 2000, 'timeout')
    expect(h.output()).toBe('oldnew')
    expect(h.states).toEqual(['ready', 'pending', 'timed_out'])
  })

  test('restart while pending drops the held input', () => {
    const h = harness({ timeoutMs: 5000 })
    h.barrier.input(bytes('stale'))
    h.barrier.restart()
    h.barrier.ready()
    expect(h.delivered).toEqual([])
  })

  test('dispose cancels the timer and drops the queue', async () => {
    const h = harness()
    h.barrier.input(bytes('x'))
    h.barrier.dispose()
    await Bun.sleep(120)
    expect(h.delivered).toEqual([])
    h.barrier.input(bytes('y'))
    h.barrier.ready()
    h.barrier.restart()
    await Bun.sleep(120)
    expect(h.delivered).toEqual([])
  })
})

describe('ShellReadyBarrier with a real PTY', () => {
  test('input written before the marker reaches the shell once, after the marker', async () => {
    const script = `sleep 0.3; printf '\\033]777;quirky-shell-ready\\007'; read line; echo "echoed:$line"`
    const received: Uint8Array[] = []
    let proc: { terminal: { write(d: string | Uint8Array): number; close(): void }; kill(): void; exited: Promise<number> } | undefined
    const barrier = new ShellReadyBarrier({
      enabled: true,
      timeoutMs: 10000,
      deliver: (b) => proc!.terminal.write(b)
    })
    const spawn = Bun.spawn as unknown as (cmd: string[], init: object) => NonNullable<typeof proc>
    let sawMarker = false
    proc = spawn(['/bin/sh', '-c', script], {
      terminal: {
        cols: 80,
        rows: 24,
        data: (_t: unknown, b: Uint8Array) => {
          received.push(b.slice())
          if (!sawMarker && text(concat(received)).includes('\x1b]777;quirky-shell-ready\x07')) {
            sawMarker = true
            barrier.ready()
          }
        },
        exit: () => {}
      }
    })
    try {
      barrier.input(bytes('hello'))
      barrier.input(bytes(' world\n'))
      expect(barrier.state).toBe('pending')
      await waitFor(() => text(concat(received)).includes('echoed:hello world'), 5000, 'echoed line')
      const out = text(concat(received))
      expect(out.indexOf('quirky-shell-ready')).toBeLessThan(out.indexOf('echoed:hello world'))
      expect(out.split('echoed:hello world').length - 1).toBe(1)
      expect(barrier.state).toBe('ready')
    } finally {
      barrier.dispose()
      proc.kill()
    }
  })
})
