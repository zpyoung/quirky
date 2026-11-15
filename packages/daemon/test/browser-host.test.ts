import { afterEach, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { CONNECTION_METHODS, KERNEL_METHOD_SCHEMAS, RpcErrorCode, type BrowserHostPrompt, type FolderListing, type Methods, type QuirkyClient, type QuirkyEvent } from '@quirky/protocol'
import type { Harness } from './helpers'
import { startHarness } from './helpers'

const CONTROL_ID = 'ui.browserHost.control'
const harnesses: Harness[] = []
const ownedDirs: string[] = []
const changedEnv = new Map<string, string | undefined>()

const browserCapabilities = {
  directoryPicker: true,
  auxiliaryWindows: true,
  revealItem: false,
  notifications: { permission: false, click: false, dismiss: false }
}

function ownedDir(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix))
  ownedDirs.push(path)
  return path
}

function setEnv(name: string, value: string): void {
  if (!changedEnv.has(name)) changedEnv.set(name, process.env[name])
  process.env[name] = value
}

async function startFixture(options: { uiDir?: string; token?: string } = {}): Promise<Harness> {
  const home = ownedDir('quirky-browser-host-home-')
  if (options.token) {
    writeFileSync(join(home, 'daemon-identity.json'), JSON.stringify({ port: 0, token: options.token, hookToken: 'browser-host-hook-token-123456' }))
  }
  const harness = await startHarness({ home, uiDir: options.uiDir ?? join(home, 'no-ui'), builtinPluginsDir: null })
  harnesses.push(harness)
  return harness
}

async function failure(call: Promise<unknown>): Promise<{ code: number; message: string }> {
  try {
    await call
  } catch (error) {
    return error as { code: number; message: string }
  }
  throw new Error('expected the RPC call to reject')
}


function waitForUiCommand(client: QuirkyClient): Promise<Extract<QuirkyEvent, { type: 'ui.command.request' }>> {
  const { promise, resolve } = Promise.withResolvers<Extract<QuirkyEvent, { type: 'ui.command.request' }>>()
  const unsubscribe = client.onEvent((event) => {
    if (event.type !== 'ui.command.request' || event.id !== CONTROL_ID) return
    unsubscribe()
    resolve(event)
  })
  return promise
}

afterEach(async () => {
  for (const harness of harnesses.splice(0)) await harness.cleanup()
  for (const path of ownedDirs.splice(0)) rmSync(path, { recursive: true, force: true })
  for (const [name, value] of changedEnv) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  changedEnv.clear()
})

test('browser-host protocol methods expose complete non-connection kernel schemas', () => {
  const folderListing: FolderListing = {
    path: '/tmp/root',
    parent: '/tmp',
    entries: [{ name: 'alpha', path: '/tmp/root/alpha' }],
    offset: 0,
    limit: 100,
    hasMore: false
  }
  const prompt: BrowserHostPrompt = {
    requestId: 'request-1',
    kind: 'folder-picker',
    title: 'Choose folder',
    expiresAt: 1,
    busy: false,
    error: null,
    draftPath: '/tmp/root',
    directory: folderListing,
    selectedPaths: [],
    multiple: false
  }
  const params: Methods['ui.browserHost.control']['params'] = { connId: 17, action: 'state' }

  expect(prompt.directory).toEqual(folderListing)
  expect(params).toEqual({ connId: 17, action: 'state' })
  for (const name of ['ui.url', 'ui.open', 'ui.folder.list', CONTROL_ID]) {
    const schema = KERNEL_METHOD_SCHEMAS[name as keyof typeof KERNEL_METHOD_SCHEMAS]
    expect(schema.description).toEqual(expect.any(String))
    expect(schema.params.type).toBe('object')
    expect(schema.result.type).toBe('object')
    expect(CONNECTION_METHODS).not.toContain(name)
  }
  expect(KERNEL_METHOD_SCHEMAS['ui.url'].readOnly).toBe(true)
  expect(KERNEL_METHOD_SCHEMAS['ui.folder.list'].readOnly).toBe(true)
  expect(KERNEL_METHOD_SCHEMAS['ui.open'].readOnly).not.toBe(true)
  expect(KERNEL_METHOD_SCHEMAS[CONTROL_ID].params.properties?.action?.enum).toEqual([
    'state', 'set-path', 'navigate', 'select', 'confirm', 'cancel', 'open-popup'
  ])
  const folderSchema = KERNEL_METHOD_SCHEMAS['ui.folder.list']
  expect(folderSchema.params.properties?.limit).toMatchObject({ type: 'integer', minimum: 1, maximum: 200 })
  expect(folderSchema.result.required).toEqual(['path', 'parent', 'entries', 'offset', 'limit', 'hasMore'])
  expect(Object.keys(folderSchema.result.properties ?? {})).toEqual([
    'path', 'parent', 'entries', 'offset', 'limit', 'hasMore'
  ])
  expect(KERNEL_METHOD_SCHEMAS[CONTROL_ID].params.required).toEqual(['connId', 'action'])
  const promptSchema = KERNEL_METHOD_SCHEMAS[CONTROL_ID].result.properties?.active
  expect(Object.keys(promptSchema?.properties ?? {})).toEqual([
    'requestId', 'kind', 'title', 'expiresAt', 'busy', 'error', 'draftPath', 'directory', 'selectedPaths', 'multiple'
  ])
})

