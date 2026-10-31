import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { base64ToBytes, type Session } from '@quirky/protocol'
import {
  E2eHarness,
  cleanupAll,
  commandOf,
  descendantsOf,
  isAlive,
  plain,
  waitFor,
  type E2eOptions,
  type HostRow
} from './e2e-support'

const spawned: { kill(): void; exited: Promise<number> }[] = []


type AbandonedHarness = {
  ownerPid: number
  home?: string
  repo?: string
  daemonPid?: number
  hostPid?: number
  shellPid?: number
}

const abandonedHarnesses: AbandonedHarness[] = []

async function killForFinalizer(resources: AbandonedHarness): Promise<void> {
  const pids = new Set<number>()
  const roots = [resources.ownerPid, resources.daemonPid, resources.hostPid, resources.shellPid].filter(
    (pid): pid is number => pid !== undefined
  )
  for (const pid of roots) {
    pids.add(pid)
    try {
      for (const row of descendantsOf(pid)) pids.add(row.pid)
    } catch {
      // The process table may already be unavailable during finalization.
    }
  }
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // Already gone.
    }
  }
  // These pids are real OS processes; fake timers cannot report their exit.
  await waitFor('abandoned harness processes to exit', () => ([...pids].every((pid) => !isAlive(pid)) ? true : undefined), 10_000).catch(() => {})
  if (resources.home) rmSync(resources.home, { recursive: true, force: true })
  if (resources.repo) rmSync(dirname(resources.repo), { recursive: true, force: true })
}

function childRecord<T>(text: string, stage: string): T | undefined {
  for (const line of text.split('\n')) {
    try {
      const record = JSON.parse(line) as T & { stage?: string }
      if (record.stage === stage) return record
    } catch {
      // Ignore incomplete output while the child is still writing.
    }
  }
  return undefined
}

afterEach(async () => {
  const processes = spawned.splice(0)
  for (const proc of processes) proc.kill()
  for (const resources of abandonedHarnesses.splice(0)) await killForFinalizer(resources)
  await Promise.allSettled(processes.map((proc) => proc.exited))
  await cleanupAll()
})

/** One named scenario against a fresh daemon, host and repo; process work gets a generous timeout. */
function scenario(name: string, run: () => Promise<void>, timeoutMs = 90_000): void {
  test(name, run, timeoutMs)
}

const start = (options?: E2eOptions) => E2eHarness.start(options)
const PROMPT = /[%#]$/

/** Collects a subprocess stream's text as it arrives. */
function collect(stream: ReadableStream<Uint8Array>) {
  const decoder = new TextDecoder()
  const state = { text: '' }
  const reader = stream.getReader()
  void (async () => {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return
      state.text += decoder.decode(value, { stream: true })
    }
  })()
  return state
}

const idsOf = (sessions: { id: string }[]) => sessions.map((session) => session.id).sort()

async function endNormally(h: E2eHarness, id: string, code = 0): Promise<Session> {
  await h.type(id, `exit ${code}`)
  return h.waitForSession(id, 'exited', (session) => session.status === 'exited')
}

async function waitForHostLoss(h: E2eHarness, ids: string[]): Promise<void> {
  for (const id of ids) {
    await h.waitForSession(id, 'lost with the host', (session) => session.status === 'exited' && session.exitCause === 'host-lost')
  }
}

scenario('SC-1: a new shell session is ready at its first prompt', async () => {
  const h = await start()
  const session = await h.newSession()
  expect(session).toMatchObject({ agent: 'shell', kind: 'terminal', status: 'running' })

  const row = await waitFor('a ready shell', async () => {
    const found = await h.hostRow(session.id)
    return found?.shellState === 'ready' ? found : undefined
  })
  expect(row).toMatchObject({ state: 'running', cwd: h.repo, shellState: 'ready' })

  const listed = await h.ok(['terminal', 'sessions'])
  expect(listed).toMatch(new RegExp(`${session.id}\\s+running\\s+ready`))

  const prompt = await waitFor('a prompt in the snapshot', async () => {
    const text = await h.ok(['terminal', 'snapshot', session.id])
    return text.includes(`${basename(h.repo)} %`) || text.includes(`${basename(h.repo)} #`) ? text : undefined
  })
  expect(plain(prompt)).toContain(basename(h.repo))
  const snapshot = await h.json<{ cwd: string; shellState: string }>(['terminal', 'snapshot', session.id])
  expect(snapshot).toMatchObject({ cwd: h.repo, shellState: 'ready' })
})

