import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  assertAccountAdd,
  assertAccountLogin,
  assertAccountsPresent,
  assertAccountsRemoved,
  assertHooksRemoved,
  assertHooksSetup,
  assertHooksStatus,
  assertNoOutsideCalls,
  assertPaneRead,
  assertPaneSplit,
  assertPaneTitle,
  assertRepoClone,
  assertRepoCreated,
  assertRepoRemoved,
  assertRepoSet,
  assertSearchRefs,
  assertTabActivation,
  assertTabRename,
  assertTerminalSessions,
  assertWorktreeCurrent,
  cleanupLocalChecks
} from './cli-local'

const fixtureText = 'first\nsecond λ\n'
const hookDocument = { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo user-owned-hook' }] }] } }
const hookText = JSON.stringify(hookDocument)

function expectRejected(assertion: () => void): void {
  expect(assertion).toThrow()
}
function expectErrorKind(assertion: () => void, kind: string, message?: string): void {
  let caught: unknown
  try {
    assertion()
  } catch (error) {
    caught = error
  }
  expect(caught).toMatchObject({ kind })
  if (message) expect((caught as Error).message).toContain(message)
}

test('worktree current verifies nested, main-repository and refusal results', () => {
  const expected = { worktreeId: 'wt-1', worktreePath: '/owned/worktree', repoId: 'repo-1' }
  assertWorktreeCurrent({
    nested: { id: 'wt-1', path: '/owned/worktree' },
    main: { isMain: true, repoId: 'repo-1' },
    outside: { code: 'not-found', message: 'no worktree matches current; use id:, name:, branch:, path: or current' }
  }, expected)
  expectRejected(() => assertWorktreeCurrent({
    nested: { id: 'other', path: '/owned/worktree' },
    main: { isMain: true, repoId: 'repo-1' },
    outside: { code: 'not-found', message: 'no worktree matches current; use id:, name:, branch:, path: or current' }
  }, expected))
})

test('repo setup assertions verify clone bytes and origin, creation, metadata, and removal', () => {
  assertRepoClone({
    result: { kind: 'git', name: 'cli-parity-clone', path: '/owned/repositories/clones/cli-parity-clone' },
    fixtureBytes: Buffer.from(fixtureText),
    originUrl: '/owned/fixtures/repository'
  }, {
    name: 'cli-parity-clone', path: '/owned/repositories/clones/cli-parity-clone', originUrl: '/owned/fixtures/repository', fixtureText
  })
  expectRejected(() => assertRepoClone({
    result: { kind: 'git', name: 'cli-parity-clone', path: '/wrong' }, fixtureBytes: Buffer.from(fixtureText), originUrl: '/wrong'
  }, { name: 'cli-parity-clone', path: '/owned/repositories/clones/cli-parity-clone', originUrl: '/owned/fixtures/repository', fixtureText }))

  assertRepoCreated({ kind: 'git', path: '/owned/repositories/created/cli-parity-created' }, '/owned/repositories/created/cli-parity-created')
  expectRejected(() => assertRepoCreated({ kind: 'folder', path: '/wrong' }, '/owned/repositories/created/cli-parity-created'))

  assertRepoSet({
    updated: { repo: { displayName: 'CLI parity setup' }, settings: { worktreeLocation: '/owned/worktrees/clone-base' } },
    cleared: { repo: { displayName: null }, settings: { worktreeLocation: '/owned/worktrees/clone-base' } },
    worktreeLocation: '/owned/worktrees/clone-base'
  })
  expectRejected(() => assertRepoSet({
    updated: { repo: { displayName: 'CLI parity setup' }, settings: { worktreeLocation: '/owned/worktrees/clone-base' } },
    cleared: { repo: { displayName: null }, settings: { worktreeLocation: '/changed' } },
    worktreeLocation: '/owned/worktrees/clone-base'
  }))

  assertRepoRemoved({
    cloneRemoved: { ok: true }, createdRemoved: { ok: true },
    repos: [{ id: 'fixture' }, { id: 'folder' }], cloneFileExists: true, createdHeadExists: true,
    cloneId: 'clone', createdId: 'created', fixtureId: 'fixture', folderId: 'folder',
    missingRefusal: { code: 'not-found', message: 'no repo matches id:does-not-exist; use id:, name: or path:' }
  })
  expectRejected(() => assertRepoRemoved({
    cloneRemoved: { ok: true }, createdRemoved: { ok: true },
    repos: [{ id: 'fixture' }, { id: 'folder' }, { id: 'clone' }], cloneFileExists: true, createdHeadExists: true,
    cloneId: 'clone', createdId: 'created', fixtureId: 'fixture', folderId: 'folder',
    missingRefusal: { code: 'not-found', message: 'no repo matches id:does-not-exist; use id:, name: or path:' }
  }))
})

test('repo search refs verifies exact order, kinds, targets and truncation', () => {
  const refs = [
    { name: 'cli-parity-both', kind: 'branch', ref: 'refs/heads/cli-parity-both', target: 'head-1' },
    { name: 'cli-parity-topic', kind: 'branch', ref: 'refs/heads/cli-parity-topic', target: 'head-1' },
    { name: 'cli-parity-both', kind: 'tag', ref: 'refs/tags/cli-parity-both', target: 'head-1' },
    { name: 'cli-parity-v1', kind: 'tag', ref: 'refs/tags/cli-parity-v1', target: 'head-1' }
  ]
  const refusal = { code: 'invalid-params', message: 'plain project folder is not a Git repository', data: { reason: 'not-git' } }
  const expected = {
    truncated: false,
    limited: { refs: refs.slice(0, 3), truncated: true },
    caseInsensitive: { refs: [refs[3]], truncated: false },
    folderName: 'plain project folder', folderRefusal: refusal
  }
  assertSearchRefs({ refs, ...expected }, 'head-1')
  expectRejected(() => assertSearchRefs({ refs: [refs[2], refs[1], refs[0], refs[3]], ...expected }, 'head-1'))
})

test('terminal assertions correlate sessions, pane identities, titles and live shell output', () => {
  const terminal = {
    sessions: { sessions: [{ sessionId: 'session-1', state: 'running', pid: 101, worktreeId: 'wt-1', cwd: '/owned/worktree' }] },
    layout: { id: 'wt-1', root: { kind: 'group', id: 'group-1', tabs: [{ id: 'tab-1', root: { kind: 'pane', id: 'pane-1', session: 'session-1' } }], activeTab: 'tab-1' }, activeGroup: 'group-1' },
    sessionId: 'session-1', tabId: 'tab-1', paneId: 'pane-1', worktreeId: 'wt-1', worktreePath: '/owned/worktree'
  }
  assertTerminalSessions(terminal)
  expectRejected(() => assertTerminalSessions({ ...terminal, sessions: { sessions: [{ ...terminal.sessions.sessions[0], worktreeId: 'other' }] } }))

  assertTabRename({
    tabId: 'tab-1', renamedLayout: { tabs: [{ id: 'tab-1', customTitle: 'cli-parity-tab', defaultTitle: 'cli-parity-local' }] },
    clearedLayout: { tabs: [{ id: 'tab-1', customTitle: null, defaultTitle: 'cli-parity-local' }] }
  })
  expectRejected(() => assertTabRename({
    tabId: 'tab-1', renamedLayout: { tabs: [{ id: 'tab-1', customTitle: 'wrong', defaultTitle: 'cli-parity-local' }] },
    clearedLayout: { tabs: [{ id: 'tab-1', customTitle: null, defaultTitle: 'cli-parity-local' }] }
  }))

  assertPaneSplit({ session: 'session-2', pane: 'pane-2' }, { session: 'session-1', pane: 'pane-1' })
  expectRejected(() => assertPaneSplit({ session: 'session-1', pane: 'pane-1' }, { session: 'session-1', pane: 'pane-1' }))
  assertPaneRead({ lines: ['shell$ printf', 'SPLIT:/owned/work', 'tree', 'shell$'] }, '/owned/worktree')
  expectRejected(() => assertPaneRead({ lines: ['shell$ printf SPLIT:wrong'] }, '/owned/worktree'))

  assertPaneTitle({
    titled: { workspace: 'wt-1', tab: 'tab-1', pane: { id: 'pane-2', session: 'session-2', title: 'cli-parity-pane' }, active: true },
    byFirstSession: { pane: { id: 'pane-1', session: 'session-1', title: null }, active: false },
    cleared: { pane: { id: 'pane-2', session: 'session-2', title: null } },
    expected: { worktreeId: 'wt-1', tabId: 'tab-1', paneId: 'pane-2', sessionId: 'session-2', firstPaneId: 'pane-1', firstSessionId: 'session-1' }
  })
  expectRejected(() => assertPaneTitle({
    titled: { workspace: 'wt-1', tab: 'tab-1', pane: { id: 'pane-2', session: 'session-2', title: 'wrong' }, active: true },
    byFirstSession: { pane: { id: 'pane-1', session: 'session-1', title: null }, active: false },
    cleared: { pane: { id: 'pane-2', session: 'session-2', title: null } },
    expected: { worktreeId: 'wt-1', tabId: 'tab-1', paneId: 'pane-2', sessionId: 'session-2', firstPaneId: 'pane-1', firstSessionId: 'session-1' }
  }))
})

test('tab activation proves daemon layout state, refusal, and closed sessions', () => {
  const value = {
    layout: { id: 'wt-1', root: { kind: 'group', id: 'group-1', tabs: [], activeTab: 'tab-1' }, activeGroup: 'group-1' },
    groupId: 'group-1', tabId: 'tab-1',
    refusal: { code: 'not-found', message: 'no tab tab-does-not-exist' },
    sessions: { sessions: [] }, sessionIds: ['session-1', 'session-2', 'session-3']
  }
  assertTabActivation(value)
  expectRejected(() => assertTabActivation({ ...value, layout: { ...value.layout, root: { ...value.layout.root, activeTab: 'tab-2' } } }))
})

test('hook assertions preserve the user entry, install Quirky entries idempotently, and stay under home', () => {
  const home = '/owned/home'
  const hookFile = join(home, 'codex/hooks.json')
  const entries = Array.from({ length: 28 }, (_, index) => ({
    agent: index === 0 ? 'codex' : `agent-${index}`,
    status: index === 0 ? 'not-installed' : 'installed',
    files: [index === 0 ? hookFile : join(home, 'agent', `${index}.json`)]
  }))
  assertHooksStatus({ entries, codexDocument: hookText, home, hookFile, userDocument: hookDocument })
  expectRejected(() => assertHooksStatus({
    entries: [{ ...entries[0], files: ['/outside/hooks.json'] }, ...entries.slice(1)], codexDocument: hookText, home, hookFile, userDocument: hookDocument
  }))

  assertHooksSetup({
    setup: [{ agent: 'codex', status: 'installed', changed: [hookFile] }],
    status: entries.map((entry, index) => index === 0 ? { ...entry, status: 'installed' } : entry),
    repeated: [{ agent: 'codex', status: 'installed', changed: [] }],
    codexDocument: JSON.stringify({ hooks: { Stop: [...hookDocument.hooks.Stop, { hooks: [{ type: 'command', command: '/bin/quirky-hook\" codex' }] }] } }),
    hookFile, home, userDocument: hookDocument
  })
  expectRejected(() => assertHooksSetup({
    setup: [{ agent: 'codex', status: 'installed', changed: [hookFile] }],
    status: entries.map((entry, index) => index === 0 ? { ...entry, status: 'installed' } : entry),
    repeated: [{ agent: 'codex', status: 'installed', changed: [] }],
    codexDocument: JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: '/bin/quirky-hook\" codex' }] }] } }),
    hookFile, home, userDocument: hookDocument
  }))

  assertHooksRemoved({
    removals: [
      { agent: 'codex', status: 'not-installed', changed: [hookFile] },
      { agent: 'codex', status: 'not-installed', changed: [hookFile] }
    ], codexDocument: hookText, hookFile, userDocument: hookDocument
  })
  expectRejected(() => assertHooksRemoved({
    removals: [{ agent: 'codex', status: 'not-installed', changed: [hookFile] }],
    codexDocument: JSON.stringify({ hooks: {} }), hookFile, userDocument: hookDocument
  }))
})