test('ui.url checks the served index at call time and uses the actual bound port and encoded runtime token', async () => {
  const uiDir = ownedDir('quirky-browser-host-ui-')
  const token = 'browser token +/?:#% value'
  const harness = await startFixture({ uiDir, token })
  const cli = await harness.connect('cli')

  const absent = await failure(cli.call('ui.url', {}))
  expect(absent).toMatchObject({ code: RpcErrorCode.NotFound, message: 'browser UI is not built' })
  const absentOpen = await failure(cli.call('ui.open', {}))
  expect(absentOpen).toMatchObject({ code: RpcErrorCode.NotFound, message: 'browser UI is not built' })

  mkdirSync(uiDir, { recursive: true })
  writeFileSync(join(uiDir, 'index.html'), '<!doctype html><title>fixture</title>')
  const expectedUrl = `http://127.0.0.1:${harness.runtime.port}/#token=${encodeURIComponent(token)}`
  expect(await cli.call('ui.url', {})).toEqual({ url: expectedUrl })

  rmSync(join(uiDir, 'index.html'))
  const removed = await failure(cli.call('ui.url', {}))
  expect(removed).toMatchObject({ code: RpcErrorCode.NotFound, message: 'browser UI is not built' })
})

test('ui.open invokes one argv-only host opener and hides its bearer URL on errors', async () => {
  const root = ownedDir('quirky-browser-opener-')
  const uiDir = join(root, 'ui')
  const bin = join(root, 'bin')
  mkdirSync(uiDir, { recursive: true })
  mkdirSync(bin)
  writeFileSync(join(uiDir, 'index.html'), '<!doctype html><title>fixture</title>')
  const log = join(root, 'opener.log')
  const originalPath = process.env.PATH ?? ''
  const opener = `#!/bin/sh\nprintf '%s:%s:%s\\n' "$(basename "$0")" "$#" "$1" >> "$QUIRKY_TEST_OPEN_LOG"\nif [ "$QUIRKY_TEST_OPEN_MODE" = fail ]; then printf '%s\\n' "$1" >&2; exit 7; fi\nif [ "$QUIRKY_TEST_OPEN_MODE" = timeout ]; then exec /bin/sleep 20; fi\n`
  for (const name of ['open', 'xdg-open']) {
    const path = join(bin, name)
    writeFileSync(path, opener)
    chmodSync(path, 0o755)
  }
  setEnv('PATH', `${bin}${delimiter}${process.env.PATH ?? ''}`)
  setEnv('QUIRKY_TEST_OPEN_LOG', log)
  setEnv('QUIRKY_TEST_OPEN_MODE', 'success')

  const harness = await startFixture({ uiDir, token: 'browser-opener-token +/?#% value' })
  const cli = await harness.connect('cli')
  const expectedUrl = `http://127.0.0.1:${harness.runtime.port}/#token=${encodeURIComponent(harness.runtime.token)}`
  expect(await cli.call('ui.open', {})).toEqual({ url: expectedUrl, requested: true })
  const missingBin = join(root, 'empty-bin')
  mkdirSync(missingBin)
  setEnv('PATH', missingBin)
  const missing = await failure(cli.call('ui.open', {}))
  expect(missing).toMatchObject({ code: RpcErrorCode.Conflict, message: 'could not request the default browser' })
  expect(missing.message).not.toContain(harness.runtime.token)
  setEnv('PATH', `${bin}${delimiter}${originalPath}`)


  setEnv('QUIRKY_TEST_OPEN_MODE', 'fail')
  const failed = await failure(cli.call('ui.open', {}))
  expect(failed).toMatchObject({ code: RpcErrorCode.Conflict, message: 'could not request the default browser' })
  expect(failed.message).not.toContain(harness.runtime.token)

  setEnv('QUIRKY_TEST_OPEN_MODE', 'timeout')
  const timeoutStarted = Date.now()
  const timedOut = await failure(cli.call('ui.open', {}))
  expect(timedOut).toMatchObject({ code: RpcErrorCode.Conflict, message: 'could not request the default browser' })
  expect(timedOut.message).not.toContain(harness.runtime.token)
  expect(Date.now() - timeoutStarted).toBeGreaterThanOrEqual(4_900)

  const expectedCommand = process.platform === 'darwin' ? 'open' : 'xdg-open'
  const expectedCall = `${expectedCommand}:1:${expectedUrl}`
  expect(readFileSync(log, 'utf8').trim().split('\n')).toEqual([expectedCall, expectedCall, expectedCall])
}, 15_000)

