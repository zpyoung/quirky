import { afterEach, expect, test } from 'bun:test'
import { pause, startOrchestrationFixture, type OrchestrationFixture } from './fixture'

const fixtures: OrchestrationFixture[] = []

afterEach(async () => {
  const cleanup = fixtures.splice(0).reverse()
  for (const fixture of cleanup) await fixture.cleanup()
})

test('disabling orchestration in one daemon leaves the other activation alive', async () => {
  const fixtureA = await startOrchestrationFixture()
  fixtures.push(fixtureA)
  const fixtureB = await startOrchestrationFixture()
  fixtures.push(fixtureB)

  expect(await fixtureA.setupClient.callAny('quirky.orchestration/runList', {})).toEqual({ runs: [], nextCursor: null })
  expect(await fixtureB.setupClient.callAny('quirky.orchestration/runList', {})).toEqual({ runs: [], nextCursor: null })
  expect(await fixtureA.setupClient.callAny('plugin.disable', { id: 'quirky.orchestration' })).toEqual({ ok: true })

  // Let the real one-second mail interval fire; fake time would bypass the daemon timer.
  await pause(1_500)
  expect(await fixtureB.setupClient.callAny('quirky.orchestration/runList', {})).toEqual({ runs: [], nextCursor: null })
}, 60_000)

test('stopping daemons newest first leaves no orphaned timer', async () => {
  const fixtureA = await startOrchestrationFixture()
  fixtures.push(fixtureA)
  const fixtureB = await startOrchestrationFixture()
  fixtures.push(fixtureB)

  expect(await fixtureA.setupClient.callAny('quirky.orchestration/runList', {})).toEqual({ runs: [], nextCursor: null })
  expect(await fixtureB.setupClient.callAny('quirky.orchestration/runList', {})).toEqual({ runs: [], nextCursor: null })

  const cleanup = fixtures.splice(0).reverse()
  for (const fixture of cleanup) await fixture.cleanup()
  await pause(1_500)
}, 60_000)
