import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { base64ToBytes, PTY_PROTOCOL_VERSION, type PtyEvent } from '@quirky/protocol'
import { PtyClient } from '../src/client'
import { readSegments } from '../src/history/log'
import { concat, runCleanups, startHost, text, waitFor, type TestHost } from './helpers'

afterEach(runCleanups)

const ENV = { PATH: '/usr/bin:/bin', TERM: 'xterm-256color' }

function createParams(sessionId: string, argv: string[], extra: Partial<{ cols: number; rows: number }> = {}) {
  return { sessionId, cwd: '/tmp', argv, env: ENV, cols: 80, rows: 24, ...extra }
}

function sh(script: string): string[] {
  return ['/bin/sh', '-c', script]
}

/** Accumulates the DATA frames a client receives for one session. */
function collect(client: PtyClient, sessionId: string) {
  const parts: Uint8Array[] = []
  client.onData((id, bytes) => {
    if (id === sessionId) parts.push(bytes)
  })
  return { all: () => concat(parts), text: () => text(concat(parts)), frames: () => parts.length }
}

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1
}

function events(client: PtyClient) {
  const seen: PtyEvent[] = []
  client.onEvent((event) => seen.push(event as PtyEvent))
  return seen
}

/** The output the session's history log holds, oldest first. */
async function logText(host: TestHost, sessionId: string): Promise<string> {
  const { segments } = readSegments(join(host.home, 'sessions', sessionId))
  return segments.flatMap((s) => s.records.filter((r) => r.kind === 'output').map((r) => text(r.bytes!))).join('')
}

/**
 * Subscribes to the raw tail through the manager, whose replay is exactly the bytes the sink then
 * continues from.
 */
async function subscribeRaw(host: TestHost, sessionId: string) {
  const parts: Uint8Array[] = []
  const sub = await host.server.manager.subscribe(sessionId, (_id, bytes) => parts.push(bytes), { mode: 'raw' })
  return { sub, live: { all: () => concat(parts) } }
}

describe('authentication', () => {
  test('a wrong token is rejected and the connection is closed', async () => {
    const host = startHost()
    const client = await PtyClient.connect(host.server.socketPath)
    await expect(client.hello('nope')).rejects.toThrow(/token/i)
    await waitFor(() => client.closed, 2000, 'connection close')
  })

  test('a wrong protocol version is rejected', async () => {
    const host = startHost()
    const client = await PtyClient.connect(host.server.socketPath)
    await expect(client.request('hello', { token: host.server.token, version: 999 })).rejects.toThrow(/version/i)
    await waitFor(() => client.closed, 2000, 'connection close')
  })

  test('any request before hello is rejected and closes the connection', async () => {
    const host = startHost()
    const client = await PtyClient.connect(host.server.socketPath)
    await expect(client.request('list', {})).rejects.toThrow(/hello/i)
    await waitFor(() => client.closed, 2000, 'connection close')
  })

  test('hello returns the version and host pid', async () => {
    const host = startHost()
    const client = await PtyClient.connect(host.server.socketPath)
    const result = await client.hello(host.server.token)
    expect(result).toEqual({ version: PTY_PROTOCOL_VERSION, pid: process.pid })
  })
})