test('ui.folder.list canonicalizes directory symlinks, sorts directory-only pages and defaults to OS home', async () => {
  const harness = await startFixture()
  const cli = await harness.connect('cli')
  const root = ownedDir('quirky-browser-folders-')
  mkdirSync(join(root, 'alpha'))
  mkdirSync(join(root, 'beta'))
  mkdirSync(join(root, '.hidden'))
  mkdirSync(join(root, '\uE000'))
  mkdirSync(join(root, '\u{10000}'))
  writeFileSync(join(root, 'notes.txt'), 'file')
  symlinkSync(join(root, 'alpha'), join(root, 'alias'), 'dir')

  const canonicalRoot = realpathSync(root)
  const listing = await cli.call('ui.folder.list', { path: root })
  expect(listing).toEqual({
    path: canonicalRoot,
    parent: realpathSync(join(root, '..')),
    entries: ['.hidden', 'alias', 'alpha', 'beta', '\uE000', '\u{10000}'].map((name) => ({ name, path: join(canonicalRoot, name) })),
    offset: 0,
    limit: 100,
    hasMore: false
  })

  const alias = await cli.call('ui.folder.list', { path: join(root, 'alias') })
  expect(alias.path).toBe(join(canonicalRoot, 'alpha'))
  expect(alias.parent).toBe(canonicalRoot)
  expect(alias.entries).toEqual([])

  const page = await cli.call('ui.folder.list', { path: root, offset: 1, limit: 2 })
  expect(page.entries).toEqual([
    { name: 'alias', path: join(canonicalRoot, 'alias') },
    { name: 'alpha', path: join(canonicalRoot, 'alpha') }
  ])
  expect(page).toMatchObject({ offset: 1, limit: 2, hasMore: true })

  const osHome = ownedDir('quirky-browser-os-home-')
  setEnv('HOME', osHome)
  setEnv('QUIRKY_HOME', harness.home)
  const home = await cli.call('ui.folder.list', {})
  expect(home.path).toBe(realpathSync(homedir()))
  expect(home.path).not.toBe(realpathSync(harness.home))
  expect(home.parent).toBe(realpathSync(homedir()) === '/' ? null : realpathSync(join(homedir(), '..')))
  expect(home).toMatchObject({ offset: 0, limit: 100 })

  const filesystemRoot = await cli.call('ui.folder.list', { path: '/', limit: 1 })
  expect(filesystemRoot.path).toBe('/')
  expect(filesystemRoot.parent).toBeNull()
  expect(filesystemRoot.entries).toHaveLength(1)
})

