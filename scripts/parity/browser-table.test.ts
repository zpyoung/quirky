import { expect, test } from 'bun:test'
import { loadBrowserCapture, readBrowserTable, validateBrowserTable } from './browser-table'

test('browser table accounts for every frozen command and resolves the current public CLI', () => {
  const capture = loadBrowserCapture()
  const rows = readBrowserTable()
  const primary = rows.filter((row) => row.primary)

  expect(capture.commands).toHaveLength(80)
  expect(primary.map((row) => row.command).sort()).toEqual(capture.commands.map((command) => command.words).sort())
  validateBrowserTable(rows)
})

test('browser table rejects missing and duplicate captured commands', () => {
  const rows = readBrowserTable()
  const upload = rows.find((row) => row.command === 'upload')
  const snapshot = rows.find((row) => row.command === 'snapshot')
  expect(upload).toBeDefined()
  expect(snapshot).toBeDefined()

  expect(() => validateBrowserTable(rows.filter((row) => row !== upload))).toThrow('missing-command')
  expect(() => validateBrowserTable([...rows, snapshot!])).toThrow('duplicate-command')
})

test('browser table rejects unknown commands, empty reasons, and missing check IDs', () => {
  const rows = readBrowserTable()
  const first = rows[0]
  const gap = rows.find((row) => row.disposition === 'gap')
  expect(first).toBeDefined()
  expect(gap).toBeDefined()

  expect(() => validateBrowserTable([
    ...rows,
    { ...first!, id: 'invented-command', command: 'invented command', check: 'invented-command' }
  ])).toThrow('unknown-command')
  expect(() => validateBrowserTable(rows.map((row) => row === gap ? { ...row, reason: '' } : row))).toThrow('missing-reason')
  expect(() => validateBrowserTable(rows.map((row) => row === first ? { ...row, check: 'not-registered' } : row))).toThrow('missing-check')
})

test('browser table resolves actual CLI words, flags, and public methods from the manifest', () => {
  const rows = readBrowserTable()
  const profileSet = rows.find((row) => row.command === 'tab profile set')
  expect(profileSet).toBeDefined()
  expect(profileSet?.equivalent).toContain('quirky browser tab profile set-page')

  const wrongWords = rows.map((row) => row === profileSet
    ? { ...row, equivalent: row.equivalent.replace('quirky browser tab profile set-page', 'quirky browser tab profile set') }
    : row)
  const wrongFlags = rows.map((row) => row === profileSet
    ? { ...row, equivalent: row.equivalent.replace('flags:', 'flags: `--not-a-real-flag`,') }
    : row)
  const wrongMethod = rows.map((row) => row === profileSet
    ? { ...row, equivalent: row.equivalent.replace('quirky.browser/tabProfileSet', 'quirky.browser/notARealMethod') }
    : row)

  expect(() => validateBrowserTable(wrongWords)).toThrow('manifest-mismatch')
  expect(() => validateBrowserTable(wrongFlags)).toThrow('manifest-mismatch')
  expect(() => validateBrowserTable(wrongMethod)).toThrow('manifest-mismatch')
})

test('pane and restart evidence remains explicitly deferred and uncovered', () => {
  const rows = readBrowserTable()
  const deferredIds = [
    'native-profile-persistence',
    'native-profile-clear',
    'browser-identity-set-activation-after-restart',
    'worktree-watch-page',
    'daemon-restart-profile'
  ]
  const deferred = rows.filter((row) => row.deferred)

  expect(deferred.map((row) => row.id).sort()).toEqual(deferredIds.sort())
  for (const id of deferredIds) {
    const row = deferred.find((candidate) => candidate.id === id)
    expect(row?.disposition).toBe('gap')
    expect(row?.check).toBeUndefined()
    expect(row?.reason.length).toBeGreaterThan(0)
  }
  for (const id of ['browser-identity-set-activation-after-restart', 'worktree-watch-page', 'daemon-restart-profile']) {
    expect(deferred.find((row) => row.id === id)?.reason).toContain('Prove CLI page identity in a worktree Watch pane across daemon restart')
  }
  expect(deferred.find((row) => row.id === 'native-profile-persistence')?.reason).toContain('WKWebView')
  expect(deferred.find((row) => row.id === 'native-profile-clear')?.reason).toContain('WKWebView')
})

test('an executable registry must match the table declared check IDs exactly', () => {
  const rows = readBrowserTable()
  const registered = rows.flatMap((row) => row.check ? [row.check] : [])

  expect(() => validateBrowserTable(rows, registered)).not.toThrow()
  expect(() => validateBrowserTable(rows, registered.slice(1))).toThrow('missing-check')
  expect(() => validateBrowserTable(rows, [...registered, 'unexpected-check'])).toThrow('missing-check')
})
