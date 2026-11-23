import { expect, test } from 'bun:test'
import { AgentRegistry } from '../agents'
import type { ItemEntry } from '../items'

const spawn = (registry: AgentRegistry, id: string, parent?: string, extra: Record<string, unknown> = {}) =>
  registry.spawn({ id, parent, name: id.toUpperCase(), task: `task ${id}`, steps: 'full', startedAt: 10, ...extra })

const agentOf = (entry: ItemEntry | null) => {
  if (!entry || entry.item.kind !== 'agent') throw new Error('not an agent entry')
  return entry.item
}

test('spawn records a working agent and returns a full tool entry', () => {
  const registry = new AgentRegistry()
  const entry = spawn(registry, 'a', undefined, { prompt: 'p', model: 'm', background: true, nativeId: 'n' })
  expect(entry.role).toBe('tool')
  expect(entry.item).toEqual({
    kind: 'agent', id: 'a', name: 'A', task: 'task a', prompt: 'p', model: 'm', background: true,
    state: 'working', startedAt: 10, steps: 'full', nativeId: 'n'
  })
  expect(registry.has('a')).toBe(true)
  expect(registry.isLive('a')).toBe(true)
  expect(registry.get('a')).toEqual(entry.item as never)
})

test('a nested spawn is tagged with its parent and a top-level one is not', () => {
  const registry = new AgentRegistry()
  expect(spawn(registry, 'a').item.agent).toBeUndefined()
  expect(spawn(registry, 'b', 'a').item.agent).toBe('a')
  expect(registry.parentOf('b')).toBe('a')
  expect(registry.parentOf('a')).toBeUndefined()
  expect(registry.parentOf('zzz')).toBeUndefined()
})

test('update merges a patch and returns the whole snapshot, null for an unknown id', () => {
  const registry = new AgentRegistry()
  spawn(registry, 'a')
  const first = agentOf(registry.update('a', { tokens: 5, summary: 'looking' }))
  expect(first).toMatchObject({ id: 'a', name: 'A', task: 'task a', tokens: 5, summary: 'looking', state: 'working', startedAt: 10 })
  const second = agentOf(registry.update('a', { tokens: 9 }))
  expect(second).toMatchObject({ tokens: 9, summary: 'looking' })
  expect(registry.update('nope', { tokens: 1 })).toBeNull()
})

test('end sets a terminal state and endedAt, and a second end returns null', () => {
  const registry = new AgentRegistry()
  spawn(registry, 'a')
  const ended = agentOf(registry.end('a', 'failed', { error: 'boom', endedAt: 99 }))
  expect(ended).toMatchObject({ state: 'failed', error: 'boom', endedAt: 99 })
  expect(registry.isLive('a')).toBe(false)
  expect(registry.end('a', 'done')).toBeNull()
  expect(registry.end('missing', 'done')).toBeNull()
  expect(registry.get('a')?.state).toBe('failed')
})

test('an ended agent cannot be revived by a late update, but other fields still merge', () => {
  const registry = new AgentRegistry()
  spawn(registry, 'a')
  registry.end('a', 'done', { endedAt: 50 })
  const late = agentOf(registry.update('a', { state: 'working', tokens: 7 }))
  expect(late).toMatchObject({ state: 'done', endedAt: 50, tokens: 7 })
})

test('live lists working and needs-you agents only, in spawn order', () => {
  const registry = new AgentRegistry()
  spawn(registry, 'a')
  spawn(registry, 'b')
  spawn(registry, 'c')
  registry.end('b', 'done')
  registry.setAsking('c', true)
  expect(registry.live()).toEqual(['a', 'c'])
  expect(registry.isLive('c')).toBe(true)
  expect(registry.isLive('b')).toBe(false)
  expect(registry.isLive('unknown')).toBe(false)
})

