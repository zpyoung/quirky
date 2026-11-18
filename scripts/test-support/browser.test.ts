import { expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { BROWSER_CANDIDATES, browserExecutable, resolveBrowserExecutable } from './browser'
import { CAPTURE_BROWSER_CANDIDATES, captureBrowserExecutable } from '../ui-review/browser'

const installed = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser'
]

test('Chrome resolution prefers the Playwright bundle without probing installed browsers', () => {
  const visits: string[] = []
  expect(resolveBrowserExecutable('/fixture/bundle', (path) => { visits.push(path); return true })).toBe('/fixture/bundle')
  expect(visits).toEqual(['/fixture/bundle'])
  expect(BROWSER_CANDIDATES).toEqual(installed)
})

test('an unavailable bundle falls back to each installed candidate in order', () => {
  for (const [index, candidate] of installed.entries()) {
    const visits: string[] = []
    expect(resolveBrowserExecutable('/fixture/bundle', (path) => {
      visits.push(path)
      return path === candidate
    })).toBe(candidate)
    expect(visits).toEqual(['/fixture/bundle', ...installed.slice(0, index + 1)])
  }
})

test('missing browsers fail explicitly with every attempted path', () => {
  const visits: string[] = []
  expect(() => resolveBrowserExecutable('/fixture/bundle', (path) => { visits.push(path); return false }))
    .toThrow(`No executable Chrome or Chromium`)
  try {
    resolveBrowserExecutable('/fixture/bundle', () => false)
  } catch (error) {
    for (const path of ['/fixture/bundle', ...installed]) expect((error as Error).message).toContain(path)
  }
  expect(visits).toEqual(['/fixture/bundle', ...installed])
  expect(resolveBrowserExecutable(undefined, (path) => path === '/usr/bin/google-chrome')).toBe('/usr/bin/google-chrome')
})

test('filesystem resolution accepts executable files and symlinks, not directories or unreadied files', () => {
  const root = mkdtempSync(join(tmpdir(), 'browser-resolution-'))
  try {
    const executable = join(root, 'chrome')
    const link = join(root, 'chrome-link')
    const directory = join(root, 'directory')
    const plain = join(root, 'not-executable')
    writeFileSync(executable, '#!/bin/sh\nexit 0\n')
    chmodSync(executable, 0o755)
    symlinkSync(executable, link)
    mkdirSync(directory)
    writeFileSync(plain, 'not executable', { mode: 0o644 })
    expect(resolveBrowserExecutable(executable)).toBe(executable)
    expect(resolveBrowserExecutable(link)).toBe(link)
    for (const invalid of [directory, plain, join(root, 'missing')]) {
      try {
        expect(resolveBrowserExecutable(invalid)).not.toBe(invalid)
      } catch (error) {
        expect((error as Error).message).toContain('No executable Chrome or Chromium')
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('browser and capture resolution tolerate unavailable Playwright bundle discovery', () => {
  const original = chromium.executablePath
  try {
    chromium.executablePath = () => { throw new Error('bundle unavailable') }
    for (const resolver of [browserExecutable, captureBrowserExecutable]) {
      const visits: string[] = []
      expect(resolver((path) => { visits.push(path); return path === '/usr/bin/google-chrome' }))
        .toBe('/usr/bin/google-chrome')
      expect(visits).toEqual(installed.slice(0, 3))
      expect(() => resolver(() => false)).toThrow(installed.join(', '))
    }
  } finally {
    chromium.executablePath = original
  }
})

test('capture preserves the shared candidates and Playwright-first callback order', () => {
  expect(CAPTURE_BROWSER_CANDIDATES).toBe(BROWSER_CANDIDATES)
  const bundle = chromium.executablePath()
  for (const candidate of [bundle, ...installed]) {
    const visits: string[] = []
    expect(captureBrowserExecutable((path) => { visits.push(path); return path === candidate })).toBe(candidate)
    expect(visits).toEqual([bundle, ...installed].slice(0, [bundle, ...installed].indexOf(candidate) + 1))
  }
})

test('browser proof prerequisites fail before allocating daemon or UI fixtures', () => {
  const root = mkdtempSync(join(tmpdir(), 'browser-prerequisite-'))
  try {
    const daemonTest = join(import.meta.dir, '../../packages/daemon/test/index-preload.browser.test.ts')
    const uiTest = join(import.meta.dir, '../../packages/ui/test/browser-tab.e2e.test.ts')
    const helpers = join(import.meta.dir, '../../packages/daemon/test/helpers.ts')
    const resolver = join(import.meta.dir, 'browser.ts')
    const probe = `
      import { mock } from 'bun:test'
      import * as fs from 'node:fs'
      const registered = new Map()
      let allocated = false
      let resolved = false
      const register = (name, callback) => registered.set(name, callback)
      register.skipIf = (skip) => skip ? () => {} : register
      mock.module('bun:test', () => ({ test: register, expect: () => {} }))
      mock.module('node:fs', () => ({
        ...fs,
        mkdtempSync: () => { allocated = true; throw new Error('UI fixture allocated') }
      }))
      mock.module(${JSON.stringify(helpers)}, () => ({
        makeTempHome: () => { allocated = true; throw new Error('fixture allocated') },
        startHarness: () => { throw new Error('daemon started') }
      }))
      mock.module(${JSON.stringify(resolver)}, () => ({
        browserExecutable: () => { resolved = true; throw new Error('No executable Chrome or Chromium: prerequisite fixture') }
      }))
      // Load after mocks so prerequisite failures cannot allocate real fixtures.
      await import(${JSON.stringify(daemonTest)})
      await import(${JSON.stringify(uiTest)})
      const proofs = []
      for (const name of [
        'preloads plugin UI before dynamic import and resolves its import-map dependency',
        'real browser proof cleans successful and injected-flow lifecycles'
      ]) {
        allocated = false
        resolved = false
        let error = ''
        try { await registered.get(name)?.() } catch (failure) { error = failure.message }
        proofs.push({ allocated, resolved, error, registered: registered.has(name) })
      }
      console.log(JSON.stringify(proofs))
    `
    const child = Bun.spawnSync([process.execPath, '-e', probe], {
      cwd: join(import.meta.dir, '../..'),
      env: { ...process.env, QUIRKY_HOME: root },
      stdout: 'pipe',
      stderr: 'pipe'
    })
    expect(child.exitCode).toBe(0)
    expect(JSON.parse(child.stdout.toString())).toEqual(Array.from({ length: 2 }, () => ({
      allocated: false,
      resolved: true,
      error: 'No executable Chrome or Chromium: prerequisite fixture',
      registered: true
    })))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
