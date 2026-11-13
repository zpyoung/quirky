import { describe, expect, test } from 'bun:test'
import { RunningHandlers } from '../../src/plugins/running'

type Warning = { pluginId: string; message: string }

const contributionId = 'method:acme.tools/read'
const limitWarning = `${contributionId} has reached its limit of 3 running handlers; calls over the limit are refused`
const limitLog = 'method acme.tools/read in acme.tools has reached its limit of 3 running handlers; refusing calls over the limit'

function setup() {
  const activeWarnings = new Map<string, Set<string>>()
  const added: Warning[] = []
  const removed: Warning[] = []
  const warnCalls: Warning[] = []
  const logs: string[] = []
  const handlers = new RunningHandlers({
    warn(pluginId, message) {
      warnCalls.push({ pluginId, message })
      let warnings = activeWarnings.get(pluginId)
      if (!warnings) {
        warnings = new Set()
        activeWarnings.set(pluginId, warnings)
      }
      if (warnings.has(message)) return
      warnings.add(message)
      added.push({ pluginId, message })
    },
    unwarn(pluginId, message) {
      removed.push({ pluginId, message })
      activeWarnings.get(pluginId)?.delete(message)
    },
    log(message) {
      logs.push(message)
    },
  })
  return { handlers, activeWarnings, added, removed, warnCalls, logs }
}

