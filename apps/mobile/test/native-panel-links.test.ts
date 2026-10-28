import { expect, test } from 'bun:test'
import { parsePanelDeepLink } from '../src/native/panel-links'

const hostId = 'paired host/one'
const pairedHosts = [hostId]

const segment = (value: string) => encodeURIComponent(value)

test('decodes opaque host and worktree ids and validates encoded file paths', () => {
  const worktreeId = '/worktrees/feature one'
  const path = 'src/files with spaces/a+b.ts'
  const url = `quirky://h/${segment(hostId)}/files/preview/${segment(worktreeId)}?path=${segment(path)}`

  expect(parsePanelDeepLink(url, pairedHosts)).toEqual({
    hostId,
    route: { kind: 'file-preview', worktreeId, path }
  })
})

test('maps legacy pull request and history paths to source control tabs', () => {
  const worktreeId = '/worktrees/fix'

  expect(parsePanelDeepLink(`quirky://h/${segment(hostId)}/pr/${segment(worktreeId)}`, pairedHosts)).toEqual({
    hostId,
    route: { kind: 'source-control', worktreeId, tab: 'pull-request' }
  })
  expect(parsePanelDeepLink(`quirky://h/${segment(hostId)}/history/${segment(worktreeId)}`, pairedHosts)).toEqual({
    hostId,
    route: { kind: 'source-control', worktreeId, tab: 'commits' }
  })
})

test('accepts canonical host-level panels and optional notification worktree', () => {
  const prefix = `quirky://h/${segment(hostId)}`

  expect(parsePanelDeepLink(`${prefix}/tasks`, pairedHosts)?.route).toEqual({ kind: 'tasks' })
  expect(parsePanelDeepLink(`${prefix}/accounts`, pairedHosts)?.route).toEqual({ kind: 'accounts' })
  expect(parsePanelDeepLink(`${prefix}/notifications`, pairedHosts)?.route).toEqual({ kind: 'notifications' })
  expect(parsePanelDeepLink(`${prefix}/notifications/${segment('/worktrees/one')}`, pairedHosts)?.route).toEqual({
    kind: 'notifications', worktreeId: '/worktrees/one'
  })
})

test('parses canonical worktree panel paths and optional file paths', () => {
  const prefix = `quirky://h/${segment(hostId)}`
  const worktreeId = '/worktrees/topic/one'
  const filePath = 'src/feature notes.md'

  expect(parsePanelDeepLink(`${prefix}/source-control/${segment(worktreeId)}`, pairedHosts)?.route).toEqual({
    kind: 'source-control', worktreeId
  })
  expect(parsePanelDeepLink(`${prefix}/review/${segment(worktreeId)}`, pairedHosts)?.route).toEqual({
    kind: 'review', worktreeId
  })
  expect(parsePanelDeepLink(`${prefix}/files/${segment(worktreeId)}`, pairedHosts)?.route).toEqual({
    kind: 'files', worktreeId
  })
  expect(parsePanelDeepLink(`${prefix}/review/${segment(worktreeId)}?path=${segment(filePath)}`, pairedHosts)?.route).toEqual({
    kind: 'review', worktreeId, path: filePath
  })
  expect(parsePanelDeepLink(`${prefix}/files/${segment(worktreeId)}?path=${segment(filePath)}`, pairedHosts)?.route).toEqual({
    kind: 'files', worktreeId, path: filePath
  })
  expect(parsePanelDeepLink(`${prefix}/agent-history/${segment(worktreeId)}`, pairedHosts)?.route).toEqual({
    kind: 'agent-history', worktreeId
  })
})

test('rejects unknown hosts, schemes, extra authority fields, and unknown query fields', () => {
  const path = `/${segment(hostId)}/tasks`

  expect(parsePanelDeepLink(`https://h${path}`, pairedHosts)).toBeNull()
  expect(parsePanelDeepLink(`quirky://h.evil${path}`, pairedHosts)).toBeNull()
  expect(parsePanelDeepLink(`quirky://h:443${path}`, pairedHosts)).toBeNull()
  expect(parsePanelDeepLink(`quirky://user@h${path}`, pairedHosts)).toBeNull()
  expect(parsePanelDeepLink(`quirky://h/${segment('not paired')}/tasks`, pairedHosts)).toBeNull()
  expect(parsePanelDeepLink(`quirky://h/${segment(hostId)}/files/${segment('/w')}?path=src/a&admin=true`, pairedHosts)).toBeNull()
})

test('rejects traversing, absolute, and oversized panel file paths', () => {
  const prefix = `quirky://h/${segment(hostId)}/files/preview/${segment('/worktrees/one')}?path=`

  expect(parsePanelDeepLink(`${prefix}${segment('../secret')}`, pairedHosts)).toBeNull()
  expect(parsePanelDeepLink(`${prefix}${segment('src/../../secret')}`, pairedHosts)).toBeNull()
  expect(parsePanelDeepLink(`${prefix}${segment('C:\\secret')}`, pairedHosts)).toBeNull()
  expect(parsePanelDeepLink(`${prefix}${segment('/etc/passwd')}`, pairedHosts)).toBeNull()
  expect(parsePanelDeepLink(`${prefix}${segment('x'.repeat(1025))}`, pairedHosts)).toBeNull()
})
