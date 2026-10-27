import { afterEach, expect, test } from 'bun:test'
import { symlinkSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { ApiDescription } from '@quirky/protocol'
import { makeTempHome, startHarness, type Harness } from '../../../packages/daemon/test/helpers'
import { makeTempDir, removeTempDirs } from '../../../packages/daemon/test/plugins/fixtures'

const harnesses: Harness[] = []

afterEach(async () => {
  for (const harness of harnesses.splice(0)) await harness.cleanup()
  removeTempDirs()
})

async function start() {
  const home = makeTempHome('qd-palette-home-')
  const builtins = makeTempDir('qd-palette-builtins-')
  symlinkSync(resolve(import.meta.dir, '..'), join(builtins, 'quirky.palette'))
  const harness = await startHarness({ home, builtinPluginsDir: builtins })
  harnesses.push(harness)
  const caller = await harness.connect('cli')
  return { caller }
}

test('palette status and set expose CLI methods backed by canonical daemon layout', async () => {
  const { caller } = await start()
  type PaletteState = { open: boolean }
  const paletteStatus = async (): Promise<PaletteState> =>
    (await caller.callAny('quirky.palette/status', {})) as PaletteState
  const paletteSet = async (params: { open?: boolean } = {}): Promise<PaletteState> =>
    (await caller.callAny('quirky.palette/set', params)) as PaletteState

  expect(await paletteStatus()).toMatchObject({ open: false })
  await paletteSet({ open: true })
  expect((await caller.call('ui.state', {})).layout.palette).toBe(true)
  expect(await paletteStatus()).toMatchObject({ open: true })

  await paletteSet({ open: false })
  expect((await caller.call('ui.state', {})).layout.palette).toBeUndefined()
  await paletteSet()
  expect((await caller.call('ui.state', {})).layout.palette).toBe(true)
  await paletteSet()
  expect((await caller.call('ui.state', {})).layout.palette).toBeUndefined()

  const api: ApiDescription = await caller.call('api.describe', {})
  expect(api.methods.map((method) => method.name)).toEqual(
    expect.arrayContaining(['quirky.palette/status', 'quirky.palette/set'])
  )
  expect(api.cli.groups.find((group) => group.plugin === 'quirky.palette')).toEqual({
    plugin: 'quirky.palette',
    words: 'palette',
    aliases: ['pal']
  })
  expect(
    api.cli.commands.filter((command) => command.plugin === 'quirky.palette').map((command) => command.words).sort()
  ).toEqual(['palette set', 'palette status'])
})
