import { afterAll, afterEach, beforeEach, describe, expect, jest, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { registerDom } from './ui/register-dom'
import type { GitStatus, MountFunction, UiPluginContext } from '@quirky/protocol'
import type { Fake } from './ui/panel-support'
import type { StatusData } from '../src/panel/data'

registerDom()
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const s = await import('./ui/panel-support')
const { act, buttonText, click, entry, failure, fakeContext, layoutFor, PANEL, rowOf, settle, statusOf } = s
const { activate } = await import('../src/ui')
// Load React DOM only after happy-dom registration, matching the existing UI test harness.
const { createElement, useEffect } = await import('react')
const { createRoot } = await import('react-dom/client')
const { useStatus } = await import('../src/panel/data')

type Mount = MountFunction
type ConnectionStatus = 'connected' | 'reconnecting'
const STATUS_BAR_ID = 'status-bar:quirky.git/ahead-behind'
const mountedDisposers = new Set<() => void>()

afterAll(() => GlobalRegistrator.unregister())
beforeEach(() => {
  document.body.innerHTML = ''
})

afterEach(() => {
  for (const dispose of [...mountedDisposers]) dispose()
})

type MountedGitContributions = {
  panel: HTMLElement
  statusBar: HTMLElement
  unmount(): void
}

type GitContributions = {
  activationListeners: number
  mount(): MountedGitContributions
}

function providedContributions(fake: Fake): GitContributions {
  void activate(fake.context)
  const panelMount = fake.provided.get(PANEL) as Mount | undefined
  const statusBarMount = fake.provided.get(STATUS_BAR_ID) as Mount | undefined
  if (!panelMount || !statusBarMount) throw new Error('activate did not provide the Git panel and status bar')
  const activationListeners = fake.listeners().events

  return {
    activationListeners,
    mount(): MountedGitContributions {
      const panel = document.createElement('div')
      const statusBar = document.createElement('div')
      document.body.append(panel, statusBar)
      let panelCleanup: (() => void) | void
      let statusBarCleanup: (() => void) | void
      act(() => {
        panelCleanup = panelMount(panel, { report: (state) => fake.reports.push(state) })
        statusBarCleanup = statusBarMount(statusBar, {})
      })
      let mounted = true
      const unmount = () => {
        if (!mounted) return
        mounted = false
        mountedDisposers.delete(unmount)
        act(() => {
          panelCleanup?.()
          statusBarCleanup?.()
        })
        panel.remove()
        statusBar.remove()
      }
      mountedDisposers.add(unmount)
      return { panel, statusBar, unmount }
      }
    }
  }

const statusCalls = (fake: Fake) => fake.called('quirky.git/status')
const advanceTimersByTime = (ms: number) =>
  (jest as unknown as { advanceTimersByTime(ms: number): void }).advanceTimersByTime(ms)

async function advance(ms: number): Promise<void> {
  await act(async () => advanceTimersByTime(ms))
  await settle()
}

async function gitChanged(fake: Fake, worktreeId: string): Promise<void> {
  await act(async () => fake.emit({ type: 'quirky.git/changed', data: { worktreeId } }))
  await settle()
}

async function stagePath(panel: HTMLElement, path: string): Promise<void> {
  const row = rowOf(panel, path)
  if (!row) throw new Error(`missing Changes row ${path}`)
  await act(async () => {
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 5, clientY: 5 }))
  })
  await settle()
  await click(buttonText(document.body, 'Stage'))
}

function connectionBus(fake: Fake) {
  const listeners = new Set<(status: ConnectionStatus) => void>()
  fake.context.onConnection = (listener) => {
    listeners.add(listener)
    return () => listeners.delete(listener)
  }
  return {
    emit(status: ConnectionStatus) {
      for (const listener of [...listeners]) listener(status)
    },
    size: () => listeners.size
  }
}

type StatusProbeProps = {
  context: UiPluginContext
  worktree: string
  receive: (status: StatusData) => void
}

type StatusProbeMount = {
  current(): StatusData | null
  render(worktree: string): void
  unmount(): void
}

function StatusProbe({ context, worktree, receive }: StatusProbeProps) {
  const status = useStatus(context, worktree)
  useEffect(() => {
    receive(status)
  }, [status, receive])
  return null
}

