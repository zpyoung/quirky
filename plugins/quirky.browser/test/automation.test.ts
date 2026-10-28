import { existsSync, realpathSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, relative, sep } from 'node:path'
import { expect, test } from 'bun:test'
import { run } from '../../../packages/cli/src/main'
import { createDaemonLink } from '../../../packages/cli/src/link'
import { startBrowserHarness, type BrowserTestHarness } from './harness'

const call = (client: BrowserTestHarness['client'], name: string, params: Record<string, unknown> = {}) =>
  client.callAny(`quirky.browser/${name}`, params)

async function newPage(h: BrowserTestHarness, url = `${h.fixtureUrl}events`, profile?: string) {
  return await call(h.client, 'tabCreate', { url, ...(profile ? { profile } : {}) }) as { browserPageId: string }
}

async function runBrowserCli(h: BrowserTestHarness, argv: string[]) {
  let stdout = ''
  let stderr = ''
  const client = await h.daemon.connect('cli')
  const code = await run({
    argv,
    env: { QUIRKY_HOME: h.home },
    cwd: h.home,
    writer: { stdout: (text) => { stdout += text }, stderr: (text) => { stderr += text } },
    link: createDaemonLink(async () => client, { yes: argv.includes('--yes') }),
    openDesktopApp: async () => ({ ok: false, reason: 'not used' })
  })
  return { code, stdout, stderr }
}

type Outcome<T> = { status: 'fulfilled'; value: T } | { status: 'rejected'; reason: unknown }
function settle<T>(promise: Promise<T>): Promise<Outcome<T>> {
  return promise.then(
    (value) => ({ status: 'fulfilled', value }),
    (reason: unknown) => ({ status: 'rejected', reason })
  )
}

async function signalBefore(signal: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  const timeout = Promise.withResolvers<boolean>()
  const timer = setTimeout(() => timeout.resolve(false), timeoutMs)
  try { return await Promise.race([signal.then(() => true), timeout.promise]) }
  finally { clearTimeout(timer) }
}

test('C1: profile metadata is lazy and each isolated profile owns one Chrome/helper pair', async () => {
  const h = await startBrowserHarness()
  try {
    const profilesBeforeUse = await call(h.client, 'profileList') as { profiles: Array<{ id: string; scope: string }> }
    expect(profilesBeforeUse.profiles).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'default', scope: 'default' })]))
    expect(h.spawnCount()).toBe(0)

    const isolated = await call(h.client, 'profileCreate', { name: 'Review' }) as { profile: { id: string; scope: string } }
    expect(isolated.profile.scope).toBe('isolated')
    expect(h.spawnCount()).toBe(0)

    const [first, second] = await Promise.all([
      newPage(h, `${h.fixtureUrl}events`, isolated.profile.id),
      newPage(h, `${h.fixtureUrl}events`, isolated.profile.id)
    ])
    expect(first.browserPageId).not.toBe(second.browserPageId)
    expect(h.spawnCount()).toBe(2)
    const anotherPage = await newPage(h, `${h.fixtureUrl}first`, isolated.profile.id)
    expect(anotherPage.browserPageId).not.toBe(first.browserPageId)
    expect(h.spawnCount()).toBe(2)

    const defaultPage = await newPage(h)
    expect(defaultPage.browserPageId).toBeTruthy()
    expect(h.spawnCount()).toBe(4)
    const commands = h.spawnCommands()
    expect(commands.filter((command) => command.length === 1)).toHaveLength(2)
    const chrome = commands.filter((command) => command.includes('--headless=new'))
    expect(chrome).toHaveLength(2)
    const dataDir = join(h.home, 'plugin-data', 'quirky.browser', 'profiles')
    const ownedDirectories = chrome.map((command) => {
      const argument = command.find((arg) => arg.startsWith('--user-data-dir='))
      if (!argument) throw new Error('Owned Chrome has no profile directory')
      return realpathSync(argument.slice('--user-data-dir='.length))
    })
    expect(new Set(ownedDirectories).size).toBe(2)
    for (const directory of ownedDirectories) {
      const ownedPath = relative(realpathSync(h.home), directory)
      expect(ownedPath !== '..' && !ownedPath.startsWith(`..${sep}`) && !isAbsolute(ownedPath)).toBe(true)
    }
    expect(existsSync(join(dataDir, isolated.profile.id, 'chrome-profile'))).toBe(true)
  } finally { await h.cleanup() }
}, 90_000)