test('account assertions prove local login identity, active selection, and private-data removal', () => {
  const added = { status: 'pending', id: 'login-1', accountId: 'account-1' }
  expect(assertAccountAdd(added, 'CLI parity Claude')).toEqual({ id: 'login-1', accountId: 'account-1' })
  expectRejected(() => assertAccountAdd({ ...added, id: '' }, 'CLI parity Claude'))
  const login = { status: 'complete', error: null, result: { id: 'account-1', label: 'CLI parity Claude', email: 'claude-parity@example.invalid', needsSignIn: false } }
  assertAccountLogin(login, { id: 'account-1', label: 'CLI parity Claude', email: 'claude-parity@example.invalid' })
  expectRejected(() => assertAccountLogin({ ...login, status: 'error' }, { id: 'account-1', label: 'CLI parity Claude', email: 'claude-parity@example.invalid' }))

  const accounts = {
    accounts: [
      { id: 'account-1', provider: 'claude', label: 'CLI parity Claude' },
      { id: 'account-2', provider: 'codex', label: 'CLI parity Codex' }
    ], active: { claude: null, codex: 'account-2' }
  }
  assertAccountsPresent(accounts, { claudeId: 'account-1', codexId: 'account-2' })
  expectRejected(() => assertAccountsPresent({ ...accounts, accounts: accounts.accounts.slice(1) }, { claudeId: 'account-1', codexId: 'account-2' }))
  assertAccountsRemoved({
    removed: { accounts: [], active: { claude: null, codex: null } },
    listed: { accounts: [], active: { claude: null, codex: null } }, profiles: { claude: [], codex: [] }
  })
  expectRejected(() => assertAccountsRemoved({
    removed: { accounts: [], active: { claude: null, codex: null } },
    listed: { accounts: [{ id: 'account-1' }], active: { claude: null, codex: null } }, profiles: { claude: [], codex: [] }
  }))
})

