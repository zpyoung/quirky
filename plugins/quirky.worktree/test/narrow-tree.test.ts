import { expect, test } from 'bun:test'
import type { Repo, Worktree } from '@quirky/protocol'
import { narrowTreeModel, type GroupNode, type ProjectNode, type TreeModel } from '../src/report'

const project = (id: string): ProjectNode => ({ repo: { id } as Repo, rows: [], pending: [] })
const group = (id: string, parts: Partial<GroupNode> = {}): GroupNode => ({
  group: { id } as GroupNode['group'],
  parentId: null,
  projects: [],
  rows: [],
  looseRows: [],
  children: [],
  depth: 0,
  ...parts
})
const pinned = (repoId: string) => ({ id: `wt-${repoId}`, repoId }) as Worktree

const model: TreeModel = {
  pinned: [pinned('a'), pinned('b')],
  projects: [project('a'), project('b')],
  groups: [
    group('holds-c', { projects: [project('c')] }),
    group('holds-b', { projects: [project('b')] }),
    group('parent-of-c', { children: [group('child', { projects: [project('c')] })] })
  ]
}

test('all projects keeps the whole tree', () => {
  expect(narrowTreeModel(model, [])).toBe(model)
})

test('narrowing drops other projects and their pinned rows', () => {
  const narrowed = narrowTreeModel(model, ['a'])
  expect(narrowed.projects.map((node) => node.repo.id)).toEqual(['a'])
  expect(narrowed.pinned.map((worktree) => worktree.repoId)).toEqual(['a'])
})

test('narrowing drops a group left empty, and keeps a parent whose child still shows', () => {
  const narrowed = narrowTreeModel(model, ['c'])
  expect(narrowed.projects).toEqual([])
  expect(narrowed.groups.map((node) => node.group.id)).toEqual(['holds-c', 'parent-of-c'])
  expect(narrowed.groups[1]!.children.map((node) => node.group.id)).toEqual(['child'])
})