scenario('SC-2: input sent before the prompt waits for it and runs once, in order', async () => {
  const h = await start({ zshrc: 'sleep 3\n' })
  const session = await h.newSession()

  const first = await h.cli(['terminal', 'send', session.id, 'echo one', '--enter'])
  const second = await h.cli(['terminal', 'send', session.id, 'echo two', '--enter'])
  expect(first.code).toBe(0)
  expect(second.code).toBe(0)
  expect((await h.hostRow(session.id))?.shellState).toBe('pending')
  expect((await h.screen(session.id)).filter((line) => line === 'one' || line === 'two')).toEqual([])

  const rows = await h.waitForLine(session.id, 'two')
  const outputs = rows.filter((line) => line === 'one' || line === 'two')
  expect(outputs).toEqual(['one', 'two'])
  expect(rows.filter((line) => line.endsWith('echo one'))).toHaveLength(1)
  expect((await h.hostRow(session.id))?.shellState).toBe('ready')
})

scenario('SC-2: input held for a slow prompt is drawn once, because the shell is ready only once its line editor is', async () => {
  // a prompt that takes a second to expand widens the gap between precmd and the line editor taking the terminal
  const h = await start({ zshrc: "setopt prompt_subst\nPROMPT='$(sleep 1)%# '\n" })
  const session = await h.newSession()

  await h.cli(['terminal', 'send', session.id, 'echo one', '--enter'])
  const rows = await h.waitForLine(session.id, 'one')
  expect(rows.filter((line) => line.endsWith('echo one'))).toHaveLength(1)
})

scenario('SC-2: in bash too, input held for a slow prompt is drawn once', async () => {
  const h = await start({ shell: '/bin/bash', bashrc: "PS1='$(sleep 1)$ '\n" })
  const session = await h.newSession()

  await h.cli(['terminal', 'send', session.id, 'echo one', '--enter'])
  const rows = await h.waitForLine(session.id, 'one')
  expect(rows.filter((line) => line.endsWith('echo one'))).toHaveLength(1)
})

/** The bytes of every history log file the PTY host wrote for a session. */
function sessionLogText(home: string, id: string): string {
  const dir = join(home, 'sessions', id)
  return readdirSync(dir)
    .filter((name) => /^output.*\.log$/.test(name))
    .map((name) => readFileSync(join(dir, name), 'latin1'))
    .join('')
}

scenario('SC-3: the ready marker never shows', async () => {
  const shells = ['/bin/zsh', '/bin/bash'].filter((shell) => {
    const present = existsSync(shell)
    if (!present) console.warn(`SC-3: skipping ${shell}, it is not installed on this machine`)
    return present
  })
  expect(shells).toContain('/bin/zsh')

  for (const shell of shells) {
    const h = await start({ shell })
    const session = await h.newSession()
    await waitFor(`${shell} ready`, async () => (await h.hostRow(session.id))?.shellState === 'ready')
    const name = basename(h.repo)
    await waitFor(`${shell} prompt in the snapshot`, async () => (await h.ok(['terminal', 'snapshot', session.id])).includes(name) || undefined)
    await h.run(session.id, 'seq 1 60')
    await waitFor(`${shell} prompt in the log`, () => sessionLogText(h.home, session.id).includes(name) || undefined)

    const snapshot = JSON.stringify(await h.call('quirky.terminal/snapshot', { session: session.id }))
    const history = JSON.stringify([
      await h.call('quirky.terminal/history', { session: session.id }),
      await h.call('quirky.terminal/history', { session: session.id, format: 'ansi' })
    ])
    const pane = await h.attach(session.id)
    const replay = new TextDecoder().decode(base64ToBytes(pane.result.replay))
    await pane.detach()
    const logged = sessionLogText(h.home, session.id)

    expect(snapshot, `${shell} snapshot`).toContain(name)
    expect(history, `${shell} history`).toContain('seq 1 60')
    expect(replay, `${shell} replay`).toContain(name)
    for (const [what, content] of [['snapshot', snapshot], ['history', history], ['replay', replay], ['log', logged]] as const) {
      expect(content, `${shell} ${what}`).not.toContain('777')
      expect(content, `${shell} ${what}`).not.toContain('quirky-shell-ready')
    }
    await h.cleanup()
  }
})

