import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { watch } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { delimiter, join } from 'node:path'
import * as React from 'react'
import { createRoot } from 'react-dom/client'
import { HostingSettings } from '../src/create/HostingSettings'
import type { UiLayout, UiPluginContext } from '@quirky/protocol'
import type { ReviewsState } from '../src/contracts'
import { bootReviews } from './support'
import { createReviewsGhSource, createReviewsState, reviewFixture } from './create-fixture'

type ReviewsHost = {
  worktree: string
  repoPath: string
  call(name: string, params?: Record<string, unknown>): Promise<unknown>
  cli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }>
  writeState(value: unknown): void
  invocations(): Array<{ args: string[]; input: string; env: Record<string, string> }>
  cleanup(): Promise<void>
}
type RecordValue = Record<string, unknown>

const hosts: ReviewsHost[] = []
afterEach(async () => {
  for (const host of hosts.splice(0).reverse()) await host.cleanup()
})
const nativeGlobals = [
  'fetch', 'WebSocket', 'Request', 'Response', 'Headers', 'ReadableStream', 'WritableStream', 'TransformStream', 'AbortController', 'AbortSignal',
  'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate', 'clearImmediate',
  'queueMicrotask', 'MessageChannel', 'performance'
] as const
const runtimeGlobals = nativeGlobals.map((name) => [name, (globalThis as Record<string, unknown>)[name]] as const)
const reactGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
const previousActEnvironment = reactGlobal.IS_REACT_ACT_ENVIRONMENT
beforeAll(() => {
  GlobalRegistrator.register()
  // The real daemon/CLI use Bun's transport primitives, not the DOM window's replacements.
  for (const [name, value] of runtimeGlobals) if (value !== undefined) Object.defineProperty(globalThis, name, { value, writable: true, configurable: true })
  reactGlobal.IS_REACT_ACT_ENVIRONMENT = true
})
afterAll(async () => {
  await GlobalRegistrator.unregister()
  if (previousActEnvironment === undefined) delete reactGlobal.IS_REACT_ACT_ENVIRONMENT
  else reactGlobal.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment
})

function record(value: unknown): RecordValue {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('expected an object')
  return value as RecordValue
}



async function boot(gh = createReviewsGhSource): Promise<ReviewsHost> {
  const host = await bootReviews(gh)
  hosts.push(host)
  host.writeState(createReviewsState())
  return host
}

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore', env: process.env })
}

async function stateOf(host: ReviewsHost): Promise<RecordValue> {
  return record(await host.call('state'))
}

function createCalls(host: ReviewsHost): unknown[] {
  return host.invocations().filter((entry) => entry.args[0] === 'pr' && entry.args[1] === 'create')
}

test('R13 create-open confirms one exact branch; submit rejects after the head switches', async () => {
  const host = await boot()
  const opened = record(await host.call('createOpen', { worktree: host.worktree }))
  expect(opened).toMatchObject({ worktree: host.worktree, opened: true })
  const before = await stateOf(host)
  const draft = record(before.creation)
  expect(draft.head).toBe('feature')
  expect(record(draft.eligibility)).toMatchObject({ eligible: true, headOid: expect.any(String) })

  git(host.repoPath, 'checkout', '-b', 'switched-branch')
  await expect(host.call('createSubmit', { worktree: host.worktree })).rejects.toMatchObject({ data: { reason: 'head_changed' } })
  expect(createCalls(host)).toHaveLength(0)
}, 20_000)

test('R14 a failed public push prevents the canonical create mutation', async () => {
  const host = await boot()
  writeFileSync(join(host.repoPath, 'feature.txt'), 'unpublished feature\n')
  git(host.repoPath, 'add', 'feature.txt')
  git(host.repoPath, 'commit', '-m', 'Add unpublished feature')

  const bare = mkdtempSync(join(tmpdir(), 'quirky-reviews-push-'))
  try {
    git(host.repoPath, 'remote', 'set-url', '--add', '--push', 'origin', bare)
    git(bare, 'init', '--bare', '--quiet')
    const hooks = join(bare, 'hooks')
    mkdirSync(hooks, { recursive: true })
    const hook = join(hooks, 'pre-receive')
    writeFileSync(hook, '#!/bin/sh\nprintf "fixture push denied\\n" >&2\nexit 1\n')
    chmodSync(hook, 0o755)

    await host.call('createOpen', { worktree: host.worktree })
    await host.call('createDraft', { worktree: host.worktree, title: 'Unpublished change' })
    await expect(host.call('createSubmit', { worktree: host.worktree })).rejects.toMatchObject({ data: { reason: 'push_failed' } })
    expect(createCalls(host)).toHaveLength(0)
  } finally {
    rmSync(bare, { recursive: true, force: true })
  }
}, 20_000)

