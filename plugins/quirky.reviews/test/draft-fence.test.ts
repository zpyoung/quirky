import { expect, test } from 'bun:test'
import type { Worktree } from '@quirky/protocol'
import { createReviewsEnv, newChecksEntry } from '../src/env'
import { checksMethods, checksSpecs } from '../src/checks/methods'
import { createMethods, createSpecs } from '../src/create/methods'
import { detailMethods, detailSpecs } from '../src/detail/methods'
import type { ReviewData, ReviewsEnv } from '../src/contracts'

type RepoIdentity = { host: string; owner: string; repo: string }

function unitEnv() {
  const env = createReviewsEnv({
    openStore: () => ({ get: () => undefined, run: () => {} }),
    emit: () => {},
    error: (reason: string, message: string) => Object.assign(new Error(message), { data: { reason } })
  } as never)
  return env
}

function review(prRepo: RepoIdentity, number = 12): ReviewData {
  return {
    provider: 'github', number,
    url: `https://${prRepo.host}/${prRepo.owner}/${prRepo.repo}/pull/${number}`,
    title: 'Review title', body: '', state: 'open', headRefName: 'feature', baseRefName: 'main',
    headRefOid: 'head', baseRefOid: 'base', mergeable: 'MERGEABLE', checksStatus: 'SUCCESS',
    reviewDecision: '', mergeStateStatus: 'CLEAN', autoMergeRequest: null, stack: null, mergeMethods: null,
    prRepo
  }
}

const oldRepo = { host: 'github.com', owner: 'o', repo: 'r' }
const nextRepo = { host: 'github.com', owner: 'o2', repo: 'r' }
const checksWorktree = { id: 'wt', repoId: 'repo', path: '/repo', kind: 'git', branch: 'feature', head: 'head' } as Worktree

function setChecksTarget(env: ReviewsEnv, generation: number, prRepo: RepoIdentity, titleDraft: string | null): void {
  env.update((state) => {
    const entry = newChecksEntry('wt', generation)
    entry.review = review(prRepo)
    entry.titleDraft = titleDraft
    state.checksByWorktree.wt = entry
  })
}

function holdResolve(env: ReviewsEnv): ((worktree: Worktree) => void)[] {
  const resolvers: ((worktree: Worktree) => void)[] = []
  env.resolve = () => {
    const { promise, resolve } = Promise.withResolvers<Worktree>()
    resolvers.push(resolve)
    return promise
  }
  return resolvers
}

function schema(specs: { id: string; params: unknown }[], id: string): { properties: Record<string, unknown>; required: string[] } {
  const params = specs.find((spec) => spec.id === id)?.params as { properties: Record<string, unknown>; required: string[] } | undefined
  if (!params) throw new Error(`Missing method schema: ${id}`)
  return params
}

test('fenced method schemas expose optional target parameters', () => {
  for (const id of ['checksSetTitleDraft', 'checksCancelTitle']) {
    const params = schema(checksSpecs, id)
    expect(params.properties.prRepo).toBeDefined()
    expect(params.properties.generation).toEqual({ type: 'integer', minimum: 0 })
    expect(params.required).not.toContain('prRepo')
    expect(params.required).not.toContain('generation')
  }

  for (const id of ['createDraft', 'createBase']) {
    const params = schema(createSpecs, id)
    expect(params.properties.generation).toEqual({ type: 'integer', minimum: 0 })
    expect(params.required).not.toContain('generation')
  }

  const filesView = schema(detailSpecs, 'detailSetFilesView')
  expect(filesView.properties.generation).toEqual({ type: 'integer', minimum: 0 })
  expect(filesView.required).not.toContain('generation')
})

