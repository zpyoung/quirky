import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import type { ProcessRunner, RunOptions, RunResult } from '@quirky/protocol'
import { InputTracker } from '../src/input-tracker'
import { appendTab, emptyWorkspace, makeTab } from '../src/layout/ops'
import { LayoutService } from '../src/layout/service'
import { sequentialIds } from '../src/layout/tree'
import type { Workspace } from '../src/layout/types'

const PS_ARGV = ['ps', '-A', '-o', 'pid=,ppid=,comm=']
const PROCESS_TABLE = '201 101 /bin/sleep\n202 102 /usr/bin/vim\n'
const CALL = { argv: PS_ARGV, options: { rerunnable: true } }

type TabSpec = { title: string; session: string; agent?: string; status?: string }
type RunCall = { argv: string[]; options?: RunOptions }

function runResult(stdoutText: string, overrides: Partial<RunResult> = {}): RunResult {
  return {
    stdout: new TextEncoder().encode(stdoutText),
    stdoutText,
    stderr: '',
    exitCode: 0,
    signal: null,
    durationMs: 0,
    ...overrides
  }
}

function makeFixture(specs: TabSpec[], ptyRows: unknown[], run: (call: number) => Promise<RunResult>) {
  const calls: RunCall[] = []
  const process: ProcessRunner = {
    run: async (argv, options) => {
      calls.push({ argv: [...argv], ...(options === undefined ? {} : { options }) })
      return run(calls.length - 1)
    }
  }
  const ids = sequentialIds(1)
  let workspace = emptyWorkspace('floating', ids)
  const tabs = specs.map((spec) => makeTab(ids, { defaultTitle: spec.title, session: spec.session, now: 'now' }))
  for (const tab of tabs) {
    workspace = (appendTab(workspace, workspace.activeGroup, tab) as { ok: true; value: Workspace }).value
  }
  const store = {
    loadWorkspaces: () => ({ workspaces: [workspace], unreadable: [] }),
    counter: () => 20,
    floating: () => ({})
  }
  const sessions = new Map(specs.map((spec) => [spec.session, {
    id: spec.session,
    kind: 'terminal',
    agent: spec.agent ?? 'shell',
    status: spec.status ?? 'running',
    title: spec.title
  }]))
  const context = {
    log: () => {},
    error: (_kind: string, message: string) => Object.assign(new Error(message), { code: 0 }),
    pty: { list: async () => ptyRows },
    call: async (_method: string, params: Record<string, unknown>) => sessions.get(params.session as string),
    process
  }
  const service = new LayoutService(context as never, store as never, new InputTracker())
  const describe = () => service.methods.describeClose!({ tab: tabs[0]!.id, which: 'others' }, {} as never)
  return { calls, describe, tabs }
}

const shellSpecs: TabSpec[] = [
  { title: 'Anchor', session: 'anchor' },
  { title: 'One', session: 'one' },
  { title: 'Two', session: 'two' }
]
const shellRows = [
  { sessionId: 'one', pid: 101, alive: true },
  { sessionId: 'two', pid: 102, alive: true }
]
const failures: { name: string; result?: RunResult; reject?: Error }[] = [
  { name: 'nonzero exit', result: runResult(PROCESS_TABLE, { exitCode: 1 }) },
  { name: 'signal termination', result: runResult(PROCESS_TABLE, { exitCode: null, signal: 'SIGTERM' }) },
  { name: 'spawn failure', result: runResult(PROCESS_TABLE, { exitCode: null, spawnError: { code: 'ENOENT', message: 'no ps' } }) },
  { name: 'timeout', result: runResult(PROCESS_TABLE, { exitCode: null, signal: 'SIGTERM', stopped: 'timeout' }) },
  { name: 'abort', result: runResult(PROCESS_TABLE, { exitCode: null, signal: 'SIGTERM', stopped: 'aborted' }) },
  { name: 'overflow', result: runResult(PROCESS_TABLE, { exitCode: null, signal: 'SIGTERM', stopped: 'overflow' }) },
  { name: 'runner rejection', reject: new Error('runner failed') }
]

let syncSpawn: { mockRestore(): void } | undefined

beforeEach(() => {
  syncSpawn = spyOn(Bun, 'spawnSync').mockImplementation(() => {
    throw new Error('sync process entrypoint forbidden')
  })
})

afterEach(() => {
  syncSpawn?.mockRestore()
})

test('waits for one process table and names children in the close description', async () => {
  const held = Promise.withResolvers<RunResult>()
  const fixture = makeFixture(shellSpecs, shellRows, () => held.promise)
  let settled = false
  let nextTurnRan = false
  const description = fixture.describe().then((value) => {
    settled = true
    return value
  })
  const nextTurn = Promise.withResolvers<void>()
  setImmediate(() => {
    nextTurnRan = true
    nextTurn.resolve()
  })
  await nextTurn.promise

  expect(nextTurnRan).toBe(true)
  expect(settled).toBe(false)
  expect(fixture.calls).toEqual([CALL])
  held.resolve(runResult(PROCESS_TABLE))
  expect(await description).toBe('Stop sleep in One?\nStop vim in Two?')
  expect(fixture.calls).toEqual([CALL])
})

for (const failure of failures) {
  test(`asks about both shells after one ${failure.name}`, async () => {
    const fixture = makeFixture(shellSpecs, shellRows, () =>
      failure.reject ? Promise.reject(failure.reject) : Promise.resolve(failure.result!)
    )

    expect(await fixture.describe()).toBe('Stop the session in One?\nStop the session in Two?')
    expect(fixture.calls).toEqual([CALL])
  })
}

test('a later description request reads a fresh table after an earlier failure', async () => {
  const fixture = makeFixture(shellSpecs, shellRows, (call) =>
    Promise.resolve(call === 0 ? runResult(PROCESS_TABLE, { exitCode: 1 }) : runResult('201 101 /bin/cat\n202 102 /bin/grep\n'))
  )

  expect(await fixture.describe()).toBe('Stop the session in One?\nStop the session in Two?')
  expect(await fixture.describe()).toBe('Stop cat in One?\nStop grep in Two?')
  expect(fixture.calls).toEqual([CALL, CALL])
})

test('agent, exited and missing-PTY tabs never request a process table', async () => {
  const fixture = makeFixture([
    { title: 'Anchor', session: 'anchor' },
    { title: 'Agent', session: 'agent', agent: 'claude' },
    { title: 'Exited', session: 'exited', status: 'exited' },
    { title: 'No PTY', session: 'no-pty' }
  ], [], async () => runResult(''))

  expect(await fixture.describe()).toBe('Stop agent Agent?\nStop the session in No PTY?')
  expect(fixture.calls).toEqual([])
})

test('an idle live shell reads an empty table and needs no confirmation', async () => {
  const fixture = makeFixture(shellSpecs.slice(0, 2), [{ sessionId: 'one', pid: 101, alive: true }], async () => runResult(''))

  expect(await fixture.describe()).toBeNull()
  expect(fixture.calls).toEqual([CALL])
})