scenario('SC-6: restarting quirkyd keeps a running command and repaints the pane', async () => {
  const h = await start()
  const session = await h.newSession()
  await h.type(session.id, 'for i in $(seq 1 50); do echo marker-$i; done; sleep 7777')
  const shell = await h.shellPid(session.id)
  const sleep = await waitFor('sleep 7777', () => descendantsOf(shell).find((row) => row.command === 'sleep 7777')?.pid)
  await h.waitForLine(session.id, 'marker-50')

  const before = await h.attach(session.id)
  await before.detach()
  await h.stopDaemon()
  expect(isAlive(sleep)).toBe(true)
  await h.startDaemon()

  const row = await waitFor('the session listed again', () => h.hostRow(session.id))
  expect(row.state).toBe('running')
  expect(descendantsOf(row.pid).find((child) => child.command === 'sleep 7777')?.pid).toBe(sleep)
  expect((await h.sessionRecord(session.id)).status).toBe('running')

  const pane = await h.attach(session.id)
  expect(pane.result.restored).toBe(false)
  for (const line of ['marker-1', 'marker-25', 'marker-50']) expect(pane.replayText).toContain(line)
  expect(pane.replayText.replaceAll('\n', '')).toContain('sleep 7777')

  await h.call('quirky.terminal/write', { session: session.id, data: '\x03' })
  await waitFor('sleep to end', () => !isAlive(sleep))
  const rows = await waitFor('a fresh prompt', async () => {
    const lines = (await h.screen(session.id, 0)).filter((line) => line !== '')
    return PROMPT.test(lines.at(-1) ?? '') ? lines : undefined
  })
  expect(rows.some((line) => line.includes('^C'))).toBe(true)
  expect(isAlive(row.pid)).toBe(true)
  expect((await h.sessionRecord(session.id)).status).toBe('running')
})

scenario('SC-9: no output is lost or repeated between the replay and the live stream', async () => {
  const h = await start()
  const session = await h.newSession()
  await h.type(session.id, 'i=0; while :; do i=$((i+1)); echo "nn-$i"; sleep 0.005; done')
  await h.waitForLine(session.id, 'nn-40')

  const numbersIn = (text: string) => [...text.matchAll(/nn-(\d+)/g)].map((match) => Number(match[1]))
  const pane = await h.attach(session.id)
  await waitFor('more than 30 lines in the live stream', () => (numbersIn(pane.streamText()).length > 30 ? true : undefined))
  await h.call('quirky.terminal/write', { session: session.id, data: '\x03' })
  await h.waitForLine(session.id, /\^C/)
  await Bun.sleep(300)

  expect(numbersIn(pane.replayText).length).toBeGreaterThan(30)
  expect(numbersIn(pane.streamText()).length).toBeGreaterThan(30)
  const numbers = numbersIn(pane.replayText + pane.streamText())
  const breaks = numbers.filter((value, index) => index > 0 && value !== numbers[index - 1]! + 1)
  expect(breaks).toEqual([])
})

