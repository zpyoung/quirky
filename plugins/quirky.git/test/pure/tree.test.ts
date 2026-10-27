import { describe, expect, test } from 'bun:test'
import { buildTree, flattenTree, type TreeNode } from '../../src/panel/tree'

const item = (path: string) => ({ path })
const tree = (...paths: string[]) => buildTree(paths.map(item))

const shape = (nodes: TreeNode<{ path: string }>[]): unknown[] =>
  nodes.map((n) => (n.kind === 'dir' ? { dir: n.name, files: n.fileCount, children: shape(n.children) } : n.name))

describe('buildTree', () => {
  test('SC-17: compacts src/app and lists folders before files', () => {
    expect(shape(tree('src/app/a.ts', 'src/app/b.ts', 'lib/c.ts'))).toEqual([
      { dir: 'lib', files: 1, children: ['c.ts'] },
      { dir: 'src/app', files: 2, children: ['a.ts', 'b.ts'] }
    ])
  })

  test('compacts a chain of single-child directories', () => {
    expect(shape(tree('a/b/c/d.ts'))).toEqual([{ dir: 'a/b/c', files: 1, children: ['d.ts'] }])
  })

  test('does not compact a directory that has a file or several children', () => {
    expect(shape(tree('a/x.ts', 'a/b/y.ts'))).toEqual([
      { dir: 'a', files: 2, children: [{ dir: 'b', files: 1, children: ['y.ts'] }, 'x.ts'] }
    ])
    expect(shape(tree('a/b/x.ts', 'a/c/y.ts'))).toEqual([
      {
        dir: 'a',
        files: 2,
        children: [
          { dir: 'b', files: 1, children: ['x.ts'] },
          { dir: 'c', files: 1, children: ['y.ts'] }
        ]
      }
    ])
  })

  test('directories come before files at every level, each in natural order', () => {
    expect(shape(tree('file10.ts', 'file2.ts', 'z/q.ts', 'a/q.ts', 'B.ts'))).toEqual([
      { dir: 'a', files: 1, children: ['q.ts'] },
      { dir: 'z', files: 1, children: ['q.ts'] },
      'B.ts',
      'file2.ts',
      'file10.ts'
    ])
  })

  test('directory nodes know their path, depth and the paths beneath them', () => {
    const [dir] = tree('src/app/a.ts', 'src/app/deep/b.ts', 'src/app/deep/c.ts') as Extract<TreeNode<{ path: string }>, { kind: 'dir' }>[]
    expect(dir.path).toBe('src/app')
    expect(dir.fileCount).toBe(3)
    expect(dir.paths).toEqual(['src/app/deep/b.ts', 'src/app/deep/c.ts', 'src/app/a.ts'])
    expect(dir.items.map((i) => i.path)).toEqual(dir.paths)
    expect(dir.children[0]).toMatchObject({ kind: 'dir', name: 'deep', path: 'src/app/deep', depth: 1 })
    expect(dir.depth).toBe(0)
  })

  test('file nodes carry their item, full path and name', () => {
    const [file] = tree('README.md')
    expect(file).toMatchObject({ kind: 'file', name: 'README.md', path: 'README.md', depth: 0 })
    expect(file.kind === 'file' && file.item).toEqual({ path: 'README.md' })
  })

  test('depth after compaction counts rendered levels', () => {
    const [dir] = tree('a/b/c/x.ts', 'a/b/c/d/y.ts') as Extract<TreeNode<{ path: string }>, { kind: 'dir' }>[]
    expect(dir.name).toBe('a/b/c')
    expect(dir.children.map((c) => c.depth)).toEqual([1, 1])
  })

  test('empty input is an empty tree', () => {
    expect(buildTree([])).toEqual([])
  })

  test('two items for one path stay as two files', () => {
    expect(shape(tree('a.ts', 'a.ts'))).toEqual(['a.ts', 'a.ts'])
  })
})

describe('flattenTree', () => {
  const nodes = tree('src/app/a.ts', 'src/app/b.ts', 'lib/c.ts', 'top.ts')

  test('lists rows in display order with their depth', () => {
    expect(flattenTree(nodes).map((r) => [r.node.path, r.depth])).toEqual([
      ['lib', 0],
      ['lib/c.ts', 1],
      ['src/app', 0],
      ['src/app/a.ts', 1],
      ['src/app/b.ts', 1],
      ['top.ts', 0]
    ])
  })

  test('skips the children of collapsed directories', () => {
    expect(flattenTree(nodes, new Set(['src/app'])).map((r) => r.node.path)).toEqual(['lib', 'lib/c.ts', 'src/app', 'top.ts'])
  })
})