test('old title writes cannot overwrite a repository relink or an ABA return', async () => {
  const env = unitEnv()
  setChecksTarget(env, 1, oldRepo, null)
  const resolvers = holdResolve(env)
  const methods = checksMethods(env)
  const oldWrite = methods.checksSetTitleDraft({
    worktree: 'wt', number: 12, title: 'old', prRepo: oldRepo, generation: 1
  } as never, {} as never)

  setChecksTarget(env, 2, nextRepo, null)
  env.resolve = async () => checksWorktree
  await methods.checksSetTitleDraft({
    worktree: 'wt', number: 12, title: 'new', prRepo: nextRepo, generation: 2
  } as never, {} as never)
  expect(env.read().checksByWorktree.wt?.titleDraft).toBe('new')

  setChecksTarget(env, 3, oldRepo, 'generation three')
  resolvers[0]!(checksWorktree)
  await expect(oldWrite).rejects.toMatchObject({ data: { reason: 'stale_review_target' } })
  expect(env.read().checksByWorktree.wt?.titleDraft).toBe('generation three')
})
test('a title write held before relinking rejects while the new repository draft survives', async () => {
  const env = unitEnv()
  setChecksTarget(env, 1, oldRepo, null)
  const resolvers = holdResolve(env)
  const methods = checksMethods(env)
  const oldWrite = methods.checksSetTitleDraft({
    worktree: 'wt', number: 12, title: 'old', prRepo: oldRepo, generation: 1
  } as never, {} as never)

  setChecksTarget(env, 2, nextRepo, null)
  env.resolve = async () => checksWorktree
  await methods.checksSetTitleDraft({
    worktree: 'wt', number: 12, title: 'new', prRepo: nextRepo, generation: 2
  } as never, {} as never)
  resolvers[0]!(checksWorktree)
  await expect(oldWrite).rejects.toMatchObject({ data: { reason: 'stale_review_target' } })
  expect(env.read().checksByWorktree.wt?.titleDraft).toBe('new')
})

test('repository-only title write rejects a relinked same-number review', async () => {
  const env = unitEnv()
  setChecksTarget(env, 1, oldRepo, null)
  const resolvers = holdResolve(env)
  const methods = checksMethods(env)
  const oldWrite = methods.checksSetTitleDraft({
    worktree: 'wt', number: 12, title: 'old', prRepo: oldRepo
  } as never, {} as never)

  setChecksTarget(env, 2, nextRepo, 'keep')
  resolvers[0]!(checksWorktree)
  await expect(oldWrite).rejects.toMatchObject({ data: { reason: 'stale_review_target' } })
  expect(env.read().checksByWorktree.wt?.titleDraft).toBe('keep')
})

test('old title cancellation cannot clear the newer generation draft', async () => {
  const env = unitEnv()
  setChecksTarget(env, 1, oldRepo, null)
  const resolvers = holdResolve(env)
  const methods = checksMethods(env)
  const oldCancel = methods.checksCancelTitle({ worktree: 'wt', number: 12, generation: 1 } as never, {} as never)

  setChecksTarget(env, 2, oldRepo, 'keep')
  resolvers[0]!(checksWorktree)
  await expect(oldCancel).rejects.toMatchObject({ data: { reason: 'stale_review_target' } })
  expect(env.read().checksByWorktree.wt?.titleDraft).toBe('keep')
})

test('title draft callers without fences keep the existing behavior', async () => {
  const env = unitEnv()
  setChecksTarget(env, 1, oldRepo, null)
  env.resolve = async () => checksWorktree
  const result = await checksMethods(env).checksSetTitleDraft({ worktree: 'wt', number: 12, title: 'legacy' } as never, {} as never)

  expect(result).toEqual({ titleDraft: 'legacy' })
  expect(env.read().checksByWorktree.wt?.titleDraft).toBe('legacy')
})

const createWorktree = { id: '/a', repoId: 'repo', path: '/a', kind: 'git', branch: 'feature', head: 'head' } as Worktree