test('R14 a canonical already-exists result links the confirmed existing review', async () => {
  const host = await boot()
  await host.call('createOpen', { worktree: host.worktree })
  await host.call('createDraft', { worktree: host.worktree, title: 'Existing feature' })
  host.writeState(createReviewsState({ createMode: 'already_exists', createNumber: 42 }))

  const result = record(await host.call('createSubmit', { worktree: host.worktree }))
  expect(result).toMatchObject({ status: 'already_exists', review: { number: 42, url: 'https://github.com/test-owner/test-repo/pull/42' } })
  const state = await stateOf(host)
  expect(record(record(state.links)[host.worktree])).toMatchObject({ number: 42, url: 'https://github.com/test-owner/test-repo/pull/42' })
  expect(createCalls(host)).toHaveLength(1)
}, 20_000)

test('R14 a failed stack registration preserves and links the created pull request', async () => {
  const host = await boot()
  git(host.repoPath, 'branch', 'parent')
  git(host.repoPath, 'update-ref', 'refs/remotes/origin/parent', 'HEAD')
  host.writeState(createReviewsState({ prs: [reviewFixture(12, 'parent')], createNumber: 16, createMode: 'url', stackRegistrationFails: true }))

  await host.call('createOpen', { worktree: host.worktree })
  const base = record(await host.call('createBase', { worktree: host.worktree, base: 'parent' }))
  expect(base).toMatchObject({ base: 'parent', stackParentNumber: 12 })
  await host.call('createDraft', { worktree: host.worktree, title: 'Stacked feature' })

  const result = record(await host.call('createSubmit', { worktree: host.worktree }))
  expect(result).toMatchObject({ status: 'partial', review: { number: 16, url: 'https://github.com/test-owner/test-repo/pull/16' } })
  const state = await stateOf(host)
  expect(record(record(state.links)[host.worktree])).toMatchObject({ number: 16, url: 'https://github.com/test-owner/test-repo/pull/16' })
  expect(record(state.creation)).toMatchObject({ error: expect.stringContaining('stack registration') })
  expect(createCalls(host)).toHaveLength(1)
}, 20_000)

test('R14 generation consumes the public branch diff and populates the returned title and body', async () => {
  const agentBin = mkdtempSync(join(tmpdir(), 'quirky-reviews-agent-'))
  const agent = join(agentBin, 'claude')
  const previousPath = process.env.PATH
  const previousSearchDirs = process.env.QUIRKY_AGENT_SEARCH_DIRS
  let host: ReviewsHost | undefined
  try {
    writeFileSync(agent, `#!${process.execPath}\nconst args = process.argv.slice(2)\nif (args.includes('--version') || args.includes('--help')) { process.stdout.write('claude fixture\\n'); process.exit(0) }\nconst prompt = await new Response(Bun.stdin.stream()).text()\nif (!prompt.includes('GENERATION_MARKER')) process.exit(19)\nprocess.stdout.write(JSON.stringify({ title: 'Generated from branch diff', body: 'Generated body from branch diff' }))\n`)
    chmodSync(agent, 0o755)
    process.env.PATH = `${agentBin}${delimiter}${previousPath ?? ''}`
    process.env.QUIRKY_AGENT_SEARCH_DIRS = agentBin
    host = await boot()
    writeFileSync(join(host.repoPath, 'generation.txt'), 'GENERATION_MARKER\n')
    git(host.repoPath, 'add', 'generation.txt')
    git(host.repoPath, 'commit', '-m', 'Add generation marker')
    await host.call('createOpen', { worktree: host.worktree })

    const generated = record(await host.call('createGenerate', { worktree: host.worktree }))
    expect(generated).toMatchObject({ generated: true, title: 'Generated from branch diff', body: 'Generated body from branch diff' })
    expect(createCalls(host)).toHaveLength(0)
  } finally {
    await host?.cleanup()
    if (previousPath === undefined) delete process.env.PATH
    else process.env.PATH = previousPath
    if (previousSearchDirs === undefined) delete process.env.QUIRKY_AGENT_SEARCH_DIRS
    else process.env.QUIRKY_AGENT_SEARCH_DIRS = previousSearchDirs
    rmSync(agentBin, { recursive: true, force: true })
  }
}, 20_000)