scenario('SC-16 and SC-17: a lost host leaves a session restorable, and attach restores it', async () => {
  const h = await start()
  const session = await h.newSession()
  const sub = join(h.repo, 'src')
  mkdirSync(sub)
  await h.call('quirky.terminal/resize', { session: session.id, cols: 100, rows: 30 })
  await h.run(session.id, `cd src && printf 'before-%s\\n' crash && seq 1 40`)
  await h.waitForLine(session.id, 'before-crash')
  await waitFor('the cwd to be reported', async () => ((await h.json<{ cwd: string }>(['terminal', 'snapshot', session.id])).cwd === sub ? true : undefined))

  const oldHost = h.killHost()
  await h.waitForSession(session.id, 'lost with the host', (record) => record.status === 'exited' && record.exitCause === 'host-lost')
  const listed = (await h.json<Session[]>(['session', 'list'])).find((record) => record.id === session.id)!
  expect(listed).toMatchObject({ status: 'exited', exitCause: 'host-lost', exitCode: null, restorable: true })
  expect(h.hostPid()).not.toBe(oldHost)
  expect(await h.ok(['terminal', 'history', session.id])).toContain('before-crash')

  const pane = await h.attach(session.id, { cols: 100, rows: 30 })
  expect(pane.result).toMatchObject({ restored: true, live: true, cols: 100, rows: 30 })
  expect(pane.replayText).toContain('before-crash')
  const record = await h.sessionRecord(session.id)
  expect(record).toMatchObject({ status: 'running', agent: 'shell', restorable: false })

  const rows = await h.run(session.id, `pwd; printf 'after-%s\\n' restore`)
  expect(rows).toContain(sub)
  expect((await h.json<{ cwd: string }>(['terminal', 'snapshot', session.id])).cwd).toBe(sub)
  const history = (await h.call<{ lines: string[] }>('quirky.terminal/history', { session: session.id, lines: 500 })).lines.map((line) => plain(line).trimEnd())
  expect(history).toContain('before-crash')
  const everything = [...history, ...(await h.screen(session.id))]
  expect(everything).toContain('after-restore')
})

scenario('SC-18: session restore restores a lost session once and refuses a normal exit', async () => {
  const h = await start()
  const s3 = await h.newSession()
  await h.run(s3.id, `printf 'done-%s\\n' three`)
  await endNormally(h, s3.id)
  const s1 = await h.newSession()
  await h.run(s1.id, `printf 'one-%s\\n' alpha`)

  h.killHost()
  await h.waitForSession(s1.id, 'restorable', (record) => record.restorable)
  const s2 = await h.newSession()
  expect(s2.status).toBe('running')
  expect((await h.sessionRecord(s3.id)).restorable).toBe(false)

  expect((await h.cli(['session', 'restore', s1.id])).stdout.trim()).toBe(`restored ${s1.id}`)
  const restored = await h.sessionRecord(s1.id)
  expect(restored).toMatchObject({ status: 'running', agent: 'shell', restorable: false })
  const screen = await waitFor('the old output above a prompt', async () => {
    const rows = await h.screen(s1.id)
    return rows.includes('one-alpha') ? rows : undefined
  })
  expect(screen).toContain('one-alpha')

  const running = await h.cli(['session', 'restore', s2.id])
  expect(running.code).toBe(0)
  expect(running.stdout.trim()).toBe(`${s2.id} is already running`)

  const ended = await h.cli(['session', 'restore', s3.id])
  expect(ended.code).toBe(1)
  expect(ended.stderr).toContain('ended normally')
  expect(ended.stderr).toContain("can't be restored")
  expect((await h.sessionRecord(s3.id)).status).toBe('exited')

  const again = await h.cli(['session', 'restore', s1.id])
  expect(again.code).toBe(0)
  expect(again.stdout.trim()).toBe(`${s1.id} is already running`)
  expect(await h.sessionRecord(s1.id)).toMatchObject({ status: 'running', agent: 'shell' })
})

