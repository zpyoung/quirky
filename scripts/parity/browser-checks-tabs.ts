import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { BrowserFailure } from './browser-world'
import type { BrowserCheck, CheckContext } from './browser-run'

type Tab = { browserPageId: string; profileId: string; worktreeId: string; index: number; title: string; url: string; active: boolean }
type Profiles = { profiles: Array<{ id: string; label: string; scope: string }> }
type PageReceipt = { browserPageId: string; profileId?: string }

async function location(c: CheckContext, title: string, path: string) {
  const observed = await c.observe<{ title: string; url: string }>('({title:document.title,url:location.href})')
  c.equal(observed, { title, url: `${c.world.fixture.origin}${path}` })
  c.assert(c.world.fixture.requests.some(request => request.path === path), `fixture did not receive ${path}`)
  return observed
}

export const tabChecks: BrowserCheck[] = [
  { id: 'tab-profile-create', async run(c) {
    const a = await c.call<{ profile: { id: string; label: string; scope: string } }>('tab profile create', { label: 'Parity A' }, '')
    const b = await c.call<{ profile: { id: string; label: string; scope: string } }>('tab profile create', { label: 'Parity B' }, '')
    c.state.profileA = a.profile.id; c.state.profileB = b.profile.id
    c.assert(a.profile.id !== b.profile.id, 'profiles must be independent')
    const profiles = (await c.call<Profiles>('tab profile list', {}, '')).profiles
    c.assert(profiles.some(p => p.id === a.profile.id && p.label === 'Parity A' && p.scope === 'isolated'), 'Parity A missing')
    c.assert(profiles.some(p => p.id === b.profile.id && p.label === 'Parity B' && p.scope === 'isolated'), 'Parity B missing')
    return { profiles }
  } },
  { id: 'tab-create', async run(c) {
    c.state.pageA = (await c.call<PageReceipt>('tab create', { profile: c.state.profileA, worktree: c.world.worktreeA, url: `${c.world.fixture.origin}/page` }, '')).browserPageId
    c.state.pageB = (await c.call<PageReceipt>('tab create', { profile: c.state.profileB, worktree: c.world.worktreeB, url: `${c.world.fixture.origin}/page` }, '')).browserPageId
    const tabs = (await c.call<{ tabs: Tab[] }>('tab list', { worktree: 'all' }, '')).tabs
    for (const [page, profile, worktree] of [[c.state.pageA, c.state.profileA, c.world.worktreeA], [c.state.pageB, c.state.profileB, c.world.worktreeB]]) {
      const tab = tabs.find(tab => tab.browserPageId === page)
      c.assert(tab?.profileId === profile && tab.worktreeId === worktree && tab.title === 'Parity fixture', 'created page ownership or title mismatch')
    }
    return { tabs }
  } },
  { id: 'tab-list', async run(c) {
    const a = (await c.call<{ tabs: Tab[] }>('tab list', { worktree: c.world.worktreeA }, '')).tabs
    const b = (await c.call<{ tabs: Tab[] }>('tab list', { worktree: c.world.worktreeB }, '')).tabs
    c.equal(a.map(tab => tab.browserPageId), [c.state.pageA]); c.equal(b.map(tab => tab.browserPageId), [c.state.pageB])
    return { a, b }
  } },
  { id: 'tab-show', async run(c) {
    const { tab } = await c.call<{ tab: Tab }>('tab show')
    c.equal(tab.browserPageId, c.state.pageA); c.equal(tab.profileId, c.state.profileA); c.equal(tab.worktreeId, c.world.worktreeA)
    return { tab, page: await location(c, 'Parity fixture', '/page') }
  } },
  { id: 'tab-current', async run(c) {
    const { tab } = await c.call<{ tab: Tab }>('tab current', { worktree: c.world.worktreeA }, '')
    c.equal(tab.browserPageId, c.state.pageA)
    return { tab, shown: await c.call('tab show') }
  } },
  { id: 'tab-switch', async run(c) {
    const disposable = (await c.call<PageReceipt>('tab create', { profile: c.state.profileA, worktree: c.world.worktreeA, url: `${c.world.fixture.origin}/page` }, '')).browserPageId
    c.state.disposable = disposable
    await c.call('tab switch', {}, c.state.pageA)
    c.equal((await c.call<{ tab: Tab }>('tab current', { worktree: c.world.worktreeA }, '')).tab.browserPageId, c.state.pageA)
    const tabs = (await c.call<{ tabs: Tab[] }>('tab list', { worktree: c.world.worktreeA }, '')).tabs
    const target = tabs.find(tab => tab.browserPageId === disposable)
    c.assert(target, 'disposable page absent')
    await c.call('tab switch', { index: target!.index, worktree: c.world.worktreeA }, '')
    c.equal((await c.call<{ tab: Tab }>('tab current', { worktree: c.world.worktreeA }, '')).tab.browserPageId, disposable)
    await c.call('tab switch', {}, c.state.pageA)
    return { selectedByPage: c.state.pageA, selectedByReturnedIndex: target!.index, disposable }
  } },
  { id: 'tab-switch-focus', async run(c) {
    const reply = await c.probe('tab switch', { focus: true })
    if (reply.exitCode === 0) throw new BrowserFailure('wrong-page', 'headless tool has no executing visible-focus observer')
    c.assert(JSON.stringify(reply.result).includes('Visible pane focus belongs to browser UI; automation is headless.'), 'unexpected focus refusal')
    const current = await c.call<{ tab: Tab }>('tab current', { worktree: c.world.worktreeA }, '')
    c.equal(current.tab.browserPageId, c.state.pageA)
    return { gap: 'Reveal the selected browser page and route browser URLs to the intended client', refusal: reply.result, selected: current.tab.browserPageId }
  } },
  { id: 'tab-close', async run(c) {
    const disposable = c.state.disposable
    if (typeof disposable !== 'string') throw new BrowserFailure('wrong-page', 'disposable page was not created')
    await c.call('tab close', { yes: true }, disposable)
    const tabs = (await c.call<{ tabs: Tab[] }>('tab list', { worktree: 'all' }, '')).tabs
    c.assert(!tabs.some(tab => tab.browserPageId === disposable), 'closed page remains listed')
    const show = await c.probe('tab show', {}, disposable)
    c.assert(show.exitCode !== 0, 'closed page remains addressable')
    return { removedId: disposable, tabs, show: show.result }
  } },
  { id: 'tab-profile-list', async run(c) {
    const { profiles } = await c.call<Profiles>('tab profile list', {}, '')
    c.assert(profiles.some(p => p.id === c.state.profileA) && profiles.some(p => p.id === c.state.profileB), 'created profiles missing')
    return { profiles, a: await c.call('tab profile show') }
  } },
  { id: 'tab-profile-show', async run(c) {
    const profile = await c.call<{ browserPageId: string; profileId: string; worktreeId: string }>('tab profile show')
    c.equal(profile, { ...profile, browserPageId: c.state.pageA, profileId: c.state.profileA, worktreeId: c.world.worktreeA })
    return { profile, tab: await c.call('tab show') }
  } },
  { id: 'tab-profile-set', async run(c) {
    const disposable = (await c.call<PageReceipt>('tab create', { profile: c.state.profileA, url: `${c.world.fixture.origin}/page`, worktree: c.world.worktreeA }, '')).browserPageId
    c.state.disposable = disposable
    const moved = await c.call<PageReceipt>('tab profile set-page', { profile: c.state.profileB }, disposable)
    c.equal(moved.browserPageId, disposable); c.equal(moved.profileId, c.state.profileB)
    const { tab } = await c.call<{ tab: Tab }>('tab show', {}, disposable)
    c.equal(tab.profileId, c.state.profileB)
    c.equal((await c.call<{ tab: Tab }>('tab show')).tab.profileId, c.state.profileA)
    return { moved, tab }
  } },
  { id: 'tab-profile-use-default', async run(c) {
    const disposable = c.state.disposable
    if (typeof disposable !== 'string') throw new BrowserFailure('wrong-page', 'disposable page was not created')
    const moved = await c.call<PageReceipt>('tab profile use-default', {}, disposable)
    c.equal(moved.browserPageId, disposable); c.equal(moved.profileId, 'default')
    const shown = await c.call<{ profileId: string }>('tab profile show', {}, disposable)
    c.equal(shown.profileId, 'default')
    await c.call('tab close', { yes: true }, disposable)
    return { moved, shown }
  } },
  { id: 'tab-profile-clone', async run(c) {
    const destination = await c.call<{ profile: { id: string } }>('tab profile create', { label: 'Clone destination' }, '')
    await c.call('cookie set', { name: 'clone-proof', value: 'copied', url: c.world.fixture.origin, path: '/' })
    const copy = await c.call<PageReceipt>('tab profile clone', { profile: destination.profile.id })
    c.assert(copy.browserPageId !== c.state.pageA, 'clone reused source page')
    c.equal(copy.profileId, destination.profile.id)
    const cookies = await c.call<{ cookies: Array<{ name: string; value: string }> }>('cookie get', {}, copy.browserPageId)
    c.assert(cookies.cookies.some(cookie => cookie.name === 'clone-proof' && cookie.value === 'copied'), 'clone cookie lost')
    await c.call('tab close', { yes: true }, copy.browserPageId)
    return { copy, cookies }
  } },
  { id: 'tab-profile-delete', async run(c) {
    const { profile } = await c.call<{ profile: { id: string } }>('tab profile create', { label: 'Delete proof' }, '')
    const page = (await c.call<PageReceipt>('tab create', { profile: profile.id, worktree: c.world.worktreeA, url: `${c.world.fixture.origin}/page` }, '')).browserPageId
    await c.call('cookie set', { name: 'delete-proof', value: 'preserved', url: c.world.fixture.origin, path: '/', expires: Math.floor(c.world.fixture.startedAt / 1000) + 86400 }, page)
    const walk = (root: string): string | undefined => {
      for (const entry of readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.isSymbolicLink()) continue
        const path = join(root, entry.name)
        if (entry.name === profile.id && existsSync(join(path, 'chrome-profile'))) return join(path, 'chrome-profile')
        const found = walk(path)
        if (found) return found
      }
      return undefined
    }
    const chrome = walk(c.world.home)
    c.assert(chrome, 'owned Chrome profile directory not found')
    await c.call('tab close', { yes: true }, page)
    const deleted = await c.probe('tab profile delete', { profile: profile.id, yes: true }, '')
    const profiles = (await c.call<Profiles>('tab profile list', {}, '')).profiles
    if (deleted.exitCode === 0) {
      c.assert(!profiles.some(p => p.id === profile.id) && !existsSync(chrome!), 'delete receipt without data erasure')
      return { deleted: true, metadataRemoved: true, chromeRemoved: true }
    }
    const error = JSON.stringify(deleted.result)
    c.assert(error.includes('conflict') && error.includes('no Quirky window is open'), 'unexpected profile-delete refusal')
    c.assert(profiles.some(p => p.id === profile.id) && existsSync(chrome!), 'refused deletion changed profile metadata/data')
    const reopened = (await c.call<PageReceipt>('tab create', { profile: profile.id, worktree: c.world.worktreeA, url: `${c.world.fixture.origin}/page` }, '')).browserPageId
    const cookies = await c.call<{ cookies: Array<{ name: string; value: string }> }>('cookie get', {}, reopened)
    c.assert(cookies.cookies.some(cookie => cookie.name === 'delete-proof' && cookie.value === 'preserved'), 'lost-cookie after refused deletion')
    await c.call('tab close', { yes: true }, reopened)
    return { gap: 'Headless agents cannot delete profiles: Native storage clearance requires a live desktop acknowledgement; no Quirky window is open', refusal: deleted.result, metadataPreserved: true, chromeDirectoryPreserved: true, cookies }
  } },
  { id: 'goto', async run(c) {
    const navigated = await c.call('goto', { url: `${c.world.fixture.origin}/second` })
    return { navigated, observed: await location(c, 'Second', '/second') }
  } },
  { id: 'back', async run(c) {
    const navigated = await c.call('back')
    return { navigated, observed: await location(c, 'Parity fixture', '/page') }
  } },
  { id: 'forward', async run(c) {
    const navigated = await c.call('forward')
    return { navigated, observed: await location(c, 'Second', '/second') }
  } },
  { id: 'reload', async run(c) {
    const before = c.world.fixture.requests.filter(request => request.path === '/second').length
    const navigated = await c.call('reload')
    c.assert(c.world.fixture.requests.filter(request => request.path === '/second').length > before, 'reload did not request page')
    const observed = await location(c, 'Second', '/second')
    await c.call('goto', { url: `${c.world.fixture.origin}/page` })
    return { navigated, observed }
  } },
  { id: 'open-url', async run(c) {
    const opened = await c.call<PageReceipt>('open-url', { url: `${c.world.fixture.origin}/page`, worktree: c.world.worktreeA }, '')
    const { tab } = await c.call<{ tab: Tab }>('tab show', {}, opened.browserPageId)
    c.equal(tab.profileId, 'default'); c.equal(tab.worktreeId, c.world.worktreeA)
    const title = await c.observe('document.title', opened.browserPageId)
    c.equal(title, 'Parity fixture')
    await c.call('tab close', { yes: true }, opened.browserPageId)
    return { gap: 'Reveal the selected browser page and route browser URLs to the intended client', tab, title, scope: 'local managed Default-profile page; no paired-client routing observer' }
  } }
]
