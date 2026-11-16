import { afterAll, afterEach, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { registerDom } from './register-dom'
import type { Fake } from './panel-support'

registerDom()
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
// React DOM and the activated plugin must load after the test window is installed.
const { act, byLabel, buttonText, click, compareOf, entry, failure, fakeContext, layoutFor, mountPanel, q, qa, rowOf, settle, statusOf, type } = await import('./panel-support')
const mounted: Array<() => void> = []
afterEach(() => { for (const unmount of mounted.splice(0)) unmount() })
afterAll(() => GlobalRegistrator.unregister())
async function open(configure: (fake: Fake) => void = () => {}) {
  const fake = fakeContext(layoutFor('feat'))
  fake.status = statusOf([entry('a.ts')])
  configure(fake)
  const panel = mountPanel(fake)
  mounted.push(panel.unmount)
  await settle()
  return { fake, element: panel.element }
}
const linked = (fake: Fake) => fake.on('quirky.hosting/forBranch', () => ({
  kind: 'found', review: { number: 7, state: 'open', url: 'https://github.com/zoe/repo/pull/7' }
}))

test('unresolved initial reads use a shared loading notice and live region, not an empty state', async () => {
  const pending = Promise.withResolvers<never>()
  const { element } = await open((fake) => {
    fake.on('quirky.git/status', () => pending.promise)
    fake.on('quirky.git/review', () => pending.promise)
  })
  expect(q(element, '[role="status"] .ui-notice-line')?.textContent).toBe('Loading…')
  expect(qa(element, '.ui-empty-state').some((node) => node.textContent?.includes('Loading'))).toBe(false)
})

for (const method of ['status', 'review', 'compare']) {
  test(`${method} transport errors show shared Retry without disguising that read as loading`, async () => {
    const { element, fake } = await open((f) => f.on(`quirky.git/${method}`, () => { throw failure('fixture read failed') }))
    const alert = qa(element, '.ui-inline-error').find((node) => node.textContent?.includes('fixture read failed'))
    expect(alert).toBeDefined()
    const before = fake.called(`quirky.git/${method}`).length
    await click(buttonText(alert!, 'Retry'))
    expect(fake.called(`quirky.git/${method}`)).toHaveLength(before + 1)
    expect(fake.called(`quirky.git/${method}`).at(-1)?.params).toEqual({ worktree: 'feat' })
    if (method !== 'compare') expect(q(element, '.ui-notice-line')?.textContent).not.toBe('Loading…')
  })
}

for (const method of ['status', 'review', 'compare']) {
  test(`${method} refresh failure keeps the last successful rows and shows its error`, async () => {
    const { element, fake } = await open()
    fake.on(`quirky.git/${method}`, () => { throw failure('fixture read failed') })
    await act(async () => fake.emit({ type: 'quirky.git/changed', data: { worktreeId: 'feat' } }))
    if (method === 'compare') {
      await click(byLabel(element, 'More source control actions'))
      await click(buttonText(document.body, 'Refresh'))
    }
    await settle()
    expect(rowOf(element, 'a.ts')).not.toBeNull()
    expect(qa(element, '.ui-inline-error').some((node) => node.textContent?.includes('fixture read failed'))).toBe(true)
  })
}

for (const [query, oversized] of [['x'.repeat(2048), false], ['x'.repeat(2049), true], ['é'.repeat(1024), false], ['é'.repeat(1025), true], [' '.repeat(2048) + 'x', true], ['missing', false]] as const) {
  test(`filter checks UTF-8 bytes before trimming (${new TextEncoder().encode(query).length} bytes, oversized=${oversized})`, async () => {
    const { element } = await open()
    await click(byLabel(element, 'Filter files by name'))
    await type(byLabel(element, 'Filter files…') as HTMLInputElement, query)
    expect(rowOf(element, 'a.ts')).toBeNull()
    if (oversized) {
      expect(q(element, '.ui-inline-error__message')?.textContent).toBe('Search text is too large')
      expect(element.textContent).toContain('Use a shorter file filter.')
    } else expect(q(element, '.ui-empty-state__message')?.textContent).toBe('No files match the filter.')
  })
}

for (const hasUpstream of [true, false]) {
  test(`clean shared empty state preserves tracking sentence (upstream=${hasUpstream})`, async () => {
    const { element } = await open((fake) => {
      fake.status = statusOf([], hasUpstream ? {} : { upstream: null, upstreamStatus: { hasUpstream: false, name: null, sha: null, ahead: 0, behind: 0, behindPatchEquivalent: null } })
    })
    expect(q(element, '[data-git-clean][role="status"] .ui-empty-state__message')?.textContent).toBe(`Nothing changed against origin/main${hasUpstream ? ' · up to date with origin/zoe/feat' : ''}`)
  })
}

test('folder workspace remains a non-alert availability state with Retry and cleared badge', async () => {
  const { element, fake } = await open((f) => f.on('quirky.git/status', () => { throw failure('This workspace is a folder.', { reason: 'folder-workspace' }) }))
  expect(q(element, '.ui-empty-state__message')?.textContent).toBe('This workspace is a folder.')
  expect(q(element, '[role="alert"]')).toBeNull()
  expect(fake.badges.at(-1)?.[1]).toBeNull()
  expect(buttonText(element, 'Retry')).toBeDefined()
})

test('successful non-ready compare uses a shared error with its base and Retry choices', async () => {
  const { element } = await open((fake) => { fake.compare = compareOf({ status: 'invalid-base', message: 'Choose a base.', base: null }) })
  const messages = qa(element, '[role="status"] .ui-inline-error__message')
  expect(messages).toHaveLength(1)
  expect(messages[0]?.textContent).toBe('Choose a base.')
  expect(buttonText(element, 'Change base ref')).toBeDefined()
  expect(buttonText(element, 'Retry')).toBeDefined()
})

test('linked push destination pending state uses a shared notice in its status wrapper', async () => {
  const pending = Promise.withResolvers<never>()
  const { element } = await open((fake) => { linked(fake); fake.on('quirky.git/pushTarget', () => pending.promise) })
  expect(q(element, '[data-git-push-target][role="status"] .ui-notice-line')?.textContent).toBe('Checking the configured push destination for this pull request…')
})

for (const invalid of [false, true]) {
  test(`push destination ${invalid ? 'invalid reply' : 'rejection'} is an InlineError and Retry rereads the current PR key`, async () => {
    const { element, fake } = await open((f) => { linked(f); f.on('quirky.git/pushTarget', () => { if (invalid) return {}; throw failure('fixture read failed') }) })
    expect(q(element, '[data-git-push-target] .ui-inline-error__message')?.textContent).toBe(invalid ? 'Git returned an invalid push destination.' : 'fixture read failed')
    const before = fake.called('quirky.git/pushTarget').length
    await click(buttonText(q(element, '[data-git-push-target]')!, 'Retry'))
    expect(fake.called('quirky.git/pushTarget')).toHaveLength(before + 1)
    expect(fake.called('quirky.git/pushTarget').at(-1)?.params).toEqual({ worktree: 'feat', purpose: 'review' })
  })
}

test('valid unavailable push destination is advisory, while a fork shows its exact identity', async () => {
  const { element, fake } = await open((f) => { linked(f); f.on('quirky.git/pushTarget', () => ({ ready: false, reason: 'no-push-remote', message: 'No push remote is configured.' })) })
  expect(q(element, '[data-git-push-target]')?.textContent).toBe('No push remote is configured.')
  expect(q(element, '[data-git-push-target][role="alert"]')).toBeNull()
  expect(q(element, '[data-git-push-target] .ui-inline-error')).toBeNull()
  fake.on('quirky.git/pushTarget', () => ({ ready: true, remote: 'fork', branch: 'zoe/feat', localBranch: 'zoe/feat', localHead: 'a'.repeat(40), fork: true, repository: { host: 'github.com', owner: 'zoe', repo: 'repo' } }))
  await act(async () => { fake.status = { ...fake.status, head: 'd'.repeat(40) }; fake.emit({ type: 'quirky.git/changed', data: { worktreeId: 'feat' } }) })
  await settle()
  expect(q(element, '[data-git-push-target]')?.textContent).toContain('fork/zoe/feat')
  expect(q(element, '[data-git-push-target]')?.textContent).toContain('github.com/zoe/repo')
})