test('R14 generation cancellation owns only its request and does not publish late output', async () => {
  const agentBin = mkdtempSync(join(tmpdir(), 'quirky-reviews-agent-cancel-'))
  const previousPath = process.env.PATH
  const previousSearchDirs = process.env.QUIRKY_AGENT_SEARCH_DIRS
  let host: ReviewsHost | undefined
  const agent = join(agentBin, 'claude')
  const startedPath = join(agentBin, 'started')
  const controller = new AbortController()
  try {
    writeFileSync(agent, `#!${process.execPath}\nconst fs = require('node:fs')\nconst args = process.argv.slice(2)\nif (args.includes('--version') || args.includes('--help')) { process.stdout.write('claude fixture\\n'); process.exit(0) }\nfs.writeFileSync(${JSON.stringify(startedPath)}, 'started')\nfs.watch(${JSON.stringify(startedPath)}, () => {})\n`)
    chmodSync(agent, 0o755)
    process.env.PATH = `${agentBin}${delimiter}${previousPath ?? ''}`
    process.env.QUIRKY_AGENT_SEARCH_DIRS = agentBin
    host = await boot()
    writeFileSync(join(host.repoPath, 'generation.txt'), 'cancel context\n')
    git(host.repoPath, 'add', 'generation.txt')
    git(host.repoPath, 'commit', '-m', 'Add cancel context')
    await host.call('createOpen', { worktree: host.worktree })

    const started = (async () => {
      for await (const event of watch(agentBin, { signal: controller.signal })) {
        if (event.filename?.toString() === 'started') return
      }
      throw new Error('the agent process did not signal that it started')
    })()
    const generation = host.call('createGenerate', { worktree: host.worktree })
    await Promise.race([
      started,
      generation.then(() => { throw new Error('generation finished before cancellation') })
    ])
    controller.abort()
    const cancelled = record(await host.call('createCancelGenerate', { worktree: host.worktree }))
    expect(cancelled).toEqual({ cancelled: true })
    await expect(generation).rejects.toMatchObject({ data: { reason: 'cancelled' } })

    const creation = record((await stateOf(host)).creation)
    expect(creation).toMatchObject({ generating: false, requestId: null, generated: false })
    expect(createCalls(host)).toHaveLength(0)
  } finally {
    await host?.cleanup()
    controller.abort()
    if (previousPath === undefined) delete process.env.PATH
    else process.env.PATH = previousPath
    if (previousSearchDirs === undefined) delete process.env.QUIRKY_AGENT_SEARCH_DIRS
    else process.env.QUIRKY_AGENT_SEARCH_DIRS = previousSearchDirs
    rmSync(agentBin, { recursive: true, force: true })
  }
}, 20_000)