scenario('SC-19: killing the host and quirkyd leaves every session restorable', async () => {
  const h = await start()
  const s1 = await h.newSession()
  const s2 = await h.newSession()
  await h.run(s1.id, `printf 'out-%s\\n' alpha; seq 1 40`)
  await h.run(s2.id, `printf 'out-%s\\n' beta; seq 1 40`)

  const host = h.hostPid()
  await h.stopDaemon('SIGKILL')
  h.killHost()
  await waitFor('the host to die', () => !isAlive(host))
  await h.startDaemon()

  await waitForHostLoss(h, [s1.id, s2.id])
  for (const id of [s1.id, s2.id]) {
    expect(await h.sessionRecord(id)).toMatchObject({ status: 'exited', exitCause: 'host-lost', exitCode: null, restorable: true })
  }

  for (const [id, own, other] of [
    [s1.id, 'out-alpha', 'out-beta'],
    [s2.id, 'out-beta', 'out-alpha']
  ] as const) {
    expect((await h.cli(['session', 'restore', id])).stdout.trim()).toBe(`restored ${id}`)
    const rows = await waitFor(`${own} on screen`, async () => {
      const lines = await h.screen(id)
      return lines.includes(own) ? lines : undefined
    })
    expect(rows).not.toContain(other)
    expect(await h.ok(['terminal', 'history', id])).toContain(own)
  }
})

scenario('SC-22: writing to a restorable or exited session is refused with a reason', async () => {
  const h = await start()
  const s1 = await h.newSession()
  const s3 = await h.newSession()
  await h.run(s3.id, `printf 'last-%s\\n' words; seq 1 40`)
  await endNormally(h, s3.id)
  h.killHost()
  await h.waitForSession(s1.id, 'restorable', (record) => record.restorable)

  const lost = await h.cli(['terminal', 'send', s1.id, 'ls', '--enter'])
  expect(lost.code).toBe(1)
  expect(lost.stderr).toContain(`session ${s1.id} ended when the terminal host stopped; run quirky session restore ${s1.id}`)

  const ended = await h.cli(['terminal', 'send', s3.id, 'ls', '--enter'])
  expect(ended.code).toBe(1)
  expect(ended.stderr).toContain(`session ${s3.id} has exited`)

  expect((await h.cli(['terminal', 'read', s1.id])).code).toBe(0)
  expect((await h.cli(['terminal', 'read', s3.id])).stdout).toContain('last-words')
  expect((await h.cli(['terminal', 'history', s1.id])).code).toBe(0)
  expect((await h.cli(['terminal', 'history', s3.id])).stdout).toContain('last-words')
})

scenario('SC-23: kill asks first, force-quits the session and keeps its output', async () => {
  const h = await start()
  const s1 = await h.newSession()
  const s2 = await h.newSession()
  await h.run(s1.id, `printf 'keep-%s\\n' this; seq 1 40`)
  await h.type(s1.id, 'sleep 7777 &')
  const shell = await h.shellPid(s1.id)
  const sleep = await waitFor('the background sleep', () => descendantsOf(shell).find((row) => row.command === 'sleep 7777')?.pid)
  h.track(sleep)

  const proc = h.spawnCli(['terminal', 'kill', s1.id])
  spawned.push(proc)
  const stderr = collect(proc.stderr)
  const asked = await waitFor('the confirmation prompt', () => /\(ask (ask_\w+)\)/.exec(stderr.text))
  expect((await h.sessionRecord(s1.id)).status).toBe('running')
  expect(isAlive(shell)).toBe(true)

  await h.ok(['ask', 'answer', '--ask-id', asked[1]!, '--answers', JSON.stringify({ confirm: { value: true, source: 'input' } })])
  expect(await proc.exited).toBe(0)
  const killed = await h.waitForSession(s1.id, 'killed', (record) => record.status === 'exited')
  expect(killed).toMatchObject({ exitCode: 137, exitSignal: 'SIGKILL', exitCause: 'killed', restorable: false })
  await waitFor('the shell and its sleep to be gone', () => !isAlive(shell) && !isAlive(sleep), 10_000)
  expect(await h.ok(['terminal', 'history', s1.id])).toContain('keep-this')

  const direct = await h.cli(['terminal', 'kill', s2.id, '--yes'])
  expect(direct.code).toBe(0)
  expect(direct.stderr).not.toContain('confirm in Quirky')
  expect(await h.waitForSession(s2.id, 'killed', (record) => record.status === 'exited')).toMatchObject({
    exitCode: 137,
    exitSignal: 'SIGKILL',
    exitCause: 'killed',
    restorable: false
  })
})

