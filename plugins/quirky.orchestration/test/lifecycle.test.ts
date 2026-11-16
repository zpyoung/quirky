import { afterEach, expect, test } from 'bun:test'
import { pause, startOrchestrationFixture, type OrchestrationFixture } from './fixture'

const fixtures: OrchestrationFixture[] = []

afterEach(async () => {
  const cleanup = fixtures.splice(0).reverse()
  for (const fixture of cleanup) await fixture.cleanup()
})

test('disabling orchestration in one daemon leaves the other activation alive', async () => {
  const logs: string[] = []
  const fixtureA = await startOrchestrationFixture({ log: (message) => { logs.push(message) } })
  fixtures.push(fixtureA)
  const fixtureB = await startOrchestrationFixture({ log: (message) => { logs.push(message) } })
  fixtures.push(fixtureB)

  expect(await fixtureA.setupClient.callAny('quirky.orchestration/runList', {})).toEqual({ runs: [], nextCursor: null })
  expect(await fixtureB.setupClient.callAny('quirky.orchestration/runList', {})).toEqual({ runs: [], nextCursor: null })
  expect(await fixtureA.setupClient.callAny('plugin.disable', { id: 'quirky.orchestration' })).toEqual({ ok: true })

  // Let the real one-second mail interval fire; fake time would bypass the daemon timer.
  await pause(1_500)
  expect(await fixtureB.setupClient.callAny('quirky.orchestration/runList', {})).toEqual({ runs: [], nextCursor: null })
  expect(logs.filter((message) => message.includes('federation mail tick failed:'))).toEqual([])
}, 60_000)

test('stopping daemons newest first leaves no orphaned timer', async () => {
  const logs: string[] = []
  const fixtureA = await startOrchestrationFixture({ log: (message) => { logs.push(message) } })
  fixtures.push(fixtureA)
  const fixtureB = await startOrchestrationFixture({ log: (message) => { logs.push(message) } })
  fixtures.push(fixtureB)

  expect(await fixtureA.setupClient.callAny('quirky.orchestration/runList', {})).toEqual({ runs: [], nextCursor: null })
  expect(await fixtureB.setupClient.callAny('quirky.orchestration/runList', {})).toEqual({ runs: [], nextCursor: null })

  const cleanup = fixtures.splice(0).reverse()
  for (const fixture of cleanup) await fixture.cleanup()
  await pause(1_500)
  expect(logs.filter((message) => message.includes('federation mail tick failed:'))).toEqual([])
}, 60_000)