test('R16 global and repository defaults persist independently; failed account binding stays explicit', async () => {
  const host = await boot()
  await host.call('settingsOpen', { worktree: host.worktree })
  const settingsResult = record(await host.call('hostingSettingsRefresh', { worktree: host.worktree }))
  expect(settingsResult).toMatchObject({ worktree: host.worktree, refreshed: true })
  const settings = record((await stateOf(host)).settings)
  expect(settings).toMatchObject({
    worktree: host.worktree,
    loading: false,
    diagnostics: { ghAvailable: true, requiredHostAuthenticated: true },
    accounts: { accounts: expect.any(Array) },
    configuration: { account: null },
    budget: { core: { limit: 5000 }, search: { limit: 30 }, graphql: { limit: 5000 } }
  })
  await host.call('setCreationDefaults', { scope: 'global', defaults: { draft: true, useTemplate: false, generateDetailsOnOpen: false, openAfterCreate: false } })
  await host.call('setCreationDefaults', { scope: 'repository', worktree: host.worktree, defaults: { draft: false, useTemplate: true, generateDetailsOnOpen: false, openAfterCreate: true } })

  expect(await host.call('creationDefaults', { scope: 'global' })).toMatchObject({ defaults: { draft: true, useTemplate: false, generateDetailsOnOpen: false, openAfterCreate: false } })
  expect(await host.call('creationDefaults', { scope: 'repository', worktree: host.worktree })).toMatchObject({
    defaults: { draft: false, useTemplate: true, generateDetailsOnOpen: false, openAfterCreate: true },
    scope: 'repository'
  })
  const scoped = record(await host.call('creationDefaults', { scope: 'repository', worktree: host.worktree }))
  if (typeof scoped.repoId !== 'string') throw new Error('repository defaults did not identify their repository')
  const persisted = await stateOf(host)
  expect(persisted.defaults).toMatchObject({ draft: true, useTemplate: false, generateDetailsOnOpen: false, openAfterCreate: false })
  expect(record(persisted.repoDefaults)[scoped.repoId]).toMatchObject({ draft: false, useTemplate: true, openAfterCreate: true })
  await host.call('createOpen', { worktree: host.worktree })
  expect(record((await stateOf(host)).creation).defaults).toMatchObject({ draft: false, useTemplate: true, openAfterCreate: true })
  await expect(host.call('hostingBindAccount', { worktree: host.worktree, host: 'github.com', user: 'withdrawn-account' })).rejects.toMatchObject({
    data: { reason: 'bound_account_unavailable' }
  })
  expect(await host.call('hostingConfiguration', { worktree: host.worktree })).toMatchObject({ account: null })
}, 20_000)

test('R18 generated CLI command drives create-open through the daemon API', async () => {
  const host = await boot()
  const result = await host.cli(['--json', 'reviews', 'create-open', '--worktree', host.worktree])
  expect(result).toMatchObject({ code: 0, stderr: '' })
  expect(JSON.parse(result.stdout)).toMatchObject({ worktree: host.worktree, opened: true })
  expect(record((await stateOf(host)).creation)).toMatchObject({ worktree: host.worktree, loading: false })
}, 20_000)
test('R13 remote bases and blank titles stay blocked through the public creation API', async () => {
  const host = await boot()
  git(host.repoPath, 'update-ref', 'refs/remotes/origin/feature', 'HEAD')
  await host.call('createOpen', { worktree: host.worktree })
  const creation = record((await stateOf(host)).creation)
  expect(creation.defaults).toMatchObject({ draft: false, useTemplate: false, generateDetailsOnOpen: false, openAfterCreate: false })

  const bases = record(await host.call('createBases', { worktree: host.worktree, query: 'feature' }))
  expect(bases.bases).toContain('feature')
  await expect(host.call('createBase', { worktree: host.worktree, base: 'feature' })).rejects.toMatchObject({ data: { reason: 'same_branch' } })
  await host.call('createDraft', { worktree: host.worktree, title: '   ' })
  await expect(host.call('createSubmit', { worktree: host.worktree })).rejects.toMatchObject({ data: { reason: 'title_required' } })
  expect(createCalls(host)).toHaveLength(0)
}, 20_000)

