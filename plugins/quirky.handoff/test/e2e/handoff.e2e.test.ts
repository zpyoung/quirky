import { afterEach, describe, expect, test } from 'bun:test'
import { realpath } from 'node:fs/promises'
import type { QuirkyEvent } from '@quirky/protocol'
import { startAgentsE2E, type E2E, type FakeBehavior, type FakeEvent } from '../../../quirky.agents/test/support/e2e'

const BRACKETED_PASTE_ON = '\u001b[?2004h'
const PASTE_START = '\u001b[200~'
const PASTE_END = '\u001b[201~'
const NOTICE_HEADING = '## Locked Quirky handoff notice'

let e2e: E2E | undefined
afterEach(async () => {
  await e2e?.cleanup()
  e2e = undefined
})

/** A fake that enables bracketed paste, prints a prompt line and goes quiet. */
const pasteFake = (): FakeBehavior => ({
  raw: true,
  steps: [
    { afterMs: 50, write: BRACKETED_PASTE_ON },
    { afterMs: 10, write: '> \r\n' }
  ]
})

/** The source's agent: prints enough lines that some scroll into the terminal history a brief can capture. */
const chattyFake = (): FakeBehavior => ({
  raw: true,
  steps: [
    { afterMs: 50, write: BRACKETED_PASTE_ON },
    { afterMs: 10, write: Array.from({ length: 120 }, (_, index) => `working on step ${index}\r\n`).join('') + '> \r\n' }
  ]
})

/** A fake that never enables bracketed paste, so no ready signal ever fires. */
const silentFake: FakeBehavior = { raw: true }

const inputOf = (events: FakeEvent[]) =>
  events
    .flatMap((event) => (event.type === 'input' ? [Buffer.from(event.b64, 'base64').toString('utf8')] : []))
    .join('')

const startsOf = (events: FakeEvent[]) => events.filter((event) => event.type === 'start')

type Started = {
  child: { session: string; tab: string; worktreeId: string }
  lineageId: string | null
  worktreeCreated: string | null
  delivery: string
}

async function json<T>(args: string[]): Promise<T> {
  const result = await e2e!.cli(['handoff', ...args, '--json'])
  if (result.code !== 0) throw new Error(`quirky handoff ${args.join(' ')} exited ${result.code}: ${result.stderr || result.stdout}`)
  return JSON.parse(result.stdout) as T
}

/** A claude session in the repo's main worktree, in a tab, with some terminal history. */
async function sourceSession(): Promise<{ id: string; worktreeId: string }> {
  const session = (await e2e!.call('quirky.session/create', { worktree: `path:${e2e!.repo}`, agent: 'claude' })) as {
    id: string
    worktreeId: string
  }
  await e2e!.waitForFakeLog('claude', (log) => startsOf(log).length === 1, 15_000)
  await waitFor(async () => {
    const page = (await e2e!.call('quirky.terminal/history', { session: session.id, lines: 20, format: 'text' })) as { lines: string[] }
    return page.lines.length > 0
  }, 15_000)
  await e2e!.call('quirky.terminal/workspace', { workspace: session.worktreeId, ensure: true })
  return session
}

async function waitFor(check: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('timed out waiting for the source terminal to print')
    await Bun.sleep(25)
  }
}

const layoutOf = async (worktreeId: string) =>
  ((await e2e!.call('quirky.terminal/workspace', { workspace: worktreeId })) as { workspace: { activeGroup: string; root: any } }).workspace