describe('sessions', () => {
  test('create returns a pid, lists the session, and rejects a duplicate id', async () => {
    const host = startHost()
    const client = await host.connect()
    const { pid } = await client.request('create', createParams('s1', ['/bin/cat']))
    expect(pid).toBeGreaterThan(0)
    const list = await client.request('list', {})
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({
      sessionId: 's1',
      pid,
      alive: true,
      exitCode: null,
      cols: 80,
      rows: 24,
      argv: ['/bin/cat'],
      cwd: '/tmp',
      offset: 0
    })
    await expect(client.request('create', createParams('s1', ['/bin/cat']))).rejects.toThrow(/exists/i)
  })

  test('create fails cleanly for a bad cwd and leaves no state behind', async () => {
    const host = startHost()
    const client = await host.connect()
    await expect(
      client.request('create', { ...createParams('bad', ['/bin/cat']), cwd: '/definitely/not/here' })
    ).rejects.toThrow()
    expect(await client.request('list', {})).toEqual([])
    expect(existsSync(join(host.home, 'sessions', 'bad'))).toBe(false)
  })

  test('rejects session ids that could escape the sessions directory', async () => {
    const host = startHost()
    const client = await host.connect()
    await expect(client.request('create', createParams('../evil', ['/bin/cat']))).rejects.toThrow(/session id/i)
  })

  test('unknown sessions are errors', async () => {
    const host = startHost()
    const client = await host.connect()
    await expect(client.request('subscribe', { sessionId: 'ghost' })).rejects.toThrow(/unknown session/i)
    await expect(client.request('kill', { sessionId: 'ghost' })).rejects.toThrow(/unknown session/i)
  })

  test('output reaches subscribers as DATA frames and input as DATA frames reaches the PTY', async () => {
    const host = startHost()
    const client = await host.connect()
    await client.request('create', createParams('cat', ['/bin/cat']))
    const out = collect(client, 'cat')
    await client.request('subscribe', { sessionId: 'cat' })
    client.sendInput('cat', new TextEncoder().encode('hi\n'))
    await waitFor(() => out.text().includes('hi\r\nhi\r\n'), 5000, 'echo and cat output')
    const [info] = await client.request('list', {})
    expect(info.offset).toBe(out.all().length)
  })

  test('SC-34: clear and resetModes over the socket reach the screen, history and the attached stream', async () => {
    const host = startHost()
    const client = await host.connect()
    await client.request(
      'create',
      createParams('cm', sh(`seq -f 'old-%g' 1 200; printf '\\033[?2004h$ '; exec cat`))
    )
    await waitFor(async () => (await client.request('snapshot', { sessionId: 'cm' })).modes.bracketedPaste, 5000, 'modes on')
    const out = collect(client, 'cm')
    const sub = await client.request('subscribe', { sessionId: 'cm' })

    expect(await client.request('clear', { sessionId: 'cm' })).toEqual({})
    expect(out.text().startsWith('\x1b[H\x1b[2J\x1b[3J')).toBe(true)
    expect(out.text()).not.toContain('old-')
    expect((await client.request('history', { sessionId: 'cm', lines: 100 })).lines).toEqual([])
    expect(await client.request('read', { sessionId: 'cm', lines: 500 })).toMatchObject({ lines: ['$'] })

    expect(await client.request('resetModes', { sessionId: 'cm' })).toEqual({})
    expect((await client.request('snapshot', { sessionId: 'cm' })).modes.bracketedPaste).toBe(false)
    const [info] = await client.request('list', {})
    expect(info.offset).toBe(sub.offset + out.all().length)

    await expect(client.request('clear', { sessionId: 'ghost' })).rejects.toThrow(/unknown session/i)
    await expect(client.request('resetModes', { sessionId: 'ghost' })).rejects.toThrow(/unknown session/i)
  })

  test('output is appended to the session log and counted into offset', async () => {
    const host = startHost()
    const client = await host.connect()
    await client.request('create', createParams('p', sh('printf hello')))
    await waitFor(() => !host.server.manager.isAlive('p'), 5000, 'exit')
    expect(await logText(host, 'p')).toBe('hello')
    const [info] = await client.request('list', {})
    expect(info.offset).toBe(5)
  })
})

