import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import type {
  AgentJournalItemBody,
  AgentJournalItemIdentity,
  AgentJournalToolCallItem,
  AgentJournalTurnScope
} from '../../../shared/agent-session-journal-types'
import { agentJournalTurnBody } from '../../../shared/agent-session-turn-record'
import type { JournalItemLinkageVisitor } from '../agent-session-journal/journal-store-contracts'
import {
  StructuredAgentSessionTurnObserver,
  type TurnObserverJournal,
  type TurnObserverWorkspace
} from './structured-agent-session-turn-observer'

const SESSION = 'session-1'

type Row = {
  body: AgentJournalItemBody
  sequence: number
  turnScope: AgentJournalTurnScope
  agentId?: string
}

class FakeJournal implements TurnObserverJournal {
  readonly rows = new Map<string, Row>()
  epoch = 'epoch-1'
  last = 0

  cursor = () => ({ epoch: this.epoch, sequence: this.last })

  itemBody = (itemId: string) => this.rows.get(itemId)?.body ?? null

  visitItemsWithLinkage = (visit: JournalItemLinkageVisitor): void => {
    for (const [itemId, row] of this.rows) {
      visit(itemId, row.sequence, row.body, {
        turnScope: row.turnScope,
        ...(row.agentId ? { agentId: row.agentId } : {})
      })
    }
  }

  appendItem = async (
    identity: AgentJournalItemIdentity,
    body: AgentJournalItemBody,
    options: { fence: number; turnScope: AgentJournalTurnScope }
  ) => {
    this.put(agentJournalItemKey(identity), body, options.turnScope)
  }

  put(itemId: string, body: AgentJournalItemBody, turnScope: AgentJournalTurnScope): void {
    this.last += 1
    const held = this.rows.get(itemId)
    this.rows.set(itemId, { body, turnScope, sequence: held?.sequence ?? this.last })
  }

  turn(turnId: string, state: 'running' | 'completed'): void {
    this.put(
      `turn-item-${turnId}`,
      agentJournalTurnBody({
        turnId,
        state,
        userItemId: 'user',
        startedAt: 1,
        ...(state === 'completed' ? { completedAt: 2, outcome: 'success' } : {})
      }),
      { kind: 'thread' }
    )
  }

  tool(key: string, turnId: string, call: Omit<AgentJournalToolCallItem, 'kind' | 'callId'>): void {
    this.put(
      key,
      { kind: 'tool-call', callId: key, ...call },
      {
        kind: 'turn',
        turnItemId: `turn-item-${turnId}`
      }
    )
  }

  bodiesOfKind(kind: string): AgentJournalItemBody[] {
    return [...this.rows.values()].map((row) => row.body).filter((body) => body.kind === kind)
  }
}

