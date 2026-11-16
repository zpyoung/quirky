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