describe('subscribe', () => {
  test('replay plus live frames reproduce the full output with no gap or duplicate', async () => {
    const host = startHost()
    const first = await host.connect()
    await first.request('create', createParams('c', ['/bin/cat']))
    const whole = collect(first, 'c')
    await first.request('subscribe', { sessionId: 'c' })
    first.sendInput('c', new TextEncoder().encode('one\ntwo\n'))
    await waitFor(() => occurrences(whole.text(), 'two') >= 2, 5000, 'first batch')

    const { sub, live } = await subscribeRaw(host, 'c')
    const replay = base64ToBytes(sub.replay)
    expect(sub.offset).toBe(replay.length)
    first.sendInput('c', new TextEncoder().encode('three\nfour\n'))
    await waitFor(() => occurrences(whole.text(), 'four') >= 2, 5000, 'second batch')
    await waitFor(() => live.all().length + sub.offset === whole.all().length, 5000, 'live catches up')
    expect(text(concat([replay, live.all()]))).toBe(whole.text())
  })

  test('a wrapped tail replays from a line boundary and still joins the live stream exactly', async () => {
    const host = startHost({ tailBytes: 128 })
    const first = await host.connect()
    await first.request('create', createParams('w', ['/bin/cat']))
    const whole = collect(first, 'w')
    await first.request('subscribe', { sessionId: 'w' })
    const lines = Array.from({ length: 40 }, (_, i) => `line-${i}\n`).join('')
    first.sendInput('w', new TextEncoder().encode(lines))
    await waitFor(() => occurrences(whole.text(), 'line-39') >= 2, 5000, 'bulk output')

    const { sub, live } = await subscribeRaw(host, 'w')
    const replay = base64ToBytes(sub.replay)
    const full = whole.text()
    expect(sub.offset).toBe(full.length)
    expect(replay.length).toBeLessThanOrEqual(128)
    expect(replay.length).toBeGreaterThan(0)
    const start = sub.offset - replay.length
    expect(full[start - 1]).toBe('\n')
    expect(text(replay)).toBe(full.slice(start))

    first.sendInput('w', new TextEncoder().encode('tail-end\n'))
    await waitFor(() => occurrences(whole.text(), 'tail-end') >= 2, 5000, 'more output')
    await waitFor(() => sub.offset + live.all().length === whole.all().length, 5000, 'live catches up')
    expect(text(concat([replay, live.all()]))).toBe(whole.text().slice(start))
  })

  test('subscribing twice on one connection returns a fresh replay and keeps one subscription', async () => {
    const host = startHost()
    const client = await host.connect()
    await client.request('create', createParams('d', ['/bin/cat']))
    const out = collect(client, 'd')
    await client.request('subscribe', { sessionId: 'd' })
    client.sendInput('d', new TextEncoder().encode('x\n'))
    await waitFor(() => out.text().includes('x\r\nx\r\n'), 5000, 'first output')
    const again = await client.request('subscribe', { sessionId: 'd' })
    expect(text(base64ToBytes(again.replay))).toContain('x')
    expect(host.server.manager.subscriberCount('d')).toBe(1)
    const before = out.all().length
    client.sendInput('d', new TextEncoder().encode('y\n'))
    await waitFor(() => out.text().includes('y\r\ny\r\n'), 5000, 'second output')
    expect(text(out.all().subarray(before))).toBe('y\r\ny\r\n')
  })

  test('unsubscribe stops frames, and a closed connection drops its subscriptions', async () => {
    const host = startHost()
    const a = await host.connect()
    const b = await host.connect()
    await a.request('create', createParams('u', ['/bin/cat']))
    const outA = collect(a, 'u')
    await a.request('subscribe', { sessionId: 'u' })
    await b.request('subscribe', { sessionId: 'u' })
    expect(host.server.manager.subscriberCount('u')).toBe(2)
    await a.request('unsubscribe', { sessionId: 'u' })
    expect(host.server.manager.subscriberCount('u')).toBe(1)
    b.sendInput('u', new TextEncoder().encode('z\n'))
    await waitFor(async () => (await b.request('list', {}))[0].offset >= 6, 5000, 'output')
    expect(outA.frames()).toBe(0)
    b.close()
    await waitFor(() => host.server.manager.subscriberCount('u') === 0, 5000, 'subscription drop')
  })

  test('exited sessions can be subscribed for replay', async () => {
    const host = startHost()
    const client = await host.connect()
    const seen = events(client)
    await client.request('create', createParams('x', sh('printf bye')))
    await waitFor(() => seen.length > 0, 5000, 'exit event')
    const sub = await client.request('subscribe', { sessionId: 'x' })
    expect(text(base64ToBytes(sub.replay))).toContain('bye')
    expect(sub.offset).toBe(3)
    expect(sub.live).toBe(false)
  })
})

describe('terminal queries', () => {
  const askForDeviceStatus = sh(
    `sleep 0.3; stty raw -echo; printf '\\033[5n'; dd bs=1 count=4 2>/dev/null | od -An -c | tr -s ' '; sleep 1`
  )

  test('replies from the emulator reach the program while nobody is subscribed', async () => {
    const host = startHost()
    const client = await host.connect()
    await client.request('create', createParams('q', askForDeviceStatus))
    await waitFor(async () => (await logText(host, 'q')).includes('033 [ 0 n'), 5000, 'program saw the reply')
  })

  test('replies are not injected while a subscriber is attached', async () => {
    const host = startHost()
    const client = await host.connect()
    await client.request('create', createParams('q2', askForDeviceStatus))
    await client.request('subscribe', { sessionId: 'q2' })
    await Bun.sleep(700)
    expect(await logText(host, 'q2')).not.toContain('033 [ 0 n')
  })
})