test('R14 generated details are invalidated when the same worktree moves to a new head', async () => {
  const agentBin = mkdtempSync(join(tmpdir(), 'quirky-reviews-agent-head-'))
  const agent = join(agentBin, 'claude')
  const previousPath = process.env.PATH
  const previousSearchDirs = process.env.QUIRKY_AGENT_SEARCH_DIRS
  let host: ReviewsHost | undefined
  try {
    writeFileSync(agent, `#!${process.execPath}\nconst args = process.argv.slice(2)\nif (args.includes('--version') || args.includes('--help')) { process.stdout.write('claude fixture\\n'); process.exit(0) }\nconst prompt = await new Response(Bun.stdin.stream()).text()\nif (!prompt.includes('GENERATION_MARKER')) process.exit(19)\nprocess.stdout.write(JSON.stringify({ title: 'Generated for old head', body: 'Old-head description' }))\n`)
    chmodSync(agent, 0o755)
    process.env.PATH = `${agentBin}${delimiter}${previousPath ?? ''}`
    process.env.QUIRKY_AGENT_SEARCH_DIRS = agentBin
    host = await boot()
    writeFileSync(join(host.repoPath, 'generation.txt'), 'GENERATION_MARKER\n')
    git(host.repoPath, 'add', 'generation.txt')
    git(host.repoPath, 'commit', '-m', 'Add generation marker')
    await host.call('createOpen', { worktree: host.worktree })
    await host.call('createGenerate', { worktree: host.worktree })
    expect(record((await stateOf(host)).creation).generated).toBe(true)

    writeFileSync(join(host.repoPath, 'next.txt'), 'new head\n')
    git(host.repoPath, 'add', 'next.txt')
    git(host.repoPath, 'commit', '-m', 'Advance generated branch')
    await host.call('createOpen', { worktree: host.worktree })
    expect(record((await stateOf(host)).creation).generated).toBe(false)
    expect(createCalls(host)).toHaveLength(0)
  } finally {
    await host?.cleanup()
    if (previousPath === undefined) delete process.env.PATH
    else process.env.PATH = previousPath
    if (previousSearchDirs === undefined) delete process.env.QUIRKY_AGENT_SEARCH_DIRS
    else process.env.QUIRKY_AGENT_SEARCH_DIRS = previousSearchDirs
    rmSync(agentBin, { recursive: true, force: true })
  }
}, 20_000)

test('R16 individual settings reads publish scoped snapshots and expose retained data on failure', async () => {
  const host = await boot()
  await host.call('hostingDiagnose', { worktree: host.worktree })
  await host.call('hostingAccounts', { worktree: host.worktree })
  await host.call('hostingConfiguration', { worktree: host.worktree })
  await host.call('hostingBudget', { worktree: host.worktree, force: true })
  const initial = record((await stateOf(host)).settings)
  expect(initial).toMatchObject({
    worktree: host.worktree,
    loading: false,
    error: null,
    diagnostics: { ghAvailable: true },
    accounts: { accounts: expect.any(Array) },
    configuration: { account: null },
    budget: { core: { limit: 5000 } }
  })

  host.writeState(createReviewsState({ rateLimitFailure: 'fixture rate-limit failure' }))
  await expect(host.call('hostingBudget', { worktree: host.worktree, force: true })).rejects.toMatchObject({
    data: { reason: 'upstream_error' }
  })
  const budgetFailure = record((await stateOf(host)).settings)
  expect(budgetFailure).toMatchObject({
    worktree: host.worktree,
    loading: false,
    error: expect.stringContaining('GitHub API budget'),
    budget: initial.budget
  })

  const partial = record(await host.call('hostingSettingsRefresh', { worktree: host.worktree, forceBudget: true }))
  expect(partial).toMatchObject({ refreshed: false, error: expect.stringContaining('GitHub API budget') })
  const partialSettings = record((await stateOf(host)).settings)
  expect(partialSettings).toMatchObject({
    loading: false,
    error: expect.stringContaining('GitHub API budget'),
    diagnostics: { ghAvailable: true },
    accounts: { accounts: expect.any(Array) },
    configuration: { account: null },
    budget: initial.budget
  })

  host.writeState(createReviewsState())
  await host.call('hostingSettingsRefresh', { worktree: host.worktree, forceBudget: true })
  await expect(host.call('hostingBindAccount', { worktree: host.worktree, host: 'github.com', user: 'withdrawn-account' })).rejects.toMatchObject({
    data: { reason: 'bound_account_unavailable' }
  })
  const accountFailure = record((await stateOf(host)).settings)
  expect(accountFailure).toMatchObject({
    loading: false,
    error: expect.stringContaining('Repository hosting configuration'),
    configuration: { account: null }
  })
  await host.call('hostingConfiguration', { worktree: host.worktree })
  expect(record((await stateOf(host)).settings)).toMatchObject({ loading: false, error: null, configuration: { account: null } })
}, 20_000)