scenario('SC-24: kill-all reports what it killed and leaves the host up', async () => {
  const h = await start()
  const sessions = [await h.newSession(), await h.newSession(), await h.newSession()]
  for (const session of sessions) await waitFor('a ready shell', async () => (await h.hostRow(session.id))?.shellState === 'ready')
  const host = h.hostPid()

  const result = await h.json<{ killedCount: number; remainingCount: number; killedSessionIds: string[] }>(['terminal', 'kill-all', '--yes'])
  expect(result).toMatchObject({ killedCount: 3, remainingCount: 0 })
  expect([...result.killedSessionIds].sort()).toEqual(idsOf(sessions))
  for (const session of sessions) {
    expect(await h.sessionRecord(session.id)).toMatchObject({ status: 'exited', exitCause: 'killed' })
  }
  expect(h.hostPid()).toBe(host)

  const fresh = await h.newSession()
  expect(fresh.status).toBe('running')
  await waitFor('the new shell to be ready', async () => (await h.hostRow(fresh.id))?.shellState === 'ready')
  expect(h.hostPid()).toBe(host)

  const last = await h.json<{ killedCount: number }>(['terminal', 'kill-all', '--yes'])
  expect(last.killedCount).toBe(1)
  const none = await h.json<{ killedCount: number; remainingCount: number; killedSessionIds: string[] }>(['terminal', 'kill-all', '--yes'])
  expect(none).toMatchObject({ killedCount: 0, remainingCount: 0, killedSessionIds: [] })
})

scenario('SC-25: restart-host ends every session as restorable and starts a new host', async () => {
  const h = await start()
  const s1 = await h.newSession()
  const s2 = await h.newSession()
  await h.run(s1.id, `printf 'mark-%s\\n' one`)
  await h.run(s2.id, `printf 'mark-%s\\n' two`)
  const oldHost = h.hostPid()

  const result = await h.json<{ pid: number }>(['terminal', 'restart-host', '--yes'])
  const newHost = await waitFor('a new host pid', () => (h.hostPid() !== oldHost ? h.hostPid() : undefined))
  expect(result.pid).toBe(newHost)
  expect(isAlive(newHost)).toBe(true)
  await waitFor('the old host to exit', () => !isAlive(oldHost))

  for (const session of [s1, s2]) {
    expect(await h.sessionRecord(session.id)).toMatchObject({ status: 'exited', exitCause: 'host-restart', restorable: true })
  }
  expect((await h.json<{ sessions: HostRow[] }>(['terminal', 'sessions'])).sessions).toEqual([])

  for (const [session, own] of [
    [s1, 'mark-one'],
    [s2, 'mark-two']
  ] as const) {
    expect((await h.cli(['session', 'restore', session.id])).stdout.trim()).toBe(`restored ${session.id}`)
    await waitFor(`${own} restored`, async () => ((await h.screen(session.id)).includes(own) ? true : undefined))
    expect(await h.sessionRecord(session.id)).toMatchObject({ status: 'running', agent: 'shell' })
  }
})

scenario('SC-34: exit 3 in an interactive zsh or bash shell records 3', async () => {
  for (const shell of ['/bin/zsh', '/bin/bash']) {
    const h = await start({ shell })
    const session = await h.newSession()
    await waitFor('a ready shell', async () => (await h.hostRow(session.id))?.shellState === 'ready')
    expect((await h.cli(['terminal', 'send', session.id, 'exit 3', '--enter'])).code).toBe(0)
    await h.waitForSession(session.id, 'exited', (record) => record.status === 'exited')
    const listed = (await h.json<Session[]>(['session', 'list'])).find((record) => record.id === session.id)!
    expect(listed, shell).toMatchObject({ status: 'exited', exitCode: 3, exitSignal: null, exitCause: 'exited' })
    await h.cleanup()
  }
})