test('descendants returns live descendants deepest first and skips ended ones', () => {
  const registry = new AgentRegistry()
  spawn(registry, 'root')
  spawn(registry, 'kid1', 'root')
  spawn(registry, 'kid2', 'root')
  spawn(registry, 'grand', 'kid1')
  spawn(registry, 'great', 'grand')
  spawn(registry, 'other')
  expect(registry.descendants('root')).toEqual(['great', 'grand', 'kid1', 'kid2'])
  registry.end('kid2', 'done')
  expect(registry.descendants('root')).toEqual(['great', 'grand', 'kid1'])
  expect(registry.descendants('other')).toEqual([])
  expect(registry.descendants('unknown')).toEqual([])
})

test('resolve maps the main agent to no key and a known key to itself', () => {
  const registry = new AgentRegistry()
  spawn(registry, 'a')
  for (const key of ['', null, undefined]) expect(registry.resolve(key)).toEqual({ entries: [] })
  expect(registry.resolve('a')).toEqual({ agent: 'a', entries: [] })
})

test('an unknown key resolves to unattributed and journals the synthetic spawn only on first use', () => {
  const registry = new AgentRegistry()
  const first = registry.resolve('ghost')
  expect(first.agent).toBe('unattributed')
  expect(first.entries).toHaveLength(1)
  expect(agentOf(first.entries[0]!)).toMatchObject({
    id: 'unattributed', name: 'Unattributed', task: 'Events whose agent Quirky could not find', steps: 'full', state: 'working'
  })
  expect(first.entries[0]!.item.agent).toBeUndefined()
  expect(registry.resolve('other-ghost')).toEqual({ agent: 'unattributed', entries: [] })
  expect(registry.has('unattributed')).toBe(true)
})

test('tag copies the entry with the agent set and leaves an undefined agent alone', () => {
  const registry = new AgentRegistry()
  const entry: ItemEntry = { role: 'assistant', text: 'hi', data: null, item: { kind: 'prose', text: 'hi' } }
  const tagged = registry.tag(entry, 'a')
  expect(tagged.item).toEqual({ kind: 'prose', text: 'hi', agent: 'a' })
  expect(entry.item).toEqual({ kind: 'prose', text: 'hi' })
  expect(registry.tag(entry)).toBe(entry)
})

test('cutOff ends every live agent as stopped and cut off, once', () => {
  const registry = new AgentRegistry()
  spawn(registry, 'a')
  spawn(registry, 'b', 'a')
  spawn(registry, 'c')
  registry.end('c', 'done', { endedAt: 5 })
  const entries = registry.cutOff(1234)
  expect(entries.map((entry) => agentOf(entry))).toEqual([
    expect.objectContaining({ id: 'a', state: 'stopped', cutOff: true, endedAt: 1234 }),
    expect.objectContaining({ id: 'b', state: 'stopped', cutOff: true, endedAt: 1234, agent: 'a' })
  ])
  expect(registry.get('c')).toMatchObject({ state: 'done', endedAt: 5 })
  expect(registry.cutOff(2000)).toEqual([])
})

test('askOptions labels the ask and setAsking flips working and needs-you', () => {
  const registry = new AgentRegistry()
  spawn(registry, 'a', undefined, { name: 'test-runner' })
  expect(registry.askOptions('a')).toEqual({ from: 'a', title: 'test-runner asks' })
  expect(agentOf(registry.setAsking('a', true)).state).toBe('needs-you')
  expect(registry.setAsking('a', true)).toBeNull()
  expect(agentOf(registry.setAsking('a', false)).state).toBe('working')
  expect(registry.setAsking('unknown', true)).toBeNull()
  registry.end('a', 'done')
  expect(registry.setAsking('a', true)).toBeNull()
})

test('clearSummaries snapshots live agents that have a summary without it', () => {
  const registry = new AgentRegistry()
  spawn(registry, 'a')
  spawn(registry, 'b')
  spawn(registry, 'c')
  registry.update('a', { summary: 'one' })
  registry.update('c', { summary: 'three' })
  registry.end('c', 'done')
  const entries = registry.clearSummaries()
  expect(entries).toHaveLength(1)
  const item = agentOf(entries[0]!)
  expect(item.id).toBe('a')
  expect('summary' in item).toBe(false)
  expect(registry.get('a')).not.toHaveProperty('summary')
  expect(registry.get('c')?.summary).toBe('three')
})