test('C2: API and CLI create, inspect, select, list, and close pages in explicit worktree scope', async () => {
  const h = await startBrowserHarness()
  try {
    const worktree = await h.addFolderWorktree('BrowserCore')
    const createdProfile = await runBrowserCli(h, ['browser', 'tab', 'profile', 'create', '--label', 'CLI Review', '--json'])
    expect(createdProfile.code).toBe(0)
    const profile = JSON.parse(createdProfile.stdout) as { profile: { id: string; scope: string } }
    expect(profile.profile.scope).toBe('isolated')

    const createPage = async (url: string) => {
      const result = await runBrowserCli(h, ['browser', 'tab', 'create', '--url', url, '--worktree', worktree, '--profile', profile.profile.id, '--json'])
      expect(result.code).toBe(0)
      return JSON.parse(result.stdout) as { browserPageId: string }
    }
    const first = await createPage(`${h.fixtureUrl}events`)
    const second = await createPage(`${h.fixtureUrl}first`)
    expect((await runBrowserCli(h, ['browser', 'tab', 'show', '--page', first.browserPageId, '--json'])).code).toBe(0)

    const switched = await runBrowserCli(h, ['browser', 'tab', 'switch', '--page', first.browserPageId, '--json'])
    expect(switched.code).toBe(0)
    const current = await runBrowserCli(h, ['browser', 'tab', 'current', '--worktree', worktree, '--json'])
    expect(JSON.parse(current.stdout)).toMatchObject({ tab: { browserPageId: first.browserPageId } })
    const listed = await runBrowserCli(h, ['browser', 'tab', 'list', '--worktree', 'all', '--json'])
    expect((JSON.parse(listed.stdout) as { tabs: Array<{ browserPageId: string }> }).tabs.map((tab) => tab.browserPageId))
      .toEqual(expect.arrayContaining([first.browserPageId, second.browserPageId]))

    const conflict = call(h.client, 'tabSwitch', { page: first.browserPageId, index: 0 })
    await expect(conflict).rejects.toBeInstanceOf(Error)
    const cliConflict = await runBrowserCli(h, ['browser', 'tab', 'switch', '--page', first.browserPageId, '--index', '0', '--json'])
    expect(cliConflict.code).not.toBe(0)
    const unscopedFill = call(h.client, 'fill', { element: '#text', value: 'no-target' })
    await expect(unscopedFill).rejects.toBeInstanceOf(Error)
    expect(await call(h.client, 'eval', { page: first.browserPageId, expression: 'document.querySelector("#text").value' })).toEqual({ value: 'seed' })
    const unsupportedFocus = call(h.client, 'tabSwitch', { page: first.browserPageId, focus: true })
    await expect(unsupportedFocus).rejects.toBeInstanceOf(Error)
    const unsupportedFocusCli = await runBrowserCli(h, ['browser', 'tab', 'switch', '--page', first.browserPageId, '--focus', '--json'])
    expect(unsupportedFocusCli.code).not.toBe(0)
    const currentAfterFocus = await call(h.client, 'tabCurrent', { worktree }) as { tab: { browserPageId: string } }
    expect(currentAfterFocus.tab).toMatchObject({ browserPageId: first.browserPageId })
    const closed = await runBrowserCli(h, ['browser', 'tab', 'close', '--page', second.browserPageId, '--yes', '--json'])
    expect(closed.code).toBe(0)
    const missing = call(h.client, 'tabShow', { page: second.browserPageId })
    await expect(missing).rejects.toBeInstanceOf(Error)
    const missingCli = await runBrowserCli(h, ['browser', 'tab', 'show', '--page', second.browserPageId, '--json'])
    expect(missingCli.code).not.toBe(0)
  } finally { await h.cleanup() }
}, 90_000)

test('C3: real navigation, eval, snapshot refs, fill, click, and viewport screenshot affect the page', async () => {
  const h = await startBrowserHarness()
  try {
    const page = await newPage(h, `${h.fixtureUrl}first`)
    const navigation = await call(h.client, 'goto', { page: page.browserPageId, url: `${h.fixtureUrl}events` }) as { url: string; title: string }
    expect(navigation).toEqual({ url: `${h.fixtureUrl}events`, title: 'Events' })
    expect(await call(h.client, 'eval', { page: page.browserPageId, expression: '({title: document.title, value: document.querySelector("#text").value})' }))
      .toEqual({ value: { title: 'Events', value: 'seed' } })

    const snapshot = await call(h.client, 'snapshot', { page: page.browserPageId }) as { refs: Array<{ ref: string; role: string; name: string }> }
    const textField = snapshot.refs.find((ref) => ref.name === 'Text field')
    const submit = snapshot.refs.find((ref) => ref.name === 'Submit')
    expect(textField).toBeDefined()
    expect(submit).toBeDefined()
    await call(h.client, 'tabSwitch', { page: page.browserPageId })
    await call(h.client, 'fill', { page: page.browserPageId, element: textField!.ref, value: 'filled through a public ref' })
    expect(await call(h.client, 'eval', { page: page.browserPageId, expression: 'document.querySelector("#text").value' }))
      .toEqual({ value: 'filled through a public ref' })
    await call(h.client, 'click', { page: page.browserPageId, element: submit!.ref })
    expect(await call(h.client, 'eval', { page: page.browserPageId, expression: 'document.querySelector("#result").textContent' }))
      .toEqual({ value: 'clicked' })

    await call(h.client, 'goto', { page: page.browserPageId, url: `${h.fixtureUrl}second` })
    const stale = call(h.client, 'click', { page: page.browserPageId, element: submit!.ref })
    await expect(stale).rejects.toBeInstanceOf(Error)
    const staleCli = await runBrowserCli(h, ['browser', 'click', '--page', page.browserPageId, '--element', submit!.ref, '--json'])
    expect(staleCli.code).not.toBe(0)
    await call(h.client, 'goto', { page: page.browserPageId, url: `${h.fixtureUrl}tall` })
    const image = await call(h.client, 'screenshot', { page: page.browserPageId, format: 'png' }) as { data: string; format: string }
    const png = Buffer.from(image.data, 'base64')
    expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
    expect(image.format).toBe('png')
    const width = png.readUInt32BE(16)
    const height = png.readUInt32BE(20)
    expect(width).toBeGreaterThan(0)
    expect(height).toBeLessThan(2_600)
  } finally { await h.cleanup() }
}, 90_000)