scenario('SC-35: an agent command exit status comes through its login shell', async () => {
  const h = await start()
  h.writeBinScript('claude', 'exit 5')
  const session = await h.newSession('claude')
  const ended = await h.waitForSession(session.id, 'exited', (record) => record.status === 'exited')
  expect(ended).toMatchObject({ agent: 'claude', exitCode: 5, exitCause: 'exited' })
})

scenario('SC-36: a signal death reports 128 plus the signal', async () => {
  const h = await start()
  // an interactive zsh ignores SIGTERM, so the signalled process is a plain program run through the login shell
  h.writeBinScript('claude', 'exec sleep 7777')
  const session = await h.newSession('claude')
  const pid = await h.shellPid(session.id)
  await waitFor('the program to be running', () => commandOf(pid) === 'sleep 7777')
  process.kill(pid, 'SIGTERM')
  const ended = await h.waitForSession(session.id, 'exited', (record) => record.status === 'exited')
  expect(ended).toMatchObject({ exitCode: 143, exitSignal: 'SIGTERM', exitCause: 'exited', restorable: false })
})

scenario('SC-39: closing a session deletes its history', async () => {
  const h = await start()
  const session = await h.newSession()
  await h.run(session.id, `printf 'gone-%s\\n' soon; seq 1 40`)
  await endNormally(h, session.id)
  const dir = join(h.home, 'sessions', session.id)
  expect(existsSync(dir)).toBe(true)
  expect(await h.ok(['terminal', 'history', session.id])).toContain('gone-soon')

  expect((await h.cli(['session', 'close', session.id])).code).toBe(0)
  await waitFor('the history directory to be gone', () => !existsSync(dir))
  const history = await h.cli(['terminal', 'history', session.id])
  expect(history.code).not.toBe(0)
  expect(history.stderr).toMatch(/no such session|not found/i)
})

scenario('SC-40: every terminal host flow is scriptable', async () => {
  const h = await start()
  const api = await h.json<{
    methods: { name: string; params: unknown; result: unknown }[]
    events: { name: string }[]
    cli: { commands: { words: string }[] }
  }>(['api'])

  const methods = new Map(api.methods.map((method) => [method.name, method]))
  for (const name of ['snapshot', 'history', 'sessions', 'kill', 'killAll', 'restartHost']) {
    const method = methods.get(`quirky.terminal/${name}`)
    expect(method, name).toBeDefined()
    expect(method!.params).toMatchObject({ type: 'object' })
  }
  expect(methods.get('quirky.session/restore')?.params).toMatchObject({ type: 'object', required: ['session'] })

  const words = api.cli.commands.map((command) => command.words)
  for (const command of ['terminal snapshot', 'terminal history', 'terminal sessions', 'terminal kill', 'terminal kill-all', 'terminal restart-host', 'session restore']) {
    expect(words, command).toContain(command)
  }
  const events = api.events.map((event) => event.name)
  for (const name of ['bell', 'commandFinished', 'title', 'cwd', 'notification']) expect(events).toContain(`quirky.terminal/${name}`)
})

scenario('SC-29: a program notification in a real session becomes a terminal event', async () => {
  const h = await start()
  const session = await h.newSession()
  await h.run(session.id, `printf '\\033]777;notify;Build;done in 4s\\007'`)
  const event = await waitFor('the notification event', () =>
    h.events.find((candidate) => candidate.type === 'quirky.terminal/notification')
  )
  expect(event).toMatchObject({
    type: 'quirky.terminal/notification',
    data: { sessionId: session.id, title: 'Build', body: 'done in 4s', occasion: 'always' }
  })
}, 90_000)