describe('RunningHandlers', () => {
  test('counts independently for each contribution and releases each slot once', () => {
    const handlers = new RunningHandlers()
    const releaseRead = handlers.enter('method:acme.tools/read', 'acme.tools', 3)!
    const releaseOther = handlers.enter('method:acme.tools/other', 'acme.tools', 3)!
    const releaseReadAgain = handlers.enter('method:acme.tools/read', 'acme.tools', 3)!

    expect(handlers.count('method:acme.tools/read')).toBe(2)
    expect(handlers.count('method:acme.tools/other')).toBe(1)
    expect(handlers.count('method:missing/run')).toBe(0)

    releaseRead()
    releaseRead()
    expect(handlers.count('method:acme.tools/read')).toBe(1)
    expect(handlers.count('method:acme.tools/other')).toBe(1)

    releaseOther()
    releaseReadAgain()
    expect(handlers.count('method:acme.tools/read')).toBe(0)
    expect(handlers.count('method:acme.tools/other')).toBe(0)
  })

  test('refuses synchronously at the limit and warns and logs only on the first refusal', () => {
    const { handlers, activeWarnings, added, warnCalls, logs } = setup()
    const releases = Array.from({ length: 3 }, () => handlers.enter(contributionId, 'acme.tools', 3)!)

    expect(added).toEqual([])
    expect(logs).toEqual([])
    for (let i = 0; i < 21; i++) {
      expect(handlers.enter(contributionId, 'acme.tools', 3)).toBeNull()
    }

    expect(activeWarnings.get('acme.tools')).toEqual(new Set([limitWarning]))
    expect(added).toEqual([{ pluginId: 'acme.tools', message: limitWarning }])
    expect(warnCalls).toEqual(Array.from({ length: 21 }, () => ({ pluginId: 'acme.tools', message: limitWarning })))
    expect(logs).toEqual([limitLog])
    releases.forEach((release) => release())
  })

  test('reaching the limit without a refusal is silent', () => {
    const { handlers, activeWarnings, added, logs } = setup()
    const releases = Array.from({ length: 3 }, () => handlers.enter(contributionId, 'acme.tools', 3)!)

    expect(handlers.count(contributionId)).toBe(3)
    expect(activeWarnings.size).toBe(0)
    expect(added).toEqual([])
    expect(logs).toEqual([])
    releases.forEach((release) => release())
  })

  test('clears the warning at half the limit and logs the number refused', () => {
    const { handlers, activeWarnings, added, removed, logs } = setup()
    const releases = Array.from({ length: 4 }, () => handlers.enter(contributionId, 'acme.tools', 4)!)
    const warning = 'method:acme.tools/read has reached its limit of 4 running handlers; calls over the limit are refused'

    expect(handlers.enter(contributionId, 'acme.tools', 4)).toBeNull()
    expect(handlers.enter(contributionId, 'acme.tools', 4)).toBeNull()
    releases[0]!()
    expect(handlers.count(contributionId)).toBe(3)
    expect(activeWarnings.get('acme.tools')).toEqual(new Set([warning]))

    const replacement = handlers.enter(contributionId, 'acme.tools', 4)!
    releases[1]!()
    expect(handlers.count(contributionId)).toBe(3)
    expect(activeWarnings.get('acme.tools')).toEqual(new Set([warning]))
    releases[2]!()

    expect(handlers.count(contributionId)).toBe(2)
    expect(activeWarnings.get('acme.tools')?.has(warning)).toBe(false)
    expect(added).toEqual([{ pluginId: 'acme.tools', message: warning }])
    expect(removed).toEqual([{ pluginId: 'acme.tools', message: warning }])
    expect(logs).toEqual([
      'method acme.tools/read in acme.tools has reached its limit of 4 running handlers; refusing calls over the limit',
      'method acme.tools/read in acme.tools is under its limit again; 2 calls were refused',
    ])

    releases[3]!()
    replacement()
    expect(handlers.count(contributionId)).toBe(0)
  })

  test('does not flap while a method hovers at its limit', () => {
    const { handlers, added, removed, warnCalls, logs } = setup()
    const releases = Array.from({ length: 4 }, () => handlers.enter(contributionId, 'acme.tools', 4)!)

    expect(handlers.enter(contributionId, 'acme.tools', 4)).toBeNull()
    for (let i = 0; i < 10; i++) {
      const release = releases.shift()!
      release()
      releases.push(handlers.enter(contributionId, 'acme.tools', 4)!)
      expect(handlers.enter(contributionId, 'acme.tools', 4)).toBeNull()
    }

    expect(handlers.count(contributionId)).toBe(4)
    expect(added).toHaveLength(1)
    expect(warnCalls).toHaveLength(11)
    expect(removed).toEqual([])
    expect(logs).toHaveLength(1)
    releases.forEach((release) => release())
  })

  test('ensures a cleared warning is restored on refusal without a second episode log', () => {
    const { handlers, activeWarnings, added, logs } = setup()
    const releases = Array.from({ length: 3 }, () => handlers.enter(contributionId, 'acme.tools', 3)!)

    expect(handlers.enter(contributionId, 'acme.tools', 3)).toBeNull()
    activeWarnings.delete('acme.tools')
    expect(handlers.enter(contributionId, 'acme.tools', 3)).toBeNull()

    expect(activeWarnings.get('acme.tools')).toEqual(new Set([limitWarning]))
    expect(added).toEqual([
      { pluginId: 'acme.tools', message: limitWarning },
      { pluginId: 'acme.tools', message: limitWarning },
    ])
    expect(logs).toEqual([limitLog])
    releases.forEach((release) => release())
  })

  test('keeps counts and warning episodes separate for methods of one plugin', () => {
    const { handlers, activeWarnings, added, removed, logs } = setup()
    const readRelease = handlers.enter(contributionId, 'acme.tools', 1)!
    const otherContribution = 'method:acme.tools/other'
    const otherRelease = handlers.enter(otherContribution, 'acme.tools', 1)!

    expect(handlers.enter(contributionId, 'acme.tools', 1)).toBeNull()
    expect(handlers.enter(otherContribution, 'acme.tools', 1)).toBeNull()
    expect(handlers.count(contributionId)).toBe(1)
    expect(handlers.count(otherContribution)).toBe(1)
    expect(activeWarnings.get('acme.tools')).toEqual(new Set([
      `${contributionId} has reached its limit of 1 running handlers; calls over the limit are refused`,
      `${otherContribution} has reached its limit of 1 running handlers; calls over the limit are refused`,
    ]))
    expect(added).toHaveLength(2)
    expect(logs).toEqual([
      'method acme.tools/read in acme.tools has reached its limit of 1 running handlers; refusing calls over the limit',
      'method acme.tools/other in acme.tools has reached its limit of 1 running handlers; refusing calls over the limit',
    ])

    readRelease()
    expect(handlers.count(contributionId)).toBe(0)
    expect(handlers.count(otherContribution)).toBe(1)
    expect(removed).toEqual([{
      pluginId: 'acme.tools',
      message: `${contributionId} has reached its limit of 1 running handlers; calls over the limit are refused`,
    }])
    expect(activeWarnings.get('acme.tools')).toEqual(new Set([
      `${otherContribution} has reached its limit of 1 running handlers; calls over the limit are refused`,
    ]))
    otherRelease()
  })
})

test('clears every warned owner when an override changes ownership during a refusal episode', () => {
  const t = setup()
  const first = t.handlers.enter(contributionId, 'acme.tools', 3)!
  const second = t.handlers.enter(contributionId, 'acme.tools', 3)!
  const third = t.handlers.enter(contributionId, 'acme.tools', 3)!
  expect(t.handlers.enter(contributionId, 'acme.tools', 3)).toBeNull()
  expect(t.handlers.enter(contributionId, 'acme.override', 3)).toBeNull()
  expect(t.handlers.enter(contributionId, 'acme.override', 3)).toBeNull()
  expect(t.added).toEqual([
    { pluginId: 'acme.tools', message: limitWarning },
    { pluginId: 'acme.override', message: limitWarning }
  ])
  first()
  expect(t.removed).toEqual([])
  second()
  expect(t.removed).toEqual([
    { pluginId: 'acme.tools', message: limitWarning },
    { pluginId: 'acme.override', message: limitWarning }
  ])
  third()
  expect(t.handlers.count(contributionId)).toBe(0)
  expect(t.removed).toHaveLength(2)
  expect(t.logs).toEqual([
    limitLog,
    'method acme.tools/read in acme.tools is under its limit again; 3 calls were refused'
  ])
})