test('ui.folder.list maps invalid, missing, non-directory and unreadable paths to distinct RPC errors', async () => {
  const harness = await startFixture()
  const cli = await harness.connect('cli')
  const root = ownedDir('quirky-browser-folder-errors-')
  const file = join(root, 'notes.txt')
  const missing = join(root, 'missing')
  const unreadable = join(root, 'unreadable')
  writeFileSync(file, 'file')
  mkdirSync(unreadable)
  try {
    chmodSync(unreadable, 0)

    for (const [path, reason] of [
      ['', 'non-empty'],
      ['relative/path', 'absolute'],
      ['contains\0nul', 'NUL']
    ] as const) {
      const invalid = await failure(cli.call('ui.folder.list', { path }))
      expect(invalid.code).toBe(RpcErrorCode.InvalidParams)
      expect(invalid.message).toContain(reason)
    }
    const fileError = await failure(cli.call('ui.folder.list', { path: file }))
    expect(fileError).toMatchObject({ code: RpcErrorCode.InvalidParams })
    expect(fileError.message).toContain('not a directory')
    const missingError = await failure(cli.call('ui.folder.list', { path: missing }))
    expect(missingError).toMatchObject({ code: RpcErrorCode.NotFound })
    expect(missingError.message).toContain('does not exist')
    const readError = await failure(cli.call('ui.folder.list', { path: unreadable }))
    expect(readError).toMatchObject({ code: RpcErrorCode.Conflict })
    expect(readError.message).toContain('cannot read')

    for (const params of [
      { path: root, limit: 0 },
      { path: root, limit: 201 },
      { path: root, limit: 1.5 },
      { path: root, offset: -1 },
      { path: root, offset: 1.5 }
    ]) {
      expect(await failure(cli.call('ui.folder.list', params))).toMatchObject({ code: RpcErrorCode.InvalidParams })
    }
  } finally {
    chmodSync(unreadable, 0o700)
  }
})

test('ui.browserHost.control validates action-specific params and only routes reserved control to its exact browser window', async () => {
  const harness = await startFixture()
  const cli = await harness.connect('cli')
  const browserEvents = await harness.connectWithEvents('ui')
  const nativeEvents = await harness.connectWithEvents('ui')
  const browser = browserEvents.client
  const native = nativeEvents.client
  await browser.call('desktop.shell.capabilities', browserCapabilities)
  await native.call('desktop.shell.capabilities', {
    directoryPicker: false,
    auxiliaryWindows: false,
    revealItem: true,
    notifications: { permission: true, click: true, dismiss: true }
  })
  const connId = (await browser.call('ui.window.self', {})).connId
  const otherConnId = (await native.call('ui.window.self', {})).connId

  for (const params of [
    { connId, action: 'not-an-action' },
    { connId, action: 'navigate', path: '/tmp' },
    { connId, action: 'navigate', requestId: 'request-1' },
    { connId, action: 'select', requestId: 'request-1', path: '/tmp' },
    { connId, action: 'set-path', requestId: 'request-1', path: '' },
    { connId, action: 'cancel', requestId: '' },
    { connId, action: 'confirm', offset: 1, requestId: 'request-1' },
    { connId, action: 'state', requestId: 'request-1' },
    { connId: 0, action: 'state' }
  ]) {
    expect(await failure(cli.call(CONTROL_ID, params as Methods['ui.browserHost.control']['params']))).toMatchObject({ code: RpcErrorCode.InvalidParams })
  }

  const nativeOnly = await failure(cli.call(CONTROL_ID, { connId: otherConnId, action: 'state' }))
  expect(nativeOnly.code).toBe(RpcErrorCode.Conflict)

  const unregisteredPluginCommand = await failure(cli.call('ui.command.run', { id: CONTROL_ID, args: { action: 'state' } }))
  expect(unregisteredPluginCommand.code).toBe(RpcErrorCode.NotFound)

  const expected = { active: null }
  const requestEvent = waitForUiCommand(browser)
  const control = cli.call(CONTROL_ID, { connId, action: 'state' })
  const request = await requestEvent
  expect(request.id).toBe(CONTROL_ID)
  expect(request.args).toEqual({ action: 'state' })
  expect(browserEvents.events.filter((event) => event.type === 'ui.command.request')).toContainEqual(request)
  expect(nativeEvents.events.some((event) => event.type === 'ui.command.request' && event.id === CONTROL_ID)).toBe(false)

  await native.call('ui.command.reply', { requestId: request.requestId, result: { active: { requestId: 'wrong-source' } } })
  await browser.call('ui.command.reply', { requestId: request.requestId, result: expected })
  const result = await control
  expect(result).toEqual(expected)
  expect(JSON.stringify(result)).not.toContain(harness.runtime.token)
  await native.close()
  expect(await failure(cli.call(CONTROL_ID, { connId: otherConnId, action: 'state' }))).toMatchObject({
    code: RpcErrorCode.Conflict
  })
})
