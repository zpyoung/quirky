import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { addSourceAttributes } from '../jsx-source-plugin'

const repoRoot = join('/repo')
const file = join(repoRoot, 'plugins/acme.fixture/src/View.tsx')

const SOURCE = [
  "import { Card } from './Card'",
  '',
  'export function View({ items }: { items: string[] }) {',
  '  return (',
  '    <>',
  '      <section className="view">',
  '        <Card',
  '          title="x"',
  '        />',
  '        <ul>',
  '          {items.map(item => (',
  '            <li key={item}>{item}</li>',
  '          ))}',
  '        </ul>',
  '        <img',
  '          alt=""',
  '          src="a.png"',
  '        />',
  '      </section>',
  '    </>',
  '  )',
  '}',
  ''
].join('\n')

const attributesOf = (output: string) => [...output.matchAll(/<(\w+)[^>]*?data-quirky-source="([^"]+)"/gs)].map(match => [match[1], match[2]])

describe('addSourceAttributes', () => {
  test('tags intrinsic elements with the repo-relative path and the line of their opening tag', async () => {
    const output = await addSourceAttributes(SOURCE, file, repoRoot)
    expect(attributesOf(output)).toEqual([
      ['section', 'plugins/acme.fixture/src/View.tsx:6'],
      ['ul', 'plugins/acme.fixture/src/View.tsx:10'],
      ['li', 'plugins/acme.fixture/src/View.tsx:12'],
      ['img', 'plugins/acme.fixture/src/View.tsx:15']
    ])
  })

  test('leaves components and fragments untouched', async () => {
    const output = await addSourceAttributes(SOURCE, file, repoRoot)
    expect(output).toContain('<Card\n')
    expect(output).toContain('    <>\n')
    expect(output).not.toMatch(/<Card[^>]*data-quirky-source/s)
  })

  test('adds no lines, so every later element keeps its original line', async () => {
    const output = await addSourceAttributes(SOURCE, file, repoRoot)
    expect(output.split('\n')).toHaveLength(SOURCE.split('\n').length)
    expect(output.replaceAll(/ data-quirky-source="[^"]+"/g, '')).toBe(SOURCE)
  })

  test('uses forward slashes for paths below the repository root', async () => {
    const nested = join(repoRoot, 'packages', 'ui', 'src', 'deep', 'Panel.tsx')
    const output = await addSourceAttributes('export const a = <p />\n', nested, repoRoot)
    expect(output).toContain('data-quirky-source="packages/ui/src/deep/Panel.tsx:1"')
  })

  test('skips an element that already sets the attribute', async () => {
    const source = 'export const a = <div data-quirky-source="mine" />\n'
    expect(await addSourceAttributes(source, file, repoRoot)).toBe(source)
  })

  test('puts the attribute after a spread so the spread cannot override it', async () => {
    const source = 'export const a = (props: object) => <div {...props} id="x" />\n'
    const output = await addSourceAttributes(source, file, repoRoot)
    expect(output).toBe('export const a = (props: object) => <div {...props} id="x" data-quirky-source="plugins/acme.fixture/src/View.tsx:1" />\n')
  })

  test('tags elements nested inside attribute expressions', async () => {
    const source = 'export const a = <Slot icon={<svg><path /></svg>} />\n'
    const output = await addSourceAttributes(source, file, repoRoot)
    const attribute = 'data-quirky-source="plugins/acme.fixture/src/View.tsx:1"'
    expect(output).toBe(`export const a = <Slot icon={<svg ${attribute}><path ${attribute} /></svg>} />\n`)
  })

  test('fails with the file name when the source does not parse', async () => {
    await expect(addSourceAttributes('export const a = <div>\n', file, repoRoot)).rejects.toThrow(file)
  })
})