test('C4: same-profile page selection and full commands are serialized atomically', async () => {
  let secondPageId: string | undefined
  const secondStarted = Promise.withResolvers<void>()
  const h = await startBrowserHarness({
    onOperation: (event) => {
      if (event.pageId === secondPageId && event.method === 'eval') secondStarted.resolve()
    }
  })
  const gate = h.fixtureGate('profile-lock')
  try {
    const first = await newPage(h)
    const second = await newPage(h)
    secondPageId = second.browserPageId

    const navigation = settle(call(h.client, 'goto', { page: first.browserPageId, url: `${h.fixtureUrl}gate/profile-lock` }))
    await gate.requested
    const evaluation = settle(call(h.client, 'eval', {
      page: second.browserPageId,
      expression: 'document.querySelector("#text").value = "second-page"; document.querySelector("#text").value'
    }))

    // This is an I/O watchdog for a profile-lock bypass: the second operation hook must stay blocked while the first page awaits its fixture response.
    expect(await signalBefore(secondStarted.promise, 150)).toBe(false)
    gate.release()
    expect((await navigation).status).toBe('fulfilled')
    expect((await evaluation).status).toBe('fulfilled')
    expect(await call(h.client, 'eval', { page: first.browserPageId, expression: 'document.title' })).toEqual({ value: 'Gate' })
    expect(await call(h.client, 'eval', { page: first.browserPageId, expression: 'document.querySelector("#text").value' })).toEqual({ value: 'seed' })
    expect(await call(h.client, 'eval', { page: second.browserPageId, expression: 'document.querySelector("#text").value' })).toEqual({ value: 'second-page' })
  } finally {
    gate.release()
    await h.cleanup()
  }
}, 90_000)

test('C5: CLI values stay literal and exec accepts only shipping page commands', async () => {
  const h = await startBrowserHarness()
  try {
    const worktree = await h.addFolderWorktree('BrowserCli')
    const pageResult = await runBrowserCli(h, ['browser', 'tab', 'create', '--url', `${h.fixtureUrl}events`, '--worktree', worktree, '--json'])
    expect(pageResult.code).toBe(0)
    const page = JSON.parse(pageResult.stdout) as { browserPageId: string }

    const filePath = join(h.home, 'existing synthetic input.txt')
    writeFileSync(filePath, 'this content must not be read')
    const literal = `@file:${filePath}`
    const cliFill = await runBrowserCli(h, ['browser', 'fill', '--page', page.browserPageId, '--element', '#text', '--value', literal, '--json'])
    expect(cliFill.code).toBe(0)
    expect(await call(h.client, 'eval', { page: page.browserPageId, expression: 'document.querySelector("#text").value' }))
      .toEqual({ value: literal })

    const supported = await runBrowserCli(h, ['browser', 'exec', '--page', page.browserPageId, '--command', 'fill "#text" "exec-value"', '--json'])
    expect(supported.code).toBe(0)
    expect(await call(h.client, 'eval', { page: page.browserPageId, expression: 'document.querySelector("#text").value' }))
      .toEqual({ value: 'exec-value' })
    const alias = await runBrowserCli(h, ['browser', 'exec', '--page', page.browserPageId, '--command', `navigate ${h.fixtureUrl}first`, '--json'])
    expect(alias.code).toBe(0)
    expect((await call(h.client, 'tabShow', { page: page.browserPageId }) as { tab: { url: string } }).tab.url).toBe(`${h.fixtureUrl}first`)

    for (const command of ['cookies get', 'full-screenshot', 'network har start', 'keyboard type hidden']) {
      const rejected = call(h.client, 'exec', { page: page.browserPageId, command })
      await expect(rejected).rejects.toBeInstanceOf(Error)
    }
    const unsupportedCli = await runBrowserCli(h, ['browser', 'exec', '--page', page.browserPageId, '--command', 'cookies get', '--json'])
    expect(unsupportedCli.code).not.toBe(0)

    const description = await h.client.callAny('api.describe', {}) as {
      methods: Array<{ name: string }>
      cli: { commands: Array<{ methods?: string[] }> }
    }
    const expected = [
      'profileList', 'profileCreate', 'tabList', 'tabShow', 'tabCurrent', 'tabCreate', 'tabSwitch', 'tabClose',
      'goto', 'eval', 'snapshot', 'fill', 'click', 'screenshot', 'exec'
    ].map((name) => `quirky.browser/${name}`).sort()
    const methods = description.methods.map(({ name }) => name).filter((name) => name.startsWith('quirky.browser/')).sort()
    expect(methods).toEqual(expected)
    const cliMethods = [...new Set(description.cli.commands.flatMap((command) => command.methods ?? []).filter((name) => name.startsWith('quirky.browser/')))].sort()
    expect(cliMethods).toEqual(expected)
  } finally { await h.cleanup() }
}, 90_000)