function mountStatusProbe(fake: Fake, initialWorktree: string): StatusProbeMount {
  const element = document.createElement('div')
  document.body.appendChild(element)
  const root = createRoot(element)
  let current: StatusData | null = null
  const receive = (status: StatusData): void => {
    current = status
  }
  const render = (worktree: string): void => {
    act(() => root.render(createElement(StatusProbe, { key: worktree, context: fake.context, worktree, receive })))
  }
  render(initialWorktree)
  let mounted = true
  const unmount = () => {
    if (!mounted) return
    mounted = false
    mountedDisposers.delete(unmount)
    act(() => root.unmount())
    element.remove()
  }
  mountedDisposers.add(unmount)
  return { current: () => current, render, unmount }
}

describe('quirky.git shared automatic status resource', () => {
  test('the provided Changes panel, status bar, and GitHub lookup share one request per window', async () => {
    const firstFake = fakeContext(layoutFor('shared'))
    firstFake.status = statusOf([], {
      branch: 'first-window-branch',
      head: '1'.repeat(40),
      ahead: 2,
      behind: 1
    })
    const secondFake = fakeContext(layoutFor('shared'))
    secondFake.status = statusOf([], {
      branch: 'second-window-branch',
      head: '2'.repeat(40),
      ahead: 8,
      behind: 3
    })
    const first = providedContributions(firstFake).mount()
    const second = providedContributions(secondFake).mount()
    await settle()

    expect(statusCalls(firstFake)).toHaveLength(1)
    expect(statusCalls(secondFake)).toHaveLength(1)
    expect(first.panel.textContent).toContain('first-window-branch')
    expect(second.panel.textContent).toContain('second-window-branch')
    expect(first.statusBar.textContent).toContain('↑2 ↓1')
    expect(second.statusBar.textContent).toContain('↑8 ↓3')
    expect(firstFake.called('quirky.hosting/forBranch').at(-1)?.params).toEqual({
      worktree: 'shared',
      branch: 'first-window-branch',
      headOid: '1'.repeat(40)
    })
    expect(secondFake.called('quirky.hosting/forBranch').at(-1)?.params).toEqual({
      worktree: 'shared',
      branch: 'second-window-branch',
      headOid: '2'.repeat(40)
    })

    first.unmount()
    second.unmount()
  })

  test('ten matching invalidations start only one trailing read at 3000 ms and publish the latest snapshot', async () => {
    jest.useFakeTimers()
    try {
      const fake = fakeContext(layoutFor('storm'))
      fake.status = statusOf([entry('before.ts')], {
        branch: 'before-storm',
        head: 'a'.repeat(40),
        ahead: 1,
        behind: 0
      })
      const mounted = providedContributions(fake).mount()
      await settle()
      expect(statusCalls(fake)).toHaveLength(1)

      fake.statuses.storm = statusOf([entry('latest.ts')], {
        branch: 'after-storm',
        head: 'b'.repeat(40),
        ahead: 4,
        behind: 2
      })
      for (let index = 0; index < 10; index += 1) {
        await gitChanged(fake, 'storm')
        if (index < 9) await advance(10)
      }
      expect(statusCalls(fake)).toHaveLength(1)
      await advance(2_909)
      expect(statusCalls(fake)).toHaveLength(1)
      await advance(1)

      expect(statusCalls(fake)).toHaveLength(2)
      expect(mounted.panel.textContent).toContain('after-storm')
      expect(mounted.panel.textContent).toContain('latest.ts')
      expect(mounted.statusBar.textContent).toContain('↑4 ↓2')
      expect(fake.called('quirky.hosting/forBranch').at(-1)?.params).toEqual({
        worktree: 'storm',
        branch: 'after-storm',
        headOid: 'b'.repeat(40)
      })
      mounted.unmount()
    } finally {
      jest.useRealTimers()
    }
  })

  test('a successful stage waits for a fresh post-invocation status, not an unresolved poll', async () => {
    jest.useFakeTimers()
    try {
      const fake = fakeContext(layoutFor('mutation'))
      fake.status = statusOf([entry('stage-me.ts')], {
        branch: 'before-mutation',
        head: 'a'.repeat(40)
      })
      const mounted = providedContributions(fake).mount()
      await settle()
      expect(statusCalls(fake)).toHaveLength(1)

      const oldRead = Promise.withResolvers<unknown>()
      const freshRead = Promise.withResolvers<unknown>()
      let readsAfterMount = 0
      fake.on('quirky.git/status', () => {
        readsAfterMount += 1
        if (readsAfterMount === 1) return oldRead.promise
        if (readsAfterMount === 2) return freshRead.promise
        return statusOf([entry('after-mutation.ts')], {
          branch: 'after-mutation',
          head: 'd'.repeat(40)
        })
      })
      await advance(3_000)
      expect(statusCalls(fake)).toHaveLength(2)

      const reviewsBeforeStage = fake.called('quirky.git/review').length
      await stagePath(mounted.panel, 'stage-me.ts')
      expect(fake.called('quirky.git/stage')).toHaveLength(1)
      expect(statusCalls(fake)).toHaveLength(3)

      fake.status = statusOf([entry('after-mutation.ts')], {
        branch: 'before-mutation',
        head: 'd'.repeat(40)
      })
      await act(async () => freshRead.resolve(fake.status))
      await settle()
      expect(mounted.panel.textContent).toContain('before-mutation')
      expect(mounted.panel.textContent).toContain('after-mutation.ts')
      expect(fake.called('quirky.git/review').length).toBeGreaterThan(reviewsBeforeStage)

      await act(async () => oldRead.resolve(statusOf([entry('pre-mutation-late.ts')], {
        branch: 'pre-mutation-late',
        head: 'c'.repeat(40)
      })))
      await settle()
      expect(mounted.panel.textContent).toContain('before-mutation')
      expect(mounted.panel.textContent).not.toContain('pre-mutation-late')
      expect(mounted.panel.textContent).not.toContain('pre-mutation-late.ts')
      expect(statusCalls(fake)).toHaveLength(3)

      await advance(2_999)
      expect(statusCalls(fake)).toHaveLength(3)
      await advance(1)
      expect(statusCalls(fake)).toHaveLength(4)
      mounted.unmount()
    } finally {
      jest.useRealTimers()
    }
  })

  test('Changes retains its last good snapshot through shared errors and recovers after a folder refusal', async () => {
    jest.useFakeTimers()
    try {
      const fake = fakeContext(layoutFor('errors'))
      fake.status = statusOf([entry('last-good.ts')], {
        branch: 'last-good',
        head: 'a'.repeat(40),
        ahead: 3,
        behind: 1
      })
      const mounted = providedContributions(fake).mount()
      await settle()
      expect(statusCalls(fake)).toHaveLength(1)

      fake.on('quirky.git/status', () => {
        throw failure('temporary status failure')
      })
      await advance(3_000)
      expect(statusCalls(fake)).toHaveLength(2)
      expect(mounted.panel.textContent).toContain('last-good.ts')
      expect(mounted.panel.textContent).toContain('temporary status failure')
      expect(mounted.statusBar.textContent).toBe('')

      fake.on('quirky.git/status', () => {
        throw failure('folder workspace has no repository', { reason: 'folder-workspace' })
      })
      await advance(3_000)
      expect(statusCalls(fake)).toHaveLength(3)
      expect(mounted.panel.textContent).toContain('folder workspace has no repository')
      expect(mounted.statusBar.textContent).toBe('')

      fake.status = statusOf([entry('recovered.ts')], {
        branch: 'recovered',
        head: 'b'.repeat(40),
        ahead: 5,
        behind: 2
      })
      fake.on('quirky.git/status', () => fake.status)
      await advance(3_000)
      expect(statusCalls(fake)).toHaveLength(4)
      expect(mounted.panel.textContent).toContain('recovered.ts')
      expect(mounted.panel.textContent).not.toContain('temporary status failure')
      expect(mounted.panel.textContent).not.toContain('folder workspace has no repository')
      expect(mounted.statusBar.textContent).toContain('↑5 ↓2')
      mounted.unmount()
    } finally {
      jest.useRealTimers()
    }
  })

  test('mount and duplicate connected notifications share one read; reconnecting to connected reads once and resets spacing', async () => {
    jest.useFakeTimers()
    try {
      const fake = fakeContext(layoutFor('connection'))
      fake.status = statusOf([], { branch: 'connection-branch', head: 'a'.repeat(40) })
      const connections = connectionBus(fake)
      const mounted = providedContributions(fake).mount()
      await settle()
      expect(statusCalls(fake)).toHaveLength(1)
      expect(connections.size()).toBe(1)

      await act(async () => {
        connections.emit('connected')
        connections.emit('connected')
      })
      await settle()
      expect(statusCalls(fake)).toHaveLength(1)

      await advance(2_000)
      await act(async () => connections.emit('reconnecting'))
      await settle()
      expect(statusCalls(fake)).toHaveLength(1)
      await act(async () => connections.emit('connected'))
      await settle()
      expect(statusCalls(fake)).toHaveLength(2)
      await act(async () => connections.emit('connected'))
      await settle()
      expect(statusCalls(fake)).toHaveLength(2)

      await advance(2_999)
      expect(statusCalls(fake)).toHaveLength(2)
      await advance(1)
      expect(statusCalls(fake)).toHaveLength(3)
      mounted.unmount()
      expect(connections.size()).toBe(0)
    } finally {
      jest.useRealTimers()
    }
  })

  async function switchWithLateAResult(kind: 'value' | 'error'): Promise<void> {
    jest.useFakeTimers()
    try {
      const fake = fakeContext(layoutFor('A'))
      fake.statuses.A = statusOf([entry('a.ts')], {
        branch: 'branch-A',
        head: 'a'.repeat(40),
        ahead: 1,
        behind: 0
      })
      fake.statuses.B = statusOf([entry('b.ts')], {
        branch: 'branch-B',
        head: 'b'.repeat(40),
        ahead: 8,
        behind: 1
      })
      const lateARead = Promise.withResolvers<unknown>()
      let holdA = false
      fake.on('quirky.git/status', (params) => {
        if (holdA && params.worktree === 'A') return lateARead.promise
        return fake.statuses[String(params.worktree)] ?? fake.status
      })
      const mounted = providedContributions(fake).mount()
      await settle()
      expect(statusCalls(fake)).toHaveLength(1)

      holdA = true
      await advance(3_000)
      expect(statusCalls(fake)).toHaveLength(2)
      await act(async () => fake.setLayout(layoutFor('B')))
      await settle()
      expect(statusCalls(fake).filter(({ params }) => params.worktree === 'B')).toHaveLength(1)
      expect(mounted.panel.textContent).toContain('branch-B')
      expect(mounted.statusBar.textContent).toContain('↑8 ↓1')

      if (kind === 'value') {
        await act(async () => lateARead.resolve(statusOf([entry('late-a.ts')], {
          branch: 'late-branch-A',
          head: 'c'.repeat(40),
          ahead: 99,
          behind: 0
        })))
      } else {
        await act(async () => lateARead.reject(failure('late A failure')))
      }
      await settle()
      expect(mounted.panel.textContent).toContain('branch-B')
      expect(mounted.panel.textContent).not.toContain('late-branch-A')
      expect(mounted.panel.textContent).not.toContain('late A failure')
      expect(mounted.statusBar.textContent).toContain('↑8 ↓1')
      expect(mounted.statusBar.textContent).not.toContain('↑99')
      mounted.unmount()
    } finally {
      jest.useRealTimers()
    }
  }

  test('switching worktrees fences an unresolved old status value', async () => {
    await switchWithLateAResult('value')
  })

  test('switching worktrees fences an unresolved old status error', async () => {
    await switchWithLateAResult('error')
  })

  test('a GitHub lookup waiter, dirty poll, and late response retire when the last consumer unmounts', async () => {
    jest.useFakeTimers()
    try {
      const fake = fakeContext(layoutFor('retire'))
      fake.status = statusOf([], { branch: 'retire-branch', head: 'a'.repeat(40) })
      const contributions = providedContributions(fake)
      const mounted = contributions.mount()
      await settle()
      expect(statusCalls(fake)).toHaveLength(1)

      const pending = Promise.withResolvers<unknown>()
      fake.on('quirky.git/status', () => pending.promise)
      await advance(3_000)
      expect(statusCalls(fake)).toHaveLength(2)
      await gitChanged(fake, 'retire')
      await act(async () => fake.emit({
        type: 'quirky.hosting/reviewCacheChanged',
        data: { worktreeId: 'retire' }
      }))
      await settle()
      expect(statusCalls(fake)).toHaveLength(2)
      const hostingReads = fake.called('quirky.hosting/cachedReviews').length + fake.called('quirky.hosting/forBranch').length

      mounted.unmount()
      expect(fake.listeners().events).toBe(contributions.activationListeners)
      await act(async () => pending.resolve(statusOf([entry('late-retired.ts')], {
        branch: 'late-retired',
        head: 'b'.repeat(40)
      })))
      await settle()
      expect(fake.called('quirky.hosting/cachedReviews').length + fake.called('quirky.hosting/forBranch').length).toBe(hostingReads)
      await advance(6_000)
      expect(statusCalls(fake)).toHaveLength(2)
    } finally {
      jest.useRealTimers()
    }
  })

  test('a transient remount keeps the activation target cooldown instead of dispatching as cold', async () => {
    jest.useFakeTimers()
    try {
      const fake = fakeContext(layoutFor('remount'))
      fake.status = statusOf([entry('before-remount.ts')], {
        branch: 'before-remount',
        head: 'a'.repeat(40)
      })
      const contributions = providedContributions(fake)
      const first = contributions.mount()
      await settle()
      expect(statusCalls(fake)).toHaveLength(1)
      await advance(100)
      first.unmount()

      fake.status = statusOf([entry('after-remount.ts')], {
        branch: 'after-remount',
        head: 'b'.repeat(40)
      })
      const remounted = contributions.mount()
      await settle()
      expect(statusCalls(fake)).toHaveLength(1)
      expect(remounted.panel.textContent).not.toContain('before-remount')
      await advance(2_899)
      expect(statusCalls(fake)).toHaveLength(1)
      await advance(1)
      expect(statusCalls(fake)).toHaveLength(2)
      expect(remounted.panel.textContent).toContain('after-remount')
      remounted.unmount()
    } finally {
      jest.useRealTimers()
    }
  })
  test('invalidations during an unresolved automatic read retain only one trailing request', async () => {
    jest.useFakeTimers()
    let mounted: MountedGitContributions | null = null
    try {
      const fake = fakeContext(layoutFor('busy'))
      fake.status = statusOf([entry('before.ts')], { branch: 'before-busy', head: 'a'.repeat(40) })
      const surface = providedContributions(fake).mount()
      mounted = surface
      await settle()
      expect(statusCalls(fake)).toHaveLength(1)

      const oldRead = Promise.withResolvers<unknown>()
      let readsAfterMount = 0
      fake.on('quirky.git/status', () => {
        readsAfterMount += 1
        return readsAfterMount === 1
          ? oldRead.promise
          : statusOf([entry('latest-during-read.ts')], { branch: 'latest-during-read', head: 'b'.repeat(40) })
      })
      await advance(3_000)
      expect(statusCalls(fake)).toHaveLength(2)
      fake.status = statusOf([entry('latest-during-read.ts')], {
        branch: 'latest-during-read',
        head: 'b'.repeat(40)
      })
      for (let index = 0; index < 10; index += 1) {
        await gitChanged(fake, 'busy')
        if (index < 9) await advance(10)
      }
      expect(statusCalls(fake)).toHaveLength(2)

      await act(async () => oldRead.resolve(statusOf([entry('old-pending-result.ts')], {
        branch: 'old-pending-result',
        head: 'c'.repeat(40)
      })))
      await settle()
      await advance(2_909)
      expect(statusCalls(fake)).toHaveLength(2)
      await advance(1)
      expect(statusCalls(fake)).toHaveLength(3)
      expect(surface.panel.textContent).toContain('latest-during-read')
      expect(surface.panel.textContent).toContain('latest-during-read.ts')
      expect(surface.panel.textContent).not.toContain('old-pending-result')
    } finally {
      mounted?.unmount()
      jest.useRealTimers()
    }
  })

  test('fresh StatusData waiters registered together share one read after an older automatic read', async () => {
    jest.useFakeTimers()
    let probe: StatusProbeMount | null = null
    try {
      const fake = fakeContext(layoutFor('fresh-waiters'))
      fake.status = statusOf([], { branch: 'initial', head: 'a'.repeat(40) })
      probe = mountStatusProbe(fake, 'fresh-waiters')
      await settle()
      expect(statusCalls(fake)).toHaveLength(1)

      const oldRead = Promise.withResolvers<unknown>()
      const freshRead = Promise.withResolvers<unknown>()
      let readsAfterMount = 0
      fake.on('quirky.git/status', () => {
        readsAfterMount += 1
        return readsAfterMount === 1 ? oldRead.promise : freshRead.promise
      })
      await advance(3_000)
      expect(statusCalls(fake)).toHaveLength(2)

      const data = probe.current()
      if (!data) throw new Error('StatusData probe did not mount')
      let firstState: 'pending' | 'resolved' | 'rejected' = 'pending'
      let secondState: 'pending' | 'resolved' | 'rejected' = 'pending'
      let first!: Promise<GitStatus | null>
      let second!: Promise<GitStatus | null>
      await act(async () => {
        first = data.refresh()
        second = data.refresh()
      })
      void first.then(() => { firstState = 'resolved' }, () => { firstState = 'rejected' })
      void second.then(() => { secondState = 'resolved' }, () => { secondState = 'rejected' })
      await settle()
      expect(statusCalls(fake)).toHaveLength(3)

      await act(async () => oldRead.resolve(statusOf([], { branch: 'old-before-barrier', head: 'c'.repeat(40) })))
      await settle()
      expect(firstState).toBe('pending')
      expect(secondState).toBe('pending')
      expect(probe.current()?.status?.branch).toBe('initial')

      const freshStatus = statusOf([entry('fresh.ts')], { branch: 'fresh-after-barrier', head: 'd'.repeat(40) })
      await act(async () => freshRead.resolve(freshStatus))
      await settle()
      expect(await first).toEqual(freshStatus)
      expect(await second).toEqual(freshStatus)
      expect(probe.current()?.status?.branch).toBe('fresh-after-barrier')
      expect(statusCalls(fake)).toHaveLength(3)
    } finally {
      probe?.unmount()
      jest.useRealTimers()
    }
  })

  test('a rejected pre-barrier read cannot reject or strand a later fresh waiter', async () => {
    jest.useFakeTimers()
    let probe: StatusProbeMount | null = null
    try {
      const fake = fakeContext(layoutFor('retry-barrier'))
      fake.status = statusOf([], { branch: 'initial', head: 'a'.repeat(40) })
      probe = mountStatusProbe(fake, 'retry-barrier')
      await settle()
      expect(statusCalls(fake)).toHaveLength(1)

      const oldRead = Promise.withResolvers<unknown>()
      const freshRead = Promise.withResolvers<unknown>()
      let readsAfterMount = 0
      fake.on('quirky.git/status', () => {
        readsAfterMount += 1
        return readsAfterMount === 1 ? oldRead.promise : freshRead.promise
      })
      await advance(3_000)
      const data = probe.current()
      if (!data) throw new Error('StatusData probe did not mount')
      let outcome: 'pending' | 'resolved' | 'rejected' = 'pending'
      let value: unknown
      let refresh!: Promise<GitStatus | null>
      await act(async () => {
        refresh = data.refresh()
      })
      void refresh.then((result) => {
        outcome = 'resolved'
        value = result
      }, () => {
        outcome = 'rejected'
      })
      await settle()
      expect(statusCalls(fake)).toHaveLength(3)

      await act(async () => oldRead.reject(failure('pre-barrier read failed')))
      await settle()
      expect(outcome).toBe('pending')
      expect(probe.current()?.error).toBeNull()

      const freshStatus = statusOf([entry('retry-fresh.ts')], { branch: 'fresh-after-rejection', head: 'b'.repeat(40) })
      await act(async () => freshRead.resolve(freshStatus))
      await settle()
      expect<string>(outcome).toBe('resolved')
      expect(value).toEqual(freshStatus)
      expect(probe.current()?.status?.branch).toBe('fresh-after-rejection')
      expect(statusCalls(fake)).toHaveLength(3)
    } finally {
      probe?.unmount()
      jest.useRealTimers()
    }
  })

  test('a rejected fresh read resolves null, exposes its error, and permits a later retry', async () => {
    jest.useFakeTimers()
    let probe: StatusProbeMount | null = null
    try {
      const fake = fakeContext(layoutFor('fresh-error'))
      fake.status = statusOf([entry('kept.ts')], { branch: 'last-good', head: 'a'.repeat(40) })
      probe = mountStatusProbe(fake, 'fresh-error')
      await settle()
      expect(statusCalls(fake)).toHaveLength(1)

      let readsAfterMount = 0
      const recovered = statusOf([entry('recovered.ts')], { branch: 'recovered', head: 'b'.repeat(40) })
      fake.on('quirky.git/status', () => {
        readsAfterMount += 1
        if (readsAfterMount === 1) throw failure('fresh status failed')
        return recovered
      })
      const initial = probe.current()
      if (!initial) throw new Error('StatusData probe did not mount')
      let failed!: Promise<GitStatus | null>
      await act(async () => {
        failed = initial.refresh()
      })
      await settle()
      expect(await failed).toBeNull()
      expect(statusCalls(fake)).toHaveLength(2)
      expect(probe.current()?.error).toContain('fresh status failed')
      expect(probe.current()?.status?.branch).toBe('last-good')

      const current = probe.current()
      if (!current) throw new Error('StatusData probe did not rerender')
      let retry!: Promise<GitStatus | null>
      await act(async () => {
        retry = current.refresh()
      })
      expect(await retry).toEqual(recovered)
      await settle()
      expect(statusCalls(fake)).toHaveLength(3)
      expect(probe.current()?.error).toBeNull()
      expect(probe.current()?.status?.branch).toBe('recovered')
    } finally {
      probe?.unmount()
      jest.useRealTimers()
    }
  })

  test('retiring a target aborts its fresh waiter without waiting for the old wire request', async () => {
    jest.useFakeTimers()
    let probe: StatusProbeMount | null = null
    try {
      const fake = fakeContext(layoutFor('A'))
      fake.statuses.A = statusOf([], { branch: 'branch-A', head: 'a'.repeat(40) })
      fake.statuses.B = statusOf([], { branch: 'branch-B', head: 'b'.repeat(40) })
      probe = mountStatusProbe(fake, 'A')
      await settle()
      expect(statusCalls(fake)).toHaveLength(1)

      const pendingA = Promise.withResolvers<unknown>()
      fake.on('quirky.git/status', (params) =>
        params.worktree === 'A' ? pendingA.promise : fake.statuses[String(params.worktree)] ?? fake.status)
      const data = probe.current()
      if (!data) throw new Error('StatusData probe did not mount')
      let outcome: 'pending' | 'resolved' | 'rejected' = 'pending'
      let resolvedNull = false
      let refresh!: Promise<GitStatus | null>
      await act(async () => {
        refresh = data.refresh()
      })
      void refresh.then((result) => {
        outcome = 'resolved'
        resolvedNull = result === null
      }, () => {
        outcome = 'rejected'
      })
      await settle()
      expect(statusCalls(fake)).toHaveLength(2)

      probe.render('B')
      await settle()
      expect(statusCalls(fake).filter(({ params }) => params.worktree === 'B')).toHaveLength(1)
      expect<string>(outcome).toBe('resolved')
      expect(resolvedNull).toBe(true)
      expect(probe.current()?.status?.branch).toBe('branch-B')

      await act(async () => pendingA.resolve(statusOf([], { branch: 'late-A', head: 'c'.repeat(40) })))
      await settle()
      expect(probe.current()?.status?.branch).toBe('branch-B')
      expect(statusCalls(fake)).toHaveLength(3)
    } finally {
      probe?.unmount()
      jest.useRealTimers()
    }
  })

})

test('a warm Changes mount keeps the shared three-second idle deadline', async () => {
  jest.useFakeTimers()
  const fake = fakeContext(layoutFor('warm'))
  activate(fake.context)
  const bar = document.createElement('div')
  document.body.appendChild(bar)
  const mount = fake.provided.get(STATUS_BAR_ID) as Mount
  let stopBar: (() => void) | void
  let probe: StatusProbeMount | undefined
  try {
    await act(async () => { stopBar = mount(bar, {}) })
    await settle()
    expect(statusCalls(fake)).toHaveLength(1)
    await advance(2_000)
    probe = mountStatusProbe(fake, 'warm')
    await settle()
    expect(statusCalls(fake)).toHaveLength(1)
    await advance(999)
    expect(statusCalls(fake)).toHaveLength(1)
    await advance(1)
    expect(statusCalls(fake)).toHaveLength(2)
  } finally {
    probe?.unmount()
    await act(async () => { stopBar?.() })
    bar.remove()
    jest.useRealTimers()
  }
})
