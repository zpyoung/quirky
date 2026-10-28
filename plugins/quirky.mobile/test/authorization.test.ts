import { describe, expect, test } from 'bun:test'
import { MOBILE_METHOD_ALLOWLIST, assertMobileCallAllowed } from '../src/daemon/authorization'

describe('mobile RPC authorization', () => {
  test('uses literal routes for safe consumer APIs across each current feature family', () => {
    for (const method of [
      'status.get', 'quirky.mobile/info', 'quirky.mobile/preferences', 'quirky.mobile/updatePreferences',
      'quirky.mobile/bundleManifest', 'quirky.mobile/bundleChunk', 'quirky.mobile/bundleRange', 'quirky.mobile/agentCatalog',
      'quirky.repo/list', 'quirky.repo/groupList', 'quirky.worktree/list', 'quirky.worktree/show', 'quirky.worktree/create',
      'quirky.worktree/describeRemove', 'quirky.worktree/remove', 'quirky.worktree/set',
      'quirky.session/list', 'quirky.session/get', 'quirky.session/create', 'quirky.session/resume', 'quirky.session/restore', 'quirky.session/setName', 'quirky.session/close',
      'quirky.agent-status/wait', 'quirky.ask/list', 'quirky.ask/answer', 'quirky.terminal/attach', 'quirky.terminal/detach', 'quirky.terminal/mobileState',
      'quirky.agent-status/list', 'quirky.agent-status/get', 'quirky.agent-status/explain', 'quirky.agent-status/waitOutput',
      'quirky.terminal/claim', 'quirky.terminal/read', 'quirky.terminal/snapshot', 'quirky.terminal/history', 'quirky.terminal/write',
      'quirky.terminal/send', 'quirky.terminal/resize', 'quirky.terminal/describeClose', 'quirky.terminal/clear',
      'quirky.terminal/displayMode'
    ]) expect(Object.hasOwn(MOBILE_METHOD_ALLOWLIST, method)).toBe(true)
    for (const method of [
      'quirky.agents/list', 'quirky.agents/prepareResume', 'events.subscribe', 'quirky.mobile/admin', 'quirky.git/status', 'quirky.accounts/list', 'quirky.hosting/files',
      'quirky.mobile/pair', 'daemon.stop', 'plugin.install', 'plugin.disable', 'distro.install',
      'settings.update', 'ui.command.run', 'quirky.terminal/restartHost', 'quirky.terminal/killAll',
      'quirky.git/forcePush', 'quirky.terminal/takeBack', 'quirky.terminal/restoreFit', 'quirky.agents/configure',
      'quirky.agent-status/send', 'quirky.ask/cancel', 'quirky.files/read',
      'quirky.worktree/listAll', 'quirky.worktree/resolve', 'quirky.session-info/sections'
    ]) expect(Object.hasOwn(MOBILE_METHOD_ALLOWLIST, method)).toBe(false)
    expect(() => assertMobileCallAllowed('quirky.mobile/agentCatalog', {})).not.toThrow()
    expect(() => assertMobileCallAllowed('quirky.agents/list', {})).toThrow()
    expect(() => assertMobileCallAllowed('quirky.session/create', { worktree: 'floating', agent: 'shell', cols: 80, rows: 24 })).not.toThrow()
    for (const key of ['command', 'cwd', 'extraArgs', 'model', 'options', 'prompt']) {
      expect(() => assertMobileCallAllowed('quirky.session/create', { worktree: 'floating', agent: 'shell', [key]: 'unrestricted' })).toThrow()
    }
  })

  test('rejects prefixes, unknown routes, and request-supplied identity or credential fields', () => {
    for (const method of ['quirky.terminal/attachMore', 'quirky.git/status/admin', 'quirky.unknown/list']) {
      expect(() => assertMobileCallAllowed(method, {})).toThrow()
    }
    for (const key of ['deviceId', 'role', 'token', 'deviceToken', 'credential', 'caller', 'client', 'scope']) {
      expect(() => assertMobileCallAllowed('quirky.terminal/write', { session: 's', data: 'ok', [key]: 'spoofed' })).toThrow()
    }
  })

  test('rejects unknown fields and bounds terminal write, resize, and attach input', () => {
    expect(() => assertMobileCallAllowed('status.get', { foo: true })).toThrow()
    expect(() => assertMobileCallAllowed('quirky.terminal/write', { session: 's', data: 'x'.repeat(65 * 1024) })).toThrow()
    expect(() => assertMobileCallAllowed('quirky.terminal/resize', { session: 's', cols: 1001, rows: 25 })).toThrow()
    expect(() => assertMobileCallAllowed('quirky.terminal/attach', { session: 's', cols: 80, rows: 24, claim: 'yes' })).toThrow()
    expect(() => assertMobileCallAllowed('quirky.terminal/attach', { session: 's', cols: 80, rows: 24 })).not.toThrow()
    expect(() => assertMobileCallAllowed('quirky.terminal/claim', { session: 's', cols: 1000, rows: 500 })).not.toThrow()
    expect(() => assertMobileCallAllowed('quirky.terminal/claim', { session: 's', cols: 1001, rows: 25 })).toThrow()
  })

  test('keeps filesystem APIs outside the shipped phone page surface', () => {
    expect(() => assertMobileCallAllowed('quirky.ask/answer', { askId: 'ask-1', answers: { question: 'yes' } })).not.toThrow()
    expect(() => assertMobileCallAllowed('quirky.ask/answer', { askId: 'ask-1', answers: {}, token: 'secret' })).toThrow()
    for (const method of ['quirky.hosting/files', 'quirky.hosting/fileContents', 'quirky.git/status', 'quirky.files/read']) {
      expect(() => assertMobileCallAllowed(method, {})).toThrow()
    }
  })

  test('admits only empty-parameter compact loop summaries as read-only mobile access', () => {
    expect(Object.hasOwn(MOBILE_METHOD_ALLOWLIST, 'quirky.loops/summaries')).toBe(true)
    expect(() => assertMobileCallAllowed('quirky.loops/summaries', {})).not.toThrow()
    for (const params of [{ worktree: 'worktree-1' }, { includeEnded: true }, { token: 'secret' }]) {
      expect(() => assertMobileCallAllowed('quirky.loops/summaries', params)).toThrow()
    }
    for (const method of [
      'quirky.loops/list', 'quirky.loops/get', 'quirky.loops/history', 'quirky.loops/iterations',
      'quirky.loops/create', 'quirky.loops/edit', 'quirky.loops/pause', 'quirky.loops/resume', 'quirky.loops/stop'
    ]) {
      expect(Object.hasOwn(MOBILE_METHOD_ALLOWLIST, method)).toBe(false)
      expect(() => assertMobileCallAllowed(method, {})).toThrow()
    }
  })

  test('admits only bounded page bundles, safe agent catalog, phone preferences, and shipped workspace consumers', () => {
    for (const method of [
      'quirky.mobile/bundleManifest', 'quirky.mobile/bundleChunk', 'quirky.mobile/bundleRange',
      'quirky.mobile/agentCatalog', 'quirky.mobile/preferences', 'quirky.mobile/updatePreferences',
      'quirky.repo/list', 'quirky.repo/groupList', 'quirky.worktree/create', 'quirky.worktree/describeRemove',
      'quirky.worktree/remove', 'quirky.worktree/set', 'quirky.terminal/describeClose', 'quirky.terminal/clear', 'quirky.terminal/displayMode'
    ]) expect(Object.hasOwn(MOBILE_METHOD_ALLOWLIST, method)).toBe(true)
    expect(() => assertMobileCallAllowed('quirky.mobile/agentCatalog', {})).not.toThrow()
    expect(() => assertMobileCallAllowed('quirky.mobile/agentCatalog', { rawAgents: true })).toThrow()
    expect(() => assertMobileCallAllowed('quirky.mobile/bundleManifest', {})).not.toThrow()
    expect(() => assertMobileCallAllowed('quirky.mobile/bundleChunk', { buildId: 'a'.repeat(64), path: 'index.html', offset: 0 })).not.toThrow()
    expect(() => assertMobileCallAllowed('quirky.mobile/bundleChunk', { buildId: 'a'.repeat(64), path: '../secret', offset: 0 })).toThrow()
    expect(() => assertMobileCallAllowed('quirky.mobile/bundleRange', { buildId: 'a'.repeat(64), path: 'index.html', offset: 0, gzip: true })).not.toThrow()
    expect(() => assertMobileCallAllowed('quirky.mobile/preferences', {})).not.toThrow()
    expect(() => assertMobileCallAllowed('quirky.mobile/updatePreferences', { autoRestoreFitMs: null })).not.toThrow()
    expect(() => assertMobileCallAllowed('quirky.mobile/updatePreferences', { autoRestoreFitMs: 60_000, machineName: 'admin' })).toThrow()
    expect(() => assertMobileCallAllowed('quirky.worktree/remove', { worktree: 'worktree-1' })).toThrow(/confirmation/i)
    expect(() => assertMobileCallAllowed('quirky.worktree/remove', { worktree: 'worktree-1', yes: true })).not.toThrow()
    expect(() => assertMobileCallAllowed('quirky.worktree/remove', { worktree: 'worktree-1', yes: 'yes' })).toThrow()
    expect(() => assertMobileCallAllowed('quirky.worktree/remove', { worktree: 'worktree-1', force: true })).toThrow()
    expect(() => assertMobileCallAllowed('quirky.terminal/clear', { session: 'session-1' })).not.toThrow()
    expect(() => assertMobileCallAllowed('quirky.terminal/displayMode', { session: 'session-1', mode: 'phone', cols: 80, rows: 24 })).not.toThrow()
    expect(() => assertMobileCallAllowed('quirky.terminal/displayMode', { session: 'session-1', mode: 'desktop' })).not.toThrow()
    expect(() => assertMobileCallAllowed('quirky.terminal/displayMode', { session: 'session-1', mode: 'phone' })).toThrow()
    expect(() => assertMobileCallAllowed('quirky.terminal/displayMode', { session: 'session-1', mode: 'desktop', cols: 80, rows: 24 })).toThrow()
    expect(() => assertMobileCallAllowed('quirky.mobile/bundleChunk', { buildId: 'a'.repeat(64), path: 'index.html', offset: -1 })).toThrow()
    expect(() => assertMobileCallAllowed('quirky.worktree/create', { repo: 'repo', name: 'name', trustSetup: true })).toThrow()
    expect(() => assertMobileCallAllowed('quirky.worktree/create', { repo: 'repo', name: 'name', branchName: 'phone/name', base: 'main' })).not.toThrow()
    expect(() => assertMobileCallAllowed('quirky.worktree/set', { worktree: 'worktree-1', pinned: true, expectedInstanceId: 'instance-1' })).not.toThrow()
    expect(() => assertMobileCallAllowed('quirky.worktree/set', { worktree: 'worktree-1', status: 'done' })).toThrow()
    expect(() => assertMobileCallAllowed('quirky.ask/list', { pendingOnly: false })).not.toThrow()
  })

  test('restores bounded safe session and output consumers', () => {
    expect(() => assertMobileCallAllowed('quirky.session/get', { session: 'session-1' })).not.toThrow()
    expect(() => assertMobileCallAllowed('quirky.session/get', { session: 'session-1', launch: { env: { SECRET: 'private' } } })).toThrow()
    expect(() => assertMobileCallAllowed('quirky.session/resume', { session: 'session-1', fork: true })).not.toThrow()
    expect(() => assertMobileCallAllowed('quirky.session/restore', { session: 'session-1' })).not.toThrow()
    expect(() => assertMobileCallAllowed('quirky.agent-status/list', { worktree: 'worktree-1' })).not.toThrow()
    expect(() => assertMobileCallAllowed('quirky.agent-status/get', { session: 'session-1', at: Date.now() })).not.toThrow()
    expect(() => assertMobileCallAllowed('quirky.agent-status/explain', { session: 'session-1' })).not.toThrow()
    expect(() => assertMobileCallAllowed('quirky.agent-status/waitOutput', { session: 'session-1', pattern: 'ready', ignoreCase: true, lines: 2000, timeoutMs: 60_000 })).not.toThrow()
    expect(() => assertMobileCallAllowed('quirky.agent-status/waitOutput', { session: 'session-1', pattern: '(a+)+', timeoutMs: 60_000 })).toThrow()
    expect(() => assertMobileCallAllowed('quirky.agent-status/waitOutput', { session: 'session-1', pattern: 'ready', lines: 2001 })).toThrow()
    expect(() => assertMobileCallAllowed('quirky.agent-status/waitOutput', { session: 'session-1', pattern: 'ready', timeoutMs: 60_001 })).toThrow()
    expect(() => assertMobileCallAllowed('quirky.agent-status/wait', { session: 'session-1', until: ['exited'], timeoutMs: 60_000 })).not.toThrow()
    expect(() => assertMobileCallAllowed('quirky.agent-status/wait', { session: 'session-1', until: ['exited'], timeoutMs: 60_001 })).toThrow()
    expect(() => assertMobileCallAllowed('quirky.terminal/history', { session: 'session-1', lines: 200, before: 'cursor', format: 'text' })).not.toThrow()
    expect(() => assertMobileCallAllowed('quirky.terminal/history', { session: 'session-1', raw: true })).toThrow()
  })
})