test('R16 direct Settings view lists real worktrees and loads observations without settingsOpen or caller cwd', async () => {
  const host = await boot()
  const container = document.createElement('div')
  document.body.append(container)
  const layout = {
    view: { id: 'view:quirky.reviews/settings' },
    worktree: null,
    panel: null,
    sidebar: true,
    focus: null
  } as UiLayout
  const worktreeList = Promise.withResolvers<void>()
  const settingsLoaded = Promise.withResolvers<void>()
  const staleDataVisible = Promise.withResolvers<void>()
  const context = {
    call(method: string, params: Record<string, unknown> = {}) {
      const request = host.call(method, params)
      if (method === 'quirky.worktree/list') void request.then(() => worktreeList.resolve(), (error: unknown) => worktreeList.reject(error))
      return request
    },
    getLayout: () => layout
  } as unknown as UiPluginContext
  let state = await stateOf(host) as unknown as ReviewsState
  expect(record(state.settings)).toMatchObject({ worktree: null, loading: false })
  const root = createRoot(container)
  let render: () => void
  const refresh = async () => {
    state = await stateOf(host) as unknown as ReviewsState
    render()
    const settings = record(state.settings)
    if (settings.worktree === host.worktree && settings.loading === false) settingsLoaded.resolve()
    if (settings.worktree === host.worktree && settings.error !== null && settings.budget !== null) staleDataVisible.resolve()
  }
  render = () => root.render(React.createElement(HostingSettings, { context, state, refresh }))

  try {
    await React.act(async () => { render() })
    await React.act(async () => { await worktreeList.promise })
    const selector = container.querySelector<HTMLSelectElement>('#settings-worktree')
    if (!selector || ![...selector.options].some((option) => option.value === host.worktree)) {
      throw new Error('The Settings view did not list registered Git worktrees.')
    }
    expect(selector.value).toBe('')
    expect(container.querySelector('input[value="global"]')?.hasAttribute('disabled')).toBe(false)

    await React.act(async () => {
      selector.value = host.worktree
      selector.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await React.act(async () => { await settingsLoaded.promise })
    expect(record(state.settings)).toMatchObject({
      worktree: host.worktree,
      loading: false,
      diagnostics: { ghAvailable: true },
      accounts: { accounts: expect.any(Array) },
      configuration: { account: null }
    })
    expect(container.textContent).toContain('Connected')
    host.writeState(createReviewsState({ rateLimitFailure: 'fixture rate-limit failure' }))
    const budgetButton = [...container.querySelectorAll('button')].find((button) => button.textContent?.includes('Refresh budget'))
    if (!budgetButton) throw new Error('The Settings view did not render the budget refresh action.')
    await React.act(async () => {
      budgetButton.dispatchEvent(new Event('click', { bubbles: true }))
      await staleDataVisible.promise
    })
    expect(record(state.settings)).toMatchObject({
      loading: false,
      error: expect.stringContaining('GitHub API budget'),
      budget: expect.any(Object)
    })
    expect(container.textContent).toContain('Hosting observations may be stale')
    expect(container.textContent).toContain('REST')
  } finally {
    await React.act(async () => { root.unmount() })
    container.remove()
  }
}, 20_000)
test('R16 Settings view uses the selected workspace when the active view is global', async () => {
  const host = await boot()
  const container = document.createElement('div')
  document.body.append(container)
  const layout = {
    view: { id: 'view:quirky.reviews/settings' },
    worktree: host.worktree,
    panel: null,
    sidebar: true,
    focus: null
  } as UiLayout
  const calls: { method: string; params: Record<string, unknown> }[] = []
  const repositoryDefaults = Promise.withResolvers<void>()
  const context = {
    call(method: string, params: Record<string, unknown> = {}) {
      calls.push({ method, params })
      const request = host.call(method, params)
      if (method === 'quirky.reviews/creationDefaults' && params.scope === 'repository') {
        void request.then(() => repositoryDefaults.resolve(), repositoryDefaults.reject)
      }
      return request
    },
    getLayout: () => layout
  } as unknown as UiPluginContext
  const state = await stateOf(host) as unknown as ReviewsState
  const root = createRoot(container)
  try {
    await React.act(async () => {
      root.render(React.createElement(HostingSettings, { context, state, refresh: async () => {} }))
    })
    await React.act(async () => { await repositoryDefaults.promise })
    expect(calls).toContainEqual({
      method: 'quirky.reviews/creationDefaults',
      params: { scope: 'repository', worktree: host.worktree }
    })
  } finally {
    await React.act(async () => root.unmount())
    container.remove()
  }
}, 20_000)
