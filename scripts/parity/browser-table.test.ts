import { expect, test } from 'bun:test'
import { loadBrowserCapture, readBrowserTable, validateBrowserTable } from './browser-table'
import { browserChecks } from './browser-run'

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
  const covered = rows.find((row) => row.disposition === 'covered')
  expect(first).toBeDefined()
  expect(covered).toBeDefined()

  expect(() => validateBrowserTable([
    ...rows,
    { ...first!, id: 'invented-command', command: 'invented command', check: 'invented-command' }
  ])).toThrow('unknown-command')
  expect(() => validateBrowserTable(rows.map((row) => row === covered ? { ...row, reason: '' } : row))).toThrow('missing-reason')
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

test('pane, restart, and identity rows are covered with manifest-resolved CLI metadata', () => {
  const rows = readBrowserTable()
  const coveredRows = [
    {
      id: 'browser-identity-set-activation-after-restart',
      equivalent: 'CLI `quirky browser identity set`; flags: `--mode`, `--reset`; methods: `quirky.browser/identitySet`',
      reason: 'Identity mode staged before daemon restart becomes active on the restarted daemon with zero security shim invocations.'
    },
    {
      id: 'worktree-watch-page',
      equivalent: 'CLI `quirky browser pane open`; flags: `--worktree`, `--group`, `--url`, `--page`, `--mode`, `--profile`; methods: `quirky.browser/paneOpen`',
      reason: 'A browser Watch pane in a worktree renders the live screencast of the page and reflects CLI-driven DOM mutations in sampled canvas pixels.'
    },
    {
      id: 'daemon-restart-profile',
      equivalent: 'CLI `quirky browser tab list`; flags: `--worktree`, `--show-profile`; methods: `quirky.browser/tabList`, `quirky.browser/profileList`',
      reason: 'Browser tabs, profiles, Watch pane state, localStorage, and persistent cookies survive a daemon restart without re-seeding while keeping worktree B isolated.'
    }
  ]

  for (const expected of coveredRows) {
    const row = rows.find((candidate) => candidate.id === expected.id)
    expect(row).toMatchObject({
      id: expected.id,
      equivalent: expected.equivalent,
      check: expected.id,
      deferred: false,
      disposition: 'covered',
      reason: expected.reason
    })
  }
})

test('an executable registry must match the table declared check IDs exactly', () => {
  const rows = readBrowserTable()
  const registered = rows.flatMap((row) => row.check ? [row.check] : [])

  expect(() => validateBrowserTable(rows, registered)).not.toThrow()
  expect(() => validateBrowserTable(rows, registered.slice(1))).toThrow('missing-check')
  expect(() => validateBrowserTable(rows, [...registered, 'unexpected-check'])).toThrow('missing-check')
})

test('wait subordinate rows have distinct checks and reuse the primary CLI metadata', () => {
  const rows = readBrowserTable()
  const primary = rows.find((row) => row.id === 'wait')
  expect(primary).toBeDefined()
  const ids = ['wait-selector', 'wait-text', 'wait-js', 'wait-url', 'wait-load']
  const subordinates = ids.map((id) => rows.find((row) => row.id === id))

  expect(rows).toHaveLength(93)
  expect(subordinates.map((row) => row?.check)).toEqual(ids)
  expect(subordinates.map((row) => row?.equivalent)).toEqual(ids.map(() => primary?.equivalent))
  expect(subordinates.map((row) => row?.disposition)).toEqual(ids.map(() => 'covered'))
})

test('browser table rejects a missing registered wait-url row', () => {
  const rows = readBrowserTable()
  const registered = rows.flatMap((row) => row.check ? [row.check] : [])
  expect(() => validateBrowserTable(rows.filter((row) => row.id !== 'wait-url'), registered)).toThrow('missing-command')
})

test('compiled browser checks implement every declared executable row exactly once', () => {
  const rows = readBrowserTable()
  const ids = browserChecks.map(check => check.id)
  validateBrowserTable(rows, ids)
  expect(() => validateBrowserTable(rows, ids.filter(id => id !== 'upload'))).toThrow('missing-check')
})

test('browser inventory covers every equivalent and names the four exclusions', () => {
  const rows = readBrowserTable()
  expect(rows).toHaveLength(93)
  expect(rows.filter(row => row.disposition === 'gap' || row.deferred)).toEqual([])
  expect(rows.filter(row => row.disposition === 'excluded').map(row => row.id).sort()).toEqual([
    'exec-unrestricted', 'native-profile-clear', 'native-profile-persistence', 'tab-profile-create-imported'
  ])
  for (const id of ['intercept-enable', 'intercept-list', 'intercept-disable', 'open-url', 'tab-switch-focus', 'tab-profile-delete', 'wait-url']) {
    expect(rows.find(row => row.id === id)).toMatchObject({ disposition: 'covered', check: id, deferred: false })
  }
  for (const id of ['native-profile-persistence', 'native-profile-clear']) {
    const row = rows.find(row => row.id === id)!
    expect(row).toMatchObject({ disposition: 'excluded', equivalent: '—', deferred: false })
    expect(row.check).toBeUndefined()
    expect(row.reason).toContain('WKWebView')
    expect(row.reason).toContain('Not an Orca command')
  }
})

test('browser validator rejects deferred Native storage observers', () => {
  const rows = readBrowserTable().map(row => row.id === 'native-profile-clear'
    ? { ...row, deferred: true, disposition: 'gap' as const, check: undefined }
    : row)
  expect(() => validateBrowserTable(rows)).toThrow('missing-check')
})

test('browser validator rejects the old gap forms of executable extra rows', () => {
  for (const [id, reason] of [
    ['tab-switch-focus', 'Managed selection works, but --focus is refused instead of revealing the selected page. Follow-up: Reveal the selected browser page and route browser URLs to the intended client.'],
    ['wait-url', 'a wait fulfilled by a navigation is rejected with browser_tab_changed. Follow-up: Let a pending browser wait finish when the navigation it waits for lands.'],
    ['wait-load', 'a wait fulfilled by a navigation is rejected with browser_tab_changed. Follow-up: Let a pending browser wait finish when the navigation it waits for lands.']
  ]) {
    const rows = readBrowserTable().map(row => row.id === id ? { ...row, disposition: 'gap' as const, reason } : row)
    expect(() => validateBrowserTable(rows)).toThrow('missing-check')
  }
})

test('covered equivalents validate with and without the compiled registry', () => {
  const rows = readBrowserTable().map(row => {
    if (['native-profile-clear', 'native-profile-persistence'].includes(row.id)) {
      return { ...row, disposition: 'excluded' as const, deferred: false, check: undefined }
    }
    return { ...row, disposition: row.disposition === 'gap' ? 'covered' as const : row.disposition }
  })
  expect(() => validateBrowserTable(rows)).not.toThrow()
  expect(() => validateBrowserTable(rows, browserChecks.map(check => check.id))).not.toThrow()
})

test('dash equivalents cannot claim executable coverage', () => {
  for (const id of ['tab-profile-create-imported', 'exec-unrestricted', 'native-profile-persistence', 'native-profile-clear']) {
    const rows = readBrowserTable().map(row => row.id === id
      ? { ...row, disposition: 'covered' as const, deferred: false, check: id }
      : row)
    expect(() => validateBrowserTable(rows)).toThrow(/missing-check|manifest-mismatch/)
  }
})
