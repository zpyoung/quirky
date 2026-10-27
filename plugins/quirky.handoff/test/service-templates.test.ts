import { afterEach, describe, expect, test } from 'bun:test'
import { RpcErrorCode } from '@quirky/protocol'
import { HandoffRig } from './support'

let rig: HandoffRig
afterEach(async () => {
  await rig?.cleanup()
  rig = undefined as unknown as HandoffRig
})

type Catalog = { templates: { id: string; name: string; body: string }[]; custom: boolean; limit?: number }
type Mutation = Catalog & { warnings: string[] }

const list = () => rig.call('quirky.handoff/templates') as Promise<Catalog>
const mutate = (params: Record<string, unknown>) => rig.call('quirky.handoff/templateMutate', params) as Promise<Mutation>
const add = (name: string, body: string) => mutate({ op: 'add', template: { name, body } })
const names = (catalog: Catalog) => catalog.templates.map((template) => template.name)

const BUILTINS = ['Continue implementation', 'Review what was done', 'Debug the failure']

describe('SC-22: the built-ins apply until the catalog is changed', () => {
  test('lists the built-ins, keeps them beside an added template and returns to them on reset', async () => {
    rig = await HandoffRig.start()
    const first = await list()
    expect(names(first)).toEqual(BUILTINS)
    expect(first).toMatchObject({ custom: false, limit: 24 })
    expect(first.templates.map((template) => template.id)).toEqual(['continue-implementation', 'review-completed-work', 'debug-failure'])
    expect(first.templates[0]!.body).toBe(
      'Continue the implementation from where the prior session stopped. Check the current state first:\n{{gitStatus}}\nFinish the remaining work, run the relevant tests, and report what changed.'
    )

    const added = await add('Mine', 'x')
    expect(names(added)).toEqual([...BUILTINS, 'Mine'])
    expect(added).toMatchObject({ custom: true, warnings: [] })
    expect(names(await list())).toEqual([...BUILTINS, 'Mine'])

    const reset = await mutate({ op: 'reset' })
    expect(names(reset)).toEqual(BUILTINS)
    expect(reset).toMatchObject({ custom: false, warnings: [] })
    expect(await list()).toMatchObject({ custom: false })
  })

  test('the first update or removal also starts from the built-ins', async () => {
    rig = await HandoffRig.start()
    const removed = await mutate({ op: 'remove', id: 'review-completed-work' })
    expect(names(removed)).toEqual(['Continue implementation', 'Debug the failure'])
    expect(removed.custom).toBe(true)
    await mutate({ op: 'reset' })
    const updated = await mutate({ op: 'update', template: { id: 'debug-failure', name: 'Debug it', body: 'Find it.' } })
    expect(updated.templates.map((template) => [template.id, template.name])).toEqual([
      ['continue-implementation', 'Continue implementation'],
      ['review-completed-work', 'Review what was done'],
      ['debug-failure', 'Debug it']
    ])
    expect(updated.templates[2]!.body).toBe('Find it.')
  })

  test('a change announces itself', async () => {
    rig = await HandoffRig.start()
    await add('Mine', 'x')
    await rig.waitFor(() => rig.pluginEvents('changed').length > 0)
    expect(rig.pluginEvents('changed')).toEqual([{ kind: 'templates' }])
  })

  test('a second template named like an existing one warns and both are kept', async () => {
    rig = await HandoffRig.start()
    await add('Mine', 'one')
    const second = await add('  mine ', 'two')
    expect(second.warnings).toEqual(['duplicate-name'])
    expect(second.templates.filter((template) => template.name.trim().toLowerCase() === 'mine')).toHaveLength(2)
    const ids = second.templates.map((template) => template.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})

describe('SC-23: templates are normalized on every write', () => {
  test('cuts the name to 80 and the body to 8,000, drops empty ones and holds at most 24', async () => {
    rig = await HandoffRig.start()
    const long = await add('n'.repeat(100), 'b'.repeat(9_000))
    const saved = long.templates.at(-1)!
    expect(saved.name).toBe('n'.repeat(80))
    expect(saved.body).toBe('b'.repeat(8_000))

    for (const params of [
      { name: 'Empty body', body: '' },
      { name: 'Blank body', body: '  \n ' },
      { name: '  ', body: 'no name' }
    ]) {
      const error = await rig.failure('quirky.handoff/templateMutate', { op: 'add', template: params })
      expect(error.code).toBe(RpcErrorCode.InvalidParams)
      expect(error.data).toEqual({ reason: 'invalid' })
    }

    for (let i = long.templates.length; i < 24; i++) await add(`T${i}`, 'body')
    const full = await list()
    expect(full.templates).toHaveLength(24)
    const over = await rig.failure('quirky.handoff/templateMutate', { op: 'add', template: { name: 'The 25th', body: 'x' } })
    expect(over.code).toBe(RpcErrorCode.Conflict)
    expect(over.data).toEqual({ reason: 'limit' })
    expect(await list()).toEqual(full)
  })

  test('an empty catalog means no templates, not the built-ins', async () => {
    rig = await HandoffRig.start()
    let current: Catalog = await list()
    for (const template of [...current.templates]) current = await mutate({ op: 'remove', id: template.id })
    expect(current).toMatchObject({ templates: [], custom: true })
    expect(await list()).toMatchObject({ templates: [], custom: true })
    expect(names(await mutate({ op: 'reset' }))).toEqual(BUILTINS)
  })

  test('a stored catalog is normalized when read and again when written', async () => {
    rig = await HandoffRig.start()
    rig.seedKv('templates', [
      { id: 'a', name: 'x'.repeat(100), body: 'one' },
      { id: 'b', name: '', body: 'no name' },
      'junk',
      { id: 'a', name: 'duplicate id', body: 'two' },
      { name: 'No id', body: 'three' }
    ])
    const read = await list()
    expect(read.templates.map((template) => [template.id, template.name.length])).toEqual([
      ['a', 80],
      ['template-1', 5]
    ])
    const written = await add('Next', 'four')
    expect(written.templates.map((template) => template.id)).toEqual(['a', 'template-1', 'template-2'])
  })

  test('an unknown template cannot be updated or removed', async () => {
    rig = await HandoffRig.start()
    for (const params of [
      { op: 'update', template: { id: 'nope', name: 'x', body: 'y' } },
      { op: 'remove', id: 'nope' }
    ]) {
      const error = await rig.failure('quirky.handoff/templateMutate', params)
      expect(error.code).toBe(RpcErrorCode.NotFound)
      expect(error.data).toEqual({ reason: 'invalid' })
    }
    expect(await list()).toMatchObject({ custom: false })
  })
})