describe('program status', () => {
  const askForProgramStatus = (reply: string) =>
    sh(
      `sleep 0.3; stty raw -echo; printf '\\033]7501;?\\007'; dd bs=1 count=${reply.length} 2>/dev/null | od -An -c | tr -s ' '; sleep 1`
    )
  const REPLY = '\x1b]7501;?:states=idle,working,done,blocked,error:kinds=permission,question,auth\x1b\\'

  test('a ? body gets the capability reply on the program input while nobody is subscribed', async () => {
    const host = startHost()
    const client = await host.connect()
    await client.request('create', createParams('ps', askForProgramStatus(REPLY)))
    await waitFor(async () => (await logText(host, 'ps')).includes('033 ] 7 5 0 1 ; ? : s t a t'), 5000, 'program saw the reply')
  })

  test('the reply is written even while a subscriber is attached', async () => {
    const host = startHost()
    const client = await host.connect()
    await client.request('create', createParams('ps2', askForProgramStatus(REPLY)))
    await client.request('subscribe', { sessionId: 'ps2' })
    await waitFor(async () => (await logText(host, 'ps2')).includes('033 ] 7 5 0 1 ; ? : s t a t'), 5000, 'program saw the reply')
  })

  test('reports program-status and prompt facts', async () => {
    const host = startHost()
    const client = await host.connect()
    const seen = events(client)
    await client.request(
      'create',
      createParams('pf', sh(`printf '\\033]133;A\\007\\033]7501;v=1;state=working\\007'; sleep 5`))
    )
    await waitFor(() => seen.filter((e) => e.type === 'fact').length >= 2, 5000, 'facts')
    const facts = seen.flatMap((e) => (e.type === 'fact' ? [e.fact] : []))
    expect(facts).toEqual([{ kind: 'prompt' }, { kind: 'program-status', body: 'v=1;state=working' }])
  })
})

describe('read', () => {
  async function readUntil(
    client: PtyClient,
    sessionId: string,
    lines: number,
    done: (r: { lines: string[]; alt: boolean }) => boolean
  ) {
    const deadline = Date.now() + 5000
    for (;;) {
      const result = await client.request('read', { sessionId, lines })
      if (done(result)) return result
      if (Date.now() > deadline) throw new Error(`read never matched: ${JSON.stringify(result)}`)
      await Bun.sleep(20)
    }
  }

  test('returns the visible screen as trimmed text', async () => {
    const host = startHost()
    const client = await host.connect()
    await client.request('create', createParams('r', sh('printf "hello  \\nworld"; sleep 5'), { cols: 40, rows: 6 }))
    const result = await readUntil(client, 'r', 0, (r) => r.lines.includes('world'))
    expect(result.lines.slice(0, 2)).toEqual(['hello', 'world'])
    expect(result).toMatchObject({ cols: 40, rows: 6, alt: false })
  })

  test('drops trailing blank rows of the screen but keeps interior blanks', async () => {
    const host = startHost()
    const client = await host.connect()
    await client.request('create', createParams('tb', sh('printf "a\\n\\n\\nb"; sleep 5'), { cols: 40, rows: 10 }))
    const result = await readUntil(client, 'tb', 0, (r) => r.lines.includes('b'))
    expect(result.lines).toEqual(['a', '', '', 'b'])
    expect(result).toMatchObject({ cols: 40, rows: 10 })
  })

  test('a blank screen reads as no lines and keeps its dimensions', async () => {
    const host = startHost()
    const client = await host.connect()
    await client.request('create', createParams('blank', sh('sleep 5'), { cols: 30, rows: 8 }))
    const result = await client.request('read', { sessionId: 'blank', lines: 0 })
    expect(result.lines).toEqual([])
    expect(result).toMatchObject({ cols: 30, rows: 8 })
  })

  test('includes the requested amount of scrollback above the screen', async () => {
    const host = startHost()
    const client = await host.connect()
    await client.request('create', createParams('sb', sh('seq 1 50; sleep 5'), { rows: 5 }))
    const result = await readUntil(client, 'sb', 3, (r) => r.lines.includes('50'))
    expect(result.lines[0]).toBe('44')
    expect(result.lines.at(-1)).toBe('50')
  })

  test('reports alt when the alternate screen is active', async () => {
    const host = startHost()
    const client = await host.connect()
    await client.request('create', createParams('alt', sh(`printf '\\033[?1049h'; printf 'in-alt'; sleep 5`)))
    const result = await readUntil(client, 'alt', 0, (r) => r.alt)
    expect(result.alt).toBe(true)
    expect(result.lines).toContain('in-alt')
  })
})