describe('SC-43: a handoff in the same worktree opens beside the source and delivers (CLI)', () => {
  test(
    'the child opens in the source group, gets the brief and notice as one paste then Enter, and the source is untouched',
    async () => {
      e2e = await startAgentsE2E({ fakes: { claude: chattyFake(), gemini: pasteFake() }, timeScale: 0.2 })
      const source = await sourceSession()
      const before = await layoutOf(source.worktreeId)
      const activeBefore = before.root.activeTab
      const sourceInputBefore = inputOf(e2e.fakeLog('claude'))

      const result = await json<Started>(['start', source.id, '--agent', 'gemini', '--note', 'Take over the tests', '--wait'])

      expect(result.delivery).toBe('delivered')
      expect(result.lineageId).toMatch(/^[0-9a-f-]{36}$/)
      const after = await layoutOf(source.worktreeId)
      expect(after.root.tabs.map((tab: { id: string }) => tab.id)).toContain(result.child.tab)
      expect(after.root.activeTab).toBe(activeBefore)
      expect(after.activeGroup).toBe(before.activeGroup)

      const events = await e2e.waitForFakeLog('gemini', (log) => inputOf(log).endsWith(`${PASTE_END}\r`), 15_000)
      expect(startsOf(events)).toHaveLength(1)
      expect((startsOf(events)[0] as { cwd: string }).cwd).toBe(await realpath(e2e.repo))
      const input = inputOf(events)
      expect(input.startsWith(PASTE_START)).toBe(true)
      expect(input.match(/\u001b\[200~/g)).toHaveLength(1)
      expect(input).toContain('Take over the tests')
      expect(input).toContain(`${NOTICE_HEADING}\r`)
      expect(input.indexOf(NOTICE_HEADING)).toBeGreaterThan(input.indexOf('Take over the tests'))
      expect(inputOf(e2e.fakeLog('claude'))).toBe(sourceInputBefore)

      const lineage = await json<{ records: { id: string; relationship: string; parent: { session: string }; child: { session: string } }[] }>([
        'lineage',
        '--session',
        result.child.session
      ])
      expect(lineage.records).toHaveLength(1)
      expect(lineage.records[0]).toMatchObject({ id: result.lineageId, relationship: 'continues', parent: { session: source.id }, child: { session: result.child.session } })
    },
    90_000
  )
})

describe('SC-64: the CLI group covers every action (CLI)', () => {
  test(
    'preview, start, lineage, jump, resend and templates each succeed with --json, and --help lists them',
    async () => {
      e2e = await startAgentsE2E({ fakes: { claude: chattyFake(), gemini: pasteFake(), aider: silentFake }, timeScale: 0.2 })
      const source = await sourceSession()

      const help = await e2e.cli(['handoff', '--help'])
      expect(help.code).toBe(0)
      for (const word of ['preview', 'start', 'resend', 'lineage', 'jump', 'templates list', 'templates add', 'templates edit', 'templates rm', 'templates reset']) {
        expect(help.stdout).toContain(word)
      }

      const preview = await json<{ brief: string; notice: string; warnings: unknown[] }>(['preview', source.id, '--note', 'n'])
      expect(preview.brief).toContain('Continue work from the prior Quirky session.')
      expect(preview.notice.startsWith(NOTICE_HEADING)).toBe(true)

      const started = await json<Started>(['start', source.id, '--agent', 'gemini', '--wait'])
      expect(started.delivery).toBe('delivered')

      const records = await json<{ records: { id: string }[] }>(['lineage'])
      expect(records.records.map((record) => record.id)).toEqual([started.lineageId!])

      const jumped = await json<{ focused: { session: string }; lineageId: string }>(['jump', source.id])
      expect(jumped).toMatchObject({ lineageId: started.lineageId, focused: { session: started.child.session } })

      const silent = await json<Started>(['start', source.id, '--agent', 'aider', '--wait'])
      expect(silent.delivery).toBe('unobservable')
      const resent = await json<{ delivery: string }>(['resend', silent.child.session])
      expect(resent.delivery).toBe('unobservable')

      const listed = await json<{ templates: { id: string }[]; custom: boolean }>(['templates', 'list'])
      expect(listed.custom).toBe(false)
      const added = await json<{ templates: { id: string; name: string }[] }>(['templates', 'add', '--name', 'Mine', '--body', 'x'])
      const mine = added.templates.at(-1)!
      expect(mine.name).toBe('Mine')
      const edited = await json<{ templates: { id: string; name: string }[] }>(['templates', 'edit', mine.id, '--name', 'Renamed'])
      expect(edited.templates.at(-1)!.name).toBe('Renamed')
      expect((await json<{ templates: unknown[] }>(['templates', 'rm', mine.id])).templates).toHaveLength(3)
      expect((await json<{ custom: boolean }>(['templates', 'reset'])).custom).toBe(false)
    },
    120_000
  )
})

describe('SC-49/50: a delivery that cannot be observed leaves a persistent toast and a retained brief (CLI)', () => {
  test(
    'a silent agent gets one blind paste, an unobservable outcome, a persistent Resend brief toast, and no automatic retry',
    async () => {
      e2e = await startAgentsE2E({ fakes: { claude: chattyFake(), aider: silentFake }, timeScale: 0.2 })
      const events: QuirkyEvent[] = []
      e2e.client.onEvent((event) => events.push(event))
      await e2e.client.call('events.subscribe', {})
      const source = await sourceSession()

      const started = await json<Started>(['start', source.id, '--agent', 'aider', '--wait'])

      expect(started.delivery).toBe('unobservable')
      const toast = events.find((event) => event.type === 'notify' && event.key === `handoff:${started.child.session}`)
      expect(toast).toMatchObject({
        kind: 'warning',
        title: 'Brief delivery could not be confirmed.',
        detail: 'Resend is manual because the target Agent does not expose delivery evidence.',
        persistent: true,
        actions: [{ label: 'Resend brief', command: 'command:quirky.handoff/resend-confirm', args: { session: started.child.session }, keepOpen: true }],
        onDismiss: { command: 'command:quirky.handoff/discard', args: { session: started.child.session } }
      })
      const sent = inputOf(e2e.fakeLog('aider'))
      expect(sent.match(/\u001b\[200~/g)).toHaveLength(1)
      expect(sent.endsWith(`${PASTE_END}\r`)).toBe(true)

      const resent = await json<{ delivery: string }>(['resend', started.child.session])
      expect(resent.delivery).toBe('unobservable')
      expect(inputOf(e2e.fakeLog('aider')).match(/\u001b\[200~/g)).toHaveLength(2)
    },
    90_000
  )
})