describe('turn observer', () => {
  const temps: string[] = []

  afterEach(() => {
    for (const path of temps.splice(0)) {
      rmSync(path, { recursive: true, force: true })
    }
  })

  function folder(prefix: string): string {
    const path = mkdtempSync(join(tmpdir(), prefix))
    temps.push(path)
    return path
  }

  function repo(): { dir: string; git: (...args: string[]) => string } {
    const dir = folder('quirky-turn-observer-')
    const git = (...args: string[]): string =>
      execFileSync('git', args, { cwd: dir, encoding: 'utf8' })
    git('init', '--quiet')
    git('config', 'user.name', 'Quirky Test')
    git('config', 'user.email', 'quirky@example.test')
    writeFileSync(join(dir, 'app.ts'), 'one\n')
    git('add', 'app.ts')
    git('commit', '--quiet', '-m', 'base')
    return { dir, git }
  }

  function observerFor(workspace: TurnObserverWorkspace | null) {
    const warn = vi.fn()
    const observer = new StructuredAgentSessionTurnObserver({
      workspace: async () => workspace,
      fence: () => 1,
      logger: { warn, error: vi.fn() }
    })
    return { observer, warn }
  }

  function startedJournal(observer: StructuredAgentSessionTurnObserver): FakeJournal {
    const journal = new FakeJournal()
    journal.put('submission', { kind: 'status', text: 'hello', tone: 'muted' }, { kind: 'thread' })
    observer.observe(SESSION, journal)
    return journal
  }

  it('records a git-tree change between the turn start and end, with both trees', async () => {
    const { dir } = repo()
    const { observer } = observerFor({ directory: dir, kind: 'git-worktree' })
    const journal = startedJournal(observer)

    journal.turn('t1', 'running')
    observer.observe(SESSION, journal)
    await observer.idle()
    writeFileSync(join(dir, 'app.ts'), 'one\ntwo\n')
    writeFileSync(join(dir, 'fresh.ts'), 'x\n')
    journal.turn('t1', 'completed')
    observer.observe(SESSION, journal)
    await observer.idle()

    const [changes] = journal.bodiesOfKind('turn-changes')
    expect(changes).toMatchObject({
      kind: 'turn-changes',
      turnId: 't1',
      source: 'git-tree',
      files: [
        { path: 'app.ts', status: 'modified', added: 1, removed: 0 },
        { path: 'fresh.ts', status: 'added', added: 1, removed: 0 }
      ]
    })
    expect(changes).toHaveProperty('fromTree')
    expect(changes).toHaveProperty('toTree')
    expect(
      journal.rows.get(
        agentJournalItemKey({ provider: 'quirky', clientMessageId: 'turn-changes:t1' })
      )?.turnScope
    ).toEqual({
      kind: 'turn',
      turnItemId: 'turn-item-t1'
    })
  })

  it('writes nothing when the turn changed no file', async () => {
    const { dir } = repo()
    const { observer, warn } = observerFor({ directory: dir, kind: 'git-worktree' })
    const journal = startedJournal(observer)

    journal.turn('t1', 'running')
    observer.observe(SESSION, journal)
    await observer.idle()
    journal.turn('t1', 'completed')
    observer.observe(SESSION, journal)
    await observer.idle()

    expect(journal.bodiesOfKind('turn-changes')).toEqual([])
    expect(warn).not.toHaveBeenCalled()
  })

  it('writes nothing for a turn it saw end without seeing it start', async () => {
    const { dir } = repo()
    const { observer } = observerFor({ directory: dir, kind: 'git-worktree' })
    const journal = new FakeJournal()
    journal.turn('t1', 'running')
    observer.observe(SESSION, journal)
    writeFileSync(join(dir, 'app.ts'), 'changed\n')
    journal.turn('t1', 'completed')
    observer.observe(SESSION, journal)
    await observer.idle()

    expect(journal.bodiesOfKind('turn-changes')).toEqual([])
  })

  it('lists only edit-tool files, without trees, for a folder that is not a repository', async () => {
    const dir = folder('quirky-turn-observer-plain-')
    const { observer } = observerFor({ directory: dir, kind: 'folder' })
    const journal = startedJournal(observer)

    journal.turn('t1', 'running')
    observer.observe(SESSION, journal)
    await observer.idle()
    journal.tool('edit-1', 't1', {
      name: 'Edit',
      input: { file_path: join(dir, 'notes.md') },
      state: 'completed'
    })
    journal.tool('edit-2', 't1', {
      name: 'Write',
      input: { file_path: join(dir, 'notes.md') },
      state: 'completed'
    })
    journal.tool('failed-edit', 't1', {
      name: 'Edit',
      input: { file_path: join(dir, 'never.md') },
      state: 'failed'
    })
    journal.tool('shell-1', 't1', {
      name: 'Bash',
      input: { command: 'node rewrite-out-json.js' },
      state: 'completed'
    })
    journal.turn('t1', 'completed')
    observer.observe(SESSION, journal)
    await observer.idle()

    const [changes] = journal.bodiesOfKind('turn-changes')
    expect(changes).toEqual({
      kind: 'turn-changes',
      turnId: 't1',
      source: 'edit-tools',
      files: [{ path: 'notes.md', status: 'modified' }]
    })
    expect(changes).not.toHaveProperty('fromTree')
    expect(changes).not.toHaveProperty('toTree')
  })

  it('writes nothing for a plain folder whose turn edited no file', async () => {
    const dir = folder('quirky-turn-observer-plain-')
    const { observer } = observerFor({ directory: dir, kind: 'folder' })
    const journal = startedJournal(observer)

    journal.turn('t1', 'running')
    observer.observe(SESSION, journal)
    await observer.idle()
    journal.turn('t1', 'completed')
    observer.observe(SESSION, journal)
    await observer.idle()

    expect(journal.bodiesOfKind('turn-changes')).toEqual([])
  })

  it('logs a snapshot failure once for the turn, with the session id, and writes nothing', async () => {
    const warn = vi.fn()
    const observer = new StructuredAgentSessionTurnObserver({
      workspace: async () => ({ directory: '/work', kind: 'git-worktree' }),
      fence: () => 1,
      logger: { warn, error: vi.fn() },
      snapshot: async () => ({ failed: 'index.lock exists' })
    })
    const journal = startedJournal(observer)

    journal.turn('t1', 'running')
    observer.observe(SESSION, journal)
    await observer.idle()
    journal.turn('t1', 'completed')
    observer.observe(SESSION, journal)
    await observer.idle()

    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]?.[1]).toMatchObject({ sessionId: SESSION, turnId: 't1' })
    expect(journal.bodiesOfKind('turn-changes')).toEqual([])
  })

  it('writes a running test result at call start and the final one at completion', async () => {
    const { observer } = observerFor(null)
    const journal = startedJournal(observer)

    journal.tool('call-1', 't1', {
      name: 'Bash',
      input: { command: 'pnpm test' },
      state: 'running'
    })
    observer.observe(SESSION, journal)
    await observer.idle()
    expect(journal.bodiesOfKind('test-result')).toMatchObject([
      { callId: 'call-1', state: 'running', command: 'pnpm test' }
    ])

    journal.tool('call-1', 't1', {
      name: 'Bash',
      input: { command: 'pnpm test' },
      state: 'completed',
      exitCode: 0,
      output: {
        head: `${'x\n'.repeat(100)}Tests 41 passed`,
        byteLength: 1,
        digest: 'd',
        truncated: false
      }
    })
    observer.observe(SESSION, journal)
    await observer.idle()

    expect(journal.bodiesOfKind('test-result')).toMatchObject([
      { callId: 'call-1', state: 'passed', passed: 41 }
    ])
  })

  it('writes nothing for shell calls that are not test runs', async () => {
    const { observer } = observerFor(null)
    const journal = startedJournal(observer)

    journal.tool('call-1', 't1', { name: 'Bash', input: { command: 'ls' }, state: 'completed' })
    observer.observe(SESSION, journal)
    await observer.idle()

    expect(journal.bodiesOfKind('test-result')).toEqual([])
  })

  it('does not derive from history it saw only as the first commit', async () => {
    const { observer } = observerFor(null)
    const journal = new FakeJournal()
    journal.tool('old', 't0', {
      name: 'Bash',
      input: { command: 'pytest' },
      state: 'completed',
      output: { head: '3 passed', byteLength: 1, digest: 'd', truncated: false }
    })

    observer.observe(SESSION, journal)
    await observer.idle()

    expect(journal.bodiesOfKind('test-result')).toEqual([])
  })
})