scenario('SC-42: an ended session attaches read only after a host restart', async () => {
  const h = await start()
  const session = await h.newSession()
  await h.run(session.id, 'echo bye')
  await endNormally(h, session.id)
  await h.json(['terminal', 'restart-host', '--yes'])
  await waitFor('the host to answer', async () => (await h.call('quirky.terminal/sessions')).sessions)

  const pane = await h.attach(session.id)
  expect(pane.result).toMatchObject({ live: false, restored: false })
  expect(pane.replayText).toContain('bye')
  expect(await h.sessionRecord(session.id)).toMatchObject({ status: 'exited', exitCode: 0, restorable: false })
  expect((await h.json<{ sessions: HostRow[] }>(['terminal', 'sessions'])).sessions).toEqual([])
  const typed = await h.cli(['terminal', 'send', session.id, 'ls', '--enter'])
  expect(typed.code).toBe(1)
  await Bun.sleep(300)
  expect(pane.streamText()).toBe('')
})

scenario('cleanup removes a host and shells that a SIGKILLed quirkyd left running, and the home', async () => {
  const h = await start()
  // created without the harness helper so cleanup is the first thing to learn about the host
  const session = await h.json<Session>(['session', 'new', '--agent', 'shell', '--worktree', 'main'])
  const shell = await h.shellPid(session.id)
  const host = h.hostPid()
  const home = h.home

  process.kill(h.daemonPid, 'SIGKILL')
  await waitFor('the daemon to die', () => !isAlive(h.daemonPid))
  expect(isAlive(host)).toBe(true)
  expect(isAlive(shell)).toBe(true)

  await h.cleanup()

  await waitFor('the host and shell to die', () => !isAlive(host) && !isAlive(shell))
  expect(existsSync(home)).toBe(false)
})

scenario(
  'hard-killed harness owner still cleans its daemon, PTY host, and shell',
  async () => {
    const moduleUrl = new URL('./e2e-support.ts', import.meta.url).href
    const owner = Bun.spawn(
      [
        process.execPath,
        '-e',
        // The child must import the real harness in an independently killable runner.
        `
const { E2eHarness, waitFor } = await import(${JSON.stringify(moduleUrl)})
const h = await E2eHarness.start()
console.log(JSON.stringify({ stage: 'started', home: h.home, repo: h.repo, daemonPid: h.daemonPid }))
const session = await h.newSession()
const hostPid = await waitFor('the PTY host', () => {
  try { return h.hostPid() } catch { return undefined }
})
const shellPid = await h.shellPid(session.id)
await h.waitForLine(session.id, /[%#]$/)
console.log(JSON.stringify({ stage: 'ready', hostPid, shellPid }))
await new Promise(() => {})
`
      ],
      { stdout: 'pipe', stderr: 'pipe' }
    )
    const output = collect(owner.stdout as ReadableStream<Uint8Array>)
    const errors = collect(owner.stderr as ReadableStream<Uint8Array>)
    const resources: AbandonedHarness = { ownerPid: owner.pid }
    abandonedHarnesses.push(resources)
    spawned.push(owner)

    const started = await waitFor(
      'the child harness daemon',
      () => {
        if (owner.exitCode !== null) throw new Error(`child harness exited ${owner.exitCode}: ${errors.text}`)
        return childRecord<{ stage: string; home: string; repo: string; daemonPid: number }>(output.text, 'started')
      },
      90_000
    )
    Object.assign(resources, started)
    expect(existsSync(started.home!)).toBe(true)
    expect(started.home).not.toBe(process.env.QUIRKY_HOME)

    const ready = await waitFor(
      'the child harness PTY host and shell',
      () => {
        if (owner.exitCode !== null) throw new Error(`child harness exited ${owner.exitCode}: ${errors.text}`)
        return childRecord<{ stage: string; hostPid: number; shellPid: number }>(output.text, 'ready')
      },
      90_000
    )
    Object.assign(resources, ready)

    process.kill(owner.pid, 'SIGKILL')
    await owner.exited
    const ownedPids = [started.daemonPid!, ready.hostPid, ready.shellPid]
    await waitFor(
      'the child harness processes to die after their owner is SIGKILLed',
      () => (ownedPids.every((pid) => !isAlive(pid)) ? true : undefined),
      20_000
    )
    expect(ownedPids.map(isAlive)).toEqual([false, false, false])

  },
  120_000
)