function setCreation(env: ReviewsEnv, worktree: string, generation: number, title: string, base = 'main'): void {
  env.update((state) => {
    state.creation.worktree = worktree
    state.creation.generation = generation
    state.creation.head = 'feature'
    state.creation.eligibility = { headOid: 'head' }
    state.creation.bases = ['main', 'release']
    state.creation.title = title
    state.creation.base = base
    state.creation.submitting = false
    state.creation.generating = false
  })
}

function installCreateCalls(env: ReviewsEnv): void {
  env.call = async (method) => {
    if (method === 'quirky.hosting/creationEligibility') {
      return { eligible: true, defaultBase: 'main', head: 'feature', title: 'Review title', body: '', blockers: [] }
    }
    if (method === 'quirky.hosting/repository') return { origin: { host: 'gitlab.com' } }
    throw new Error(`Unexpected call: ${method}`)
  }
}

test('create writes reject stale generations, including a reopened worktree, while legacy calls still work', async () => {
  const env = unitEnv()
  setCreation(env, '/a', 1, 'before')
  const resolvers = holdResolve(env)
  const methods = createMethods(env)
  const oldDraft = methods.createDraft({ worktree: '/a', title: 'old', generation: 1 } as never, {} as never)

  setCreation(env, '/b', 2, 'worktree b')
  setCreation(env, '/a', 3, 'current')
  env.resolve = async () => createWorktree
  await methods.createDraft({ worktree: '/a', title: 'new', generation: 3 } as never, {} as never)
  expect(env.read().creation.title).toBe('new')

  resolvers[0]!(createWorktree)
  await expect(oldDraft).rejects.toMatchObject({ data: { reason: 'stale_target' } })
  expect(env.read().creation.title).toBe('new')

  setCreation(env, '/a', 1, 'before base', 'release')
  const baseResolvers = holdResolve(env)
  const oldBase = methods.createBase({ worktree: '/a', base: 'main', generation: 1 } as never, {} as never)
  setCreation(env, '/b', 2, 'worktree b', 'release')
  setCreation(env, '/a', 3, 'reopened', 'release')
  baseResolvers[0]!(createWorktree)
  await expect(oldBase).rejects.toMatchObject({ data: { reason: 'stale_target' } })
  expect(env.read().creation.base).toBe('release')

  installCreateCalls(env)
  env.resolve = async () => createWorktree
  await methods.createDraft({ worktree: '/a', title: 'legacy' } as never, {} as never)
  await methods.createBase({ worktree: '/a', base: 'main' } as never, {} as never)
  expect(env.read().creation.title).toBe('legacy')
  expect(env.read().creation.base).toBe('main')
})

test('files view rejects a stale generation and remains compatible without one', async () => {
  const env = unitEnv()
  env.update((state) => {
    state.detail.target = { worktree: 'wt', number: 12, prRepo: oldRepo }
    state.detail.generation = 5
    state.detail.fileFilter = 'old-filter'
    state.detail.diffMode = 'side-by-side'
    state.detail.selectedFile = 'src/old.ts'
    state.detail.collapsedFiles = ['src/old.ts']
    state.detail.fileTreeVisible = false
  })
  const methods = detailMethods(env)
  const view = {
    worktree: 'wt', number: 12, fileFilter: 'new-filter', diffMode: 'inline', selectedFile: null,
    collapsedFiles: [], treeVisible: true
  }

  await expect(methods.detailSetFilesView({ ...view, generation: 4 } as never, {} as never))
    .rejects.toMatchObject({ data: { reason: 'stale_target' } })
  expect(env.read().detail).toMatchObject({
    fileFilter: 'old-filter', diffMode: 'side-by-side', selectedFile: 'src/old.ts',
    collapsedFiles: ['src/old.ts'], fileTreeVisible: false
  })

  await methods.detailSetFilesView(view as never, {} as never)
  expect(env.read().detail).toMatchObject({
    fileFilter: 'new-filter', diffMode: 'inline', selectedFile: null,
    collapsedFiles: [], fileTreeVisible: true
  })
})
