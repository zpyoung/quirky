import { describe, expect, it } from 'vitest'
import { applyViewPatch, parseViewPatch, ViewPatchError } from './view-spec-patch'
import { MAX_PATCH_OPS, type ViewPatchOp, type ViewSpec } from './view-spec-types'
import { validateViewSpec } from './view-spec-validation'

const base: ViewSpec = {
  title: 'Start',
  root: {
    type: 'stack',
    children: [
      { type: 'markdown', props: { text: 'a' } },
      { type: 'table', props: { columns: ['k', 'v'], rows: [['x', '1']] } }
    ]
  }
}

const patch = (...ops: ViewPatchOp[]) => ({ ops })

function failureOf(ops: unknown[], spec: ViewSpec = base): string {
  try {
    applyViewPatch(spec, { ops })
  } catch (error) {
    expect(error).toBeInstanceOf(ViewPatchError)
    return error instanceof Error ? error.message : ''
  }
  throw new Error('expected the patch to be refused')
}

describe('applyViewPatch', () => {
  it('replaces a value and appends a row with "-"', () => {
    const next = applyViewPatch(
      base,
      patch(
        { op: 'replace', path: '/root/children/0/props/text', value: 'b' },
        { op: 'add', path: '/root/children/1/props/rows/-', value: ['y', '2'] }
      )
    )
    expect(validateViewSpec(next).ok).toBe(true)
    expect(next.root.children?.[0]?.props?.text).toBe('b')
    expect(next.root.children?.[1]?.props?.rows).toEqual([
      ['x', '1'],
      ['y', '2']
    ])
  })

  it('inserts at an index, removes, and replaces the title', () => {
    const inserted = applyViewPatch(
      base,
      patch({
        op: 'add',
        path: '/root/children/1',
        value: { type: 'markdown', props: { text: 'b' } }
      })
    )
    expect(inserted.root.children).toHaveLength(3)
    const next = applyViewPatch(
      inserted,
      patch(
        { op: 'remove', path: '/root/children/0' },
        { op: 'replace', path: '/title', value: 'Done' }
      )
    )
    expect(next.title).toBe('Done')
    expect(next.root.children?.map((child) => child.props?.text)).toEqual(['b', undefined])
  })

  it('adds a node id by pointer and unescapes ~0 and ~1', () => {
    const withId = applyViewPatch(base, patch({ op: 'add', path: '/root/id', value: 'intro' }))
    expect(withId.root.id).toBe('intro')
    const escaped = applyViewPatch(
      base,
      patch(
        { op: 'add', path: '/root/props', value: {} },
        { op: 'add', path: '/root/props/a~1b~0c', value: 1 }
      )
    )
    expect(escaped.root.props).toEqual({ 'a/b~c': 1 })
  })

  it('never mutates the input spec or shares nodes with the patch value', () => {
    const before = JSON.stringify(base)
    const value = { type: 'markdown', props: { text: 'n' } }
    const next = applyViewPatch(base, patch({ op: 'add', path: '/root/children/-', value }))
    expect(JSON.stringify(base)).toBe(before)
    value.props.text = 'changed'
    expect(next.root.children?.at(-1)?.props?.text).toBe('n')
  })

  it.each([
    [
      'a missing target',
      [{ op: 'replace', path: '/root/children/9/props', value: {} }],
      'ops[0].path: /root/children/9/props does not exist'
    ],
    [
      'a missing parent',
      [{ op: 'add', path: '/root/nope/deeper', value: 1 }],
      'ops[0].path: /root/nope/deeper does not exist'
    ],
    [
      'a pointer without a leading slash',
      [{ op: 'replace', path: 'title', value: 'x' }],
      "ops[0].path: 'title' is not a JSON Pointer"
    ],
    [
      'an unknown op',
      [{ op: 'move', path: '/title' }],
      'ops[0].op: must be one of add | replace | remove'
    ],
    [
      'an add with no value',
      [{ op: 'add', path: '/root/id' }],
      'ops[0].value: is required for add'
    ],
    [
      'an index past the end',
      [{ op: 'add', path: '/root/children/5', value: { type: 'stack' } }],
      'ops[0].path: index 5 is out of range'
    ],
    [
      'removing the whole spec',
      [{ op: 'remove', path: '' }],
      'ops[0].path: the whole spec cannot be removed'
    ],
    [
      'an unknown op field',
      [{ op: 'remove', path: '/title', from: '/x' }],
      "ops[0].from: unknown field 'from'; allowed: op, path, value"
    ]
  ])('refuses %s', (_name, ops, message) => {
    expect(failureOf(ops)).toBe(message)
  })

  it('is all or nothing: one bad op refuses the whole patch', () => {
    expect(() =>
      applyViewPatch(
        base,
        patch(
          { op: 'replace', path: '/title', value: 'x' },
          { op: 'remove', path: '/root/children/7' }
        )
      )
    ).toThrow(ViewPatchError)
  })

  it('refuses more than 200 ops and non-array ops', () => {
    const many = Array.from({ length: MAX_PATCH_OPS + 1 }, () => ({
      op: 'replace',
      path: '/title',
      value: 'x'
    }))
    expect(failureOf(many)).toBe('ops: at most 200 ops allowed')
    const notAList = { ops: { op: 'add' } }
    expect(() => applyViewPatch(base, notAList)).toThrow('ops: must be an array of operations')
    const fine = Array.from({ length: MAX_PATCH_OPS }, (_, i) => ({
      op: 'replace' as const,
      path: '/title',
      value: `t${i}`
    }))
    expect(applyViewPatch(base, { ops: fine }).title).toBe('t199')
  })

  it('keeps a __proto__ key as plain data instead of reaching the prototype', () => {
    const next = applyViewPatch(
      base,
      patch(
        { op: 'add', path: '/root/props', value: {} },
        { op: 'add', path: '/root/props/__proto__', value: { polluted: true } }
      )
    )
    const pristine: { polluted?: unknown } = {}
    expect(pristine.polluted).toBeUndefined()
    expect(Object.hasOwn(next.root.props ?? {}, '__proto__')).toBe(true)
  })

  it('returns a spec the caller must validate: a bad result is refused by validateViewSpec', () => {
    const next = applyViewPatch(
      base,
      patch({ op: 'replace', path: '/root/type', value: 'carousel' })
    )
    const result = validateViewSpec(next)
    expect(result.ok).toBe(false)
    expect(!result.ok && result.errors[0]).toMatch(
      /^root\.type: unknown type 'carousel'; the catalog has stack, columns/
    )
  })
})

describe('parseViewPatch', () => {
  it('accepts an ops list and keeps only known fields', () => {
    expect(parseViewPatch({ ops: [{ op: 'remove', path: '/root/children/0' }] })).toEqual({
      ok: true,
      patch: { ops: [{ op: 'remove', path: '/root/children/0' }] }
    })
  })

  it('reports problems without throwing', () => {
    expect(parseViewPatch(null)).toEqual({ ok: false, errors: ['ops: is required'] })
    expect(parseViewPatch({ ops: 'nope' })).toEqual({
      ok: false,
      errors: ['ops: must be an array of operations']
    })
    expect(parseViewPatch({ ops: [{ op: 'add', path: '/x' }] })).toEqual({
      ok: false,
      errors: ['ops[0].value: is required for add']
    })
  })
})