test('egress tripwire accepts only the startup sentinel and rejects outside-call evidence', () => {
  const root = mkdtempSync(join(tmpdir(), 'cli-local-guard-'))
  const egressLog = join(root, 'egress.log')
  const orcaLog = join(root, 'orca.log')
  const securityLog = join(root, 'security.log')
  try {
    writeFileSync(egressLog, 'https://cli-parity-guard.invalid/self-test\n')
    writeFileSync(orcaLog, '')
    writeFileSync(securityLog, 'find-generic-password -w\ndelete-generic-password -s fixture\n')
    assertNoOutsideCalls({ egressLog, orcaLog, securityLog })
    writeFileSync(egressLog, 'https://cli-parity-guard.invalid/self-test\nhttps://example.invalid/leak\n')
    expectErrorKind(() => assertNoOutsideCalls({ egressLog, orcaLog, securityLog }), 'outside-call', 'https://example.invalid/leak')
    writeFileSync(egressLog, 'https://cli-parity-guard.invalid/self-test\n')
    writeFileSync(orcaLog, 'orca subcommand\n')
    expectErrorKind(() => assertNoOutsideCalls({ egressLog, orcaLog, securityLog }), 'outside-call', 'orca subcommand')
    writeFileSync(orcaLog, '')
    writeFileSync(securityLog, 'find-generic-password -w\nnetwork-call\n')
    expectErrorKind(() => assertNoOutsideCalls({ egressLog, orcaLog, securityLog }), 'outside-call', 'network-call')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('local cleanup attempts every resource independently across partial states', async () => {
  const resources: Array<{ state: Record<string, unknown>; expected: string[] }> = [
    { state: { localTabIds: ['tab-1'], localClosedTabIds: [] }, expected: ['terminal tab close tab-1 --yes'] },
    { state: { localTabIds: [], localClaudeAccountId: 'claude-id' }, expected: ['accounts remove --provider claude --account-id claude-id --yes'] },
    { state: { localTabIds: [], localCodexAccountId: 'codex-id' }, expected: ['accounts remove --provider codex --account-id codex-id --yes'] },
    { state: { localTabIds: [], localHooksSetup: true, localHooksRemoved: false }, expected: ['agent-status hooks remove codex'] },
    { state: { localTabIds: [], localCloneId: 'clone-id' }, expected: ['repo rm clone-id'] },
    { state: { localTabIds: [], localCreatedRepoId: 'created-id' }, expected: ['repo rm created-id'] }
  ]
  for (const { state, expected } of resources) {
    const calls: string[][] = []
    await cleanupLocalChecks({ state }, async argv => { calls.push(argv); return { ok: true } }, [])
    expect(calls.map(argv => argv.join(' '))).toEqual(expected)
  }
})

test('local cleanup closes only still-open tabs discovered after partial creation', async () => {
  const state: Record<string, unknown> = {
    worktreeId: 'wt-1', localTerminalCreationStarted: true, localTerminalBaseline: ['baseline-tab'],
    localTabIds: ['tab-closed', 'tab-open'], localClosedTabIds: ['tab-closed']
  }
  const calls: string[][] = []
  await cleanupLocalChecks({ state }, async argv => {
    calls.push(argv)
    return argv[1] === 'layout'
      ? { workspace: { root: { id: 'tab-open', root: { kind: 'pane', id: 'pane-1', session: 'session-1' } } } }
      : { ok: true }
  }, [])
  expect(calls).toEqual([
    ['terminal', 'layout', '--worktree', 'wt-1'],
    ['terminal', 'tab', 'close', 'tab-open', '--yes']
  ])
})

test('local cleanup continues after failures and joins all cleanup errors', async () => {
  const state: Record<string, unknown> = {
    localTabIds: ['tab-1'], localClosedTabIds: [], localClaudeAccountId: 'claude-id',
    localCodexAccountId: 'codex-id', localHooksSetup: true, localHooksRemoved: false,
    localCloneId: 'clone-id', localCreatedRepoId: 'created-id'
  }
  const calls: string[][] = []
  const errors: string[] = []
  await cleanupLocalChecks({ state }, async argv => {
    calls.push(argv)
    throw new Error(`failed: ${argv.join(' ')}`)
  }, errors)
  expect(calls).toHaveLength(6)
  expect(errors).toHaveLength(6)
  expect(errors.join('; ')).toContain('failed: repo rm created-id')
})
