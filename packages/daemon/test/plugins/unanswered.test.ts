import { describe, expect, test } from 'bun:test'
import { UnansweredHandlers } from '../../src/plugins/unanswered'

type Warning = { pluginId: string; message: string }

function setup() {
  const activeWarnings = new Map<string, Set<string>>()
  const added: Warning[] = []
  const removed: Warning[] = []
  const handlers = new UnansweredHandlers({
    warn(pluginId, message) {
      added.push({ pluginId, message })
      const messages = activeWarnings.get(pluginId) ?? new Set<string>()
      messages.add(message)
      activeWarnings.set(pluginId, messages)
    },
    unwarn(pluginId, message) {
      removed.push({ pluginId, message })
      activeWarnings.get(pluginId)?.delete(message)
    }
  })
  return { handlers, activeWarnings, added, removed }
}

describe('UnansweredHandlers', () => {
  test('counts independently for each contribution for the process lifetime', () => {
    const handlers = new UnansweredHandlers()
    const releaseMethod = handlers.add('method:acme.tools/read', 'acme.tools')
    const releaseJob = handlers.add('job:acme.hang/tick', 'acme.hang')
    const releaseMethodAgain = handlers.add('method:acme.tools/read', 'acme.tools')

    expect(handlers.count('method:acme.tools/read')).toBe(2)
    expect(handlers.count('job:acme.hang/tick')).toBe(1)
    expect(handlers.count('method:missing/run')).toBe(0)

    releaseMethod()
    expect(handlers.count('method:acme.tools/read')).toBe(1)
    expect(handlers.count('job:acme.hang/tick')).toBe(1)
    releaseJob()
    releaseMethodAgain()
    expect(handlers.count('method:acme.tools/read')).toBe(0)
    expect(handlers.count('job:acme.hang/tick')).toBe(0)
  })

  test('a release only decrements its handler once', () => {
    const handlers = new UnansweredHandlers()
    const release = handlers.add('method:acme.tools/read', 'acme.tools')

    release()
    release()

    expect(handlers.count('method:acme.tools/read')).toBe(0)
  })

  test('adds the exact bound warning at four and removes it below the bound', () => {
    const { handlers, activeWarnings, added, removed } = setup()
    const contributionId = 'method:acme.tools/read'
    const pluginId = 'acme.tools'
    const message = `${contributionId} has 4 or more handlers that never finished; it will not run again until fewer than 4 remain or the daemon restarts`
    const releases = [
      handlers.add(contributionId, pluginId),
      handlers.add(contributionId, pluginId),
      handlers.add(contributionId, pluginId)
    ]

    expect(activeWarnings.get(pluginId)?.has(message) ?? false).toBe(false)
    releases.push(handlers.add(contributionId, pluginId))
    expect(handlers.count(contributionId)).toBe(4)
    expect(added).toEqual([{ pluginId, message }])
    expect(activeWarnings.get(pluginId)?.has(message)).toBe(true)

    releases[0]!()
    expect(handlers.count(contributionId)).toBe(3)
    expect(removed).toEqual([{ pluginId, message }])
    expect(activeWarnings.get(pluginId)?.has(message)).toBe(false)
  })

  test('blocked restores a missing bound warning after plugin reload', () => {
    const { handlers, activeWarnings } = setup()
    const contributionId = 'job:acme.accounts/usage-refresh'
    const pluginId = 'acme.accounts'
    const message = `${contributionId} has 4 or more handlers that never finished; it will not run again until fewer than 4 remain or the daemon restarts`
    for (let i = 0; i < 4; i++) handlers.add(contributionId, pluginId)
    activeWarnings.get(pluginId)?.clear()

    expect(handlers.blocked(contributionId, pluginId)).toBe(true)
    expect(activeWarnings.get(pluginId)?.has(message)).toBe(true)
    expect(handlers.blocked(contributionId, pluginId)).toBe(true)
  })

  test('counts already-admitted handlers beyond four and keeps the warning until fewer than four remain', () => {
    const { handlers, added, removed } = setup()
    const id = 'method:acme.tools/read'
    const releases = Array.from({ length: 6 }, () => handlers.add(id, 'acme.tools'))
    expect(handlers.count(id)).toBe(6)
    expect(added).toHaveLength(1)
    releases[0]!()
    releases[1]!()
    expect(handlers.count(id)).toBe(4)
    expect(removed).toEqual([])
    releases[2]!()
    expect(handlers.count(id)).toBe(3)
    expect(removed).toEqual(added)
    expect(handlers.blocked(id, 'acme.tools')).toBe(false)
  })

  test('keeps duplicate per-entry warnings until their last handler releases', () => {
    const { handlers, activeWarnings, added, removed } = setup()
    const warning = 'a handler is still running'
    const releaseFirst = handlers.add('job:acme.hang/tick', 'acme.hang', warning)
    const releaseSecond = handlers.add('job:acme.hang/tick', 'acme.hang', warning)

    expect(added).toEqual([{ pluginId: 'acme.hang', message: warning }])
    expect(activeWarnings.get('acme.hang')?.has(warning)).toBe(true)
    releaseFirst()
    expect(removed).toEqual([])
    expect(activeWarnings.get('acme.hang')?.has(warning)).toBe(true)

    releaseSecond()
    expect(removed).toEqual([{ pluginId: 'acme.hang', message: warning }])
    expect(activeWarnings.get('acme.hang')?.has(warning)).toBe(false)
  })
})
