import { expect, test } from 'bun:test'
import { languageForPath } from '../src/language'

test('maps extensions to languages', () => {
  expect(languageForPath('src/a.js')).toBe('javascript')
  expect(languageForPath('src/a.mjs')).toBe('javascript')
  expect(languageForPath('src/a.jsx')).toBe('jsx')
  expect(languageForPath('src/a.ts')).toBe('typescript')
  expect(languageForPath('src/a.tsx')).toBe('tsx')
  expect(languageForPath('package.json')).toBe('json')
  expect(languageForPath('README.md')).toBe('markdown')
  expect(languageForPath('tool/run.py')).toBe('python')
})

test('is case-insensitive and falls back to plain', () => {
  expect(languageForPath('A.TS')).toBe('typescript')
  expect(languageForPath('Makefile')).toBe('plain')
  expect(languageForPath('dir.ts/file')).toBe('plain')
  expect(languageForPath('.gitignore')).toBe('plain')
})