test('every entry is a full snapshot', () => {
  const registry = new AgentRegistry()
  spawn(registry, 'a', undefined, { model: 'm' })
  const patched = agentOf(registry.update('a', { tokens: 1 }))
  expect(patched).toMatchObject({ kind: 'agent', id: 'a', name: 'A', task: 'task a', model: 'm', steps: 'full', startedAt: 10 })
})

test('get returns a copy and undefined for an unknown id', () => {
  const registry = new AgentRegistry()
  spawn(registry, 'a')
  const copy = registry.get('a')!
  copy.name = 'changed'
  expect(registry.get('a')?.name).toBe('A')
  expect(registry.get('nope')).toBeUndefined()
  expect(registry.has('nope')).toBe(false)
})

test('update with an undefined value clears the field', () => {
  const registry = new AgentRegistry()
  spawn(registry, 'a')
  registry.update('a', { summary: 'x' })
  expect('summary' in agentOf(registry.update('a', { summary: undefined }))).toBe(false)
})

test('descendants reaches live agents beneath an ended intermediate, deepest first', () => {
  const registry = new AgentRegistry()
  spawn(registry, 'root')
  spawn(registry, 'child', 'root')
  spawn(registry, 'grand', 'child')
  spawn(registry, 'great', 'grand')
  registry.end('child', 'done')
  expect(registry.descendants('root')).toEqual(['great', 'grand'])
})

test('a self-parent spawn is top-level and descendants does not throw', () => {
  const registry = new AgentRegistry()
  const entry = spawn(registry, 'self', 'self')
  expect(entry.item.agent).toBeUndefined()
  expect(registry.parentOf('self')).toBeUndefined()
  expect(registry.descendants('self')).toEqual([])
})

test('a spawn whose parent chain contains the new id is refused as a parent', () => {
  const registry = new AgentRegistry()
  spawn(registry, 'a')
  spawn(registry, 'b', 'a')
  const entry = spawn(registry, 'a', 'b')
  expect(entry.item.agent).toBeUndefined()
  expect(registry.parentOf('a')).toBeUndefined()
  expect(registry.descendants('a')).toEqual(['b'])
  expect(registry.descendants('b')).toEqual([])
})

test('reopen puts an ended agent back to working and clears its ending fields', () => {
  const registry = new AgentRegistry()
  spawn(registry, 'root')
  spawn(registry, 'a', 'root')
  registry.update('a', { tokens: 7, summary: 's' })
  registry.end('a', 'done', { report: 'finished', endedAt: 50 })
  registry.update('a', { state: 'working', endedAt: 99 })
  expect(registry.isLive('a')).toBe(false)

  const entry = registry.reopen('a')
  const item = agentOf(entry)
  expect(item).toMatchObject({ id: 'a', state: 'working', tokens: 7, summary: 's', agent: 'root' })
  expect('endedAt' in item).toBe(false)
  expect('report' in item).toBe(false)
  expect(registry.isLive('a')).toBe(true)
  expect(registry.live()).toContain('a')
})

test('reopen clears cutOff and error from a cut-off or failed agent', () => {
  const registry = new AgentRegistry()
  spawn(registry, 'a')
  spawn(registry, 'b')
  registry.cutOff(10)
  registry.end('b', 'failed', { error: 'boom' })
  expect(registry.get('a')).toMatchObject({ cutOff: true })
  const reopened = agentOf(registry.reopen('a'))
  expect(reopened.state).toBe('working')
  expect('cutOff' in reopened).toBe(false)
  expect('endedAt' in reopened).toBe(false)
})

test('reopen is null for a live or unknown agent', () => {
  const registry = new AgentRegistry()
  spawn(registry, 'a')
  expect(registry.reopen('a')).toBeNull()
  expect(registry.reopen('nope')).toBeNull()
  registry.setAsking('a', true)
  expect(registry.reopen('a')).toBeNull()
})

test('update still cannot revive an ended agent after reopen exists', () => {
  const registry = new AgentRegistry()
  spawn(registry, 'a')
  registry.end('a', 'done')
  registry.update('a', { state: 'working' })
  expect(registry.get('a')?.state).toBe('done')
})