test('C6: actual switches invalidate refs, closed pages stay closed, and teardown cleans owned processes', async () => {
  let runningPageId: string | undefined
  let control: { crashHelper(profileId: string): Promise<void> } | undefined
  const runningStarted = Promise.withResolvers<void>()
  const h = await startBrowserHarness({
    onOperation: (event) => {
      if (event.pageId === runningPageId && event.method === 'eval') runningStarted.resolve()
    },
    onControl: (value) => { control = value }
  })
  try {
    const first = await newPage(h)
    const second = await newPage(h)
    const firstSnapshot = await call(h.client, 'snapshot', { page: first.browserPageId }) as { refs: Array<{ ref: string }> }
    const oldRef = firstSnapshot.refs[0]!.ref
    await call(h.client, 'tabSwitch', { page: second.browserPageId })
    const switchedRef = call(h.client, 'click', { page: first.browserPageId, element: oldRef })
    await expect(switchedRef).rejects.toBeInstanceOf(Error)

    const secondSnapshot = await call(h.client, 'snapshot', { page: second.browserPageId }) as { refs: Array<{ ref: string }> }
    const closedRef = secondSnapshot.refs[0]!.ref
    await call(h.client, 'tabClose', { page: second.browserPageId, yes: true })
    const clickClosed = call(h.client, 'click', { page: second.browserPageId, element: closedRef })
    await expect(clickClosed).rejects.toBeInstanceOf(Error)
    const showClosed = call(h.client, 'tabShow', { page: second.browserPageId })
    await expect(showClosed).rejects.toBeInstanceOf(Error)
    const closedCli = await runBrowserCli(h, ['browser', 'click', '--page', second.browserPageId, '--element', closedRef, '--json'])
    expect(closedCli.code).not.toBe(0)

    const runningPage = await newPage(h)
    runningPageId = runningPage.browserPageId
    const inFlight = settle(call(h.client, 'eval', {
      page: runningPage.browserPageId,
      expression: 'new Promise(resolve => setTimeout(() => resolve("late"), 20_000))'
    }))
    await runningStarted.promise
    const queued = settle(call(h.client, 'eval', { page: runningPage.browserPageId, expression: '2 + 2' }))
    await call(h.client, 'tabClose', { page: runningPage.browserPageId, yes: true })
    expect((await inFlight).status).toBe('rejected')
    expect((await queued).status).toBe('rejected')
    const pages = await call(h.client, 'tabList', { worktree: 'all' }) as { tabs: Array<{ browserPageId: string }> }
    const retainedSnapshot = await call(h.client, 'snapshot', { page: first.browserPageId }) as { refs: Array<{ ref: string }> }
    const retainedRef = retainedSnapshot.refs[0]!.ref
    expect(control).toBeDefined()
    await control!.crashHelper('default')
    const lostEpoch = call(h.client, 'eval', { page: first.browserPageId, expression: 'document.title' })
    await expect(lostEpoch).rejects.toBeInstanceOf(Error)
    expect(await call(h.client, 'eval', { page: first.browserPageId, expression: 'document.title' })).toEqual({ value: 'Events' })
    expect(h.spawnCount()).toBe(4)
    const staleAfterLoss = call(h.client, 'click', { page: first.browserPageId, element: retainedRef })
    await expect(staleAfterLoss).rejects.toBeInstanceOf(Error)
    expect(pages.tabs.map((page) => page.browserPageId)).not.toContain(runningPage.browserPageId)
  } finally { await h.cleanup() }
}, 90_000)