describe('resize, kill and exit', () => {
  test('resize changes the PTY and the emulator', async () => {
    const host = startHost()
    const client = await host.connect()
    await client.request('create', createParams('rs', sh('read x; stty size; sleep 5')))
    await client.request('resize', { sessionId: 'rs', cols: 100, rows: 30 })
    const out = collect(client, 'rs')
    await client.request('subscribe', { sessionId: 'rs' })
    client.sendInput('rs', new TextEncoder().encode('\n'))
    await waitFor(() => out.text().includes('30 100'), 5000, 'stty size output')
    const [info] = await client.request('list', {})
    expect(info).toMatchObject({ cols: 100, rows: 30 })
    const screen = await client.request('read', { sessionId: 'rs', lines: 0 })
    expect(screen).toMatchObject({ cols: 100, rows: 30 })
  })

  test('a process that exits is announced and stays listed until forgotten', async () => {
    const host = startHost()
    const client = await host.connect()
    const other = await host.connect()
    const seen = events(other)
    await client.request('create', createParams('e', sh('printf hello; exit 3')))
    await waitFor(() => seen.length > 0, 5000, 'exit event')
    expect(seen[0]).toEqual({ type: 'exit', sessionId: 'e', exitCode: 3, exitSignal: null, exitCause: 'exited' })
    expect(await logText(host, 'e')).toBe('hello')
    const [info] = await client.request('list', {})
    expect(info).toMatchObject({ sessionId: 'e', alive: false, exitCode: 3, offset: 5 })
  })

  test('kill ends the whole process group', async () => {
    const host = startHost()
    const client = await host.connect()
    const out = collect(client, 'k')
    const seen = events(client)
    await client.request('create', createParams('k', sh('sleep 100 & echo child=$!; wait')))
    const sub = await client.request('subscribe', { sessionId: 'k' })
    // the shell can print before the subscription starts, and that output comes back in the replay
    const output = () => text(concat([base64ToBytes(sub.replay), out.all()]))
    const childPid = Number((await waitFor(() => /child=(\d+)/.exec(output()), 5000, 'child pid'))[1])
    await client.request('kill', { sessionId: 'k' })
    await waitFor(() => seen.length > 0, 5000, 'exit event')
    await waitFor(
      () => {
        try {
          process.kill(childPid, 0)
          return false
        } catch {
          return true
        }
      },
      5000,
      'child to die'
    )
    const [info] = await client.request('list', {})
    expect(info.alive).toBe(false)
  })

  test('kill honors an explicit signal', async () => {
    const host = startHost()
    const client = await host.connect()
    const seen = events(client)
    await client.request('create', createParams('ks', sh(`trap 'exit 7' USR1; while :; do sleep 0.05; done`)))
    await Bun.sleep(200)
    await client.request('kill', { sessionId: 'ks', signal: 'SIGUSR1' })
    await waitFor(() => seen.length > 0, 5000, 'exit event')
    expect(seen[0]).toMatchObject({ sessionId: 'ks', exitCode: 7 })
    await expect(client.request('kill', { sessionId: 'ks', signal: 'SIGNOPE' })).rejects.toThrow(/signal/i)
  })

  test('forget removes the log directory and the session', async () => {
    const host = startHost()
    const client = await host.connect()
    await client.request('create', createParams('f', sh('printf hello; sleep 100')))
    const dir = join(host.home, 'sessions', 'f')
    await waitFor(async () => (await logText(host, 'f')) === 'hello', 5000, 'log')
    const [info] = await client.request('list', {})
    await client.request('forget', { sessionId: 'f' })
    expect(existsSync(dir)).toBe(false)
    expect(await client.request('list', {})).toEqual([])
    await waitFor(
      () => {
        try {
          process.kill(info.pid, 0)
          return false
        } catch {
          return true
        }
      },
      5000,
      'process to be killed'
    )
    await client.request('create', createParams('f', ['/bin/cat']))
  })

  test('the log rotates through the host when it exceeds the threshold', async () => {
    const host = startHost({ logMaxBytes: 200 })
    const client = await host.connect()
    await client.request('create', createParams('rot', sh('seq 1 400')))
    await waitFor(() => !host.server.manager.isAlive('rot'), 5000, 'exit')
    const dir = join(host.home, 'sessions', 'rot')
    expect(existsSync(join(dir, 'output.1.log'))).toBe(true)
    expect(statSync(join(dir, 'output.1.log')).size).toBeGreaterThan(200)
    expect(await logText(host, 'rot')).toContain('400\r\n')
  })
})
