import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseRuleFile } from '../src/rules/format'
import { evaluate } from '../src/rules/match'
import type { Origin, Rule, RuleFile, Verdict } from '../src/rules/types'

const pluginDir = join(import.meta.dir, '..')
const rulesDir = join(pluginDir, 'rules')
const screensDir = join(import.meta.dir, 'fixtures', 'screens')

const AGENTS = ['antigravity', 'claude', 'cline', 'codex', 'cursor', 'gemini', 'hermes', 'omp', 'opencode', 'opencode2', 'pi', 'prime-agent']
const QUIET = 60_000

type Screen = { title: string; lines: string[] }

const origin = (agent: string): Origin => ({ kind: 'built-in', path: join(rulesDir, `${agent}.json`) })

function load(agent: string): RuleFile {
  const parsed = parseRuleFile(readFileSync(join(rulesDir, `${agent}.json`), 'utf8'), agent)
  if (!parsed.ok) throw new Error(`${agent}.json: ${parsed.reason}`)
  return parsed.file
}

function fixture(agent: string, rule: string, kind: 'match' | 'miss'): Screen {
  const [first, ...rest] = readFileSync(join(screensDir, agent, `${rule}.${kind}.txt`), 'utf8').split('\n')
  if (rest[rest.length - 1] === '') rest.pop()
  if (!first?.startsWith('title: ')) throw new Error(`${agent}/${rule}.${kind}.txt: first line must be "title: <title>"`)
  return { title: first.slice('title: '.length), lines: rest }
}

const run = (agent: string, screen: Screen, quietForMs: number | null = QUIET) => evaluate(load(agent), { ...screen, quietForMs }, origin(agent))

const expected = (agent: string, rule: Rule): Verdict =>
  rule.state === 'blocked' ? { rule: rule.id, state: 'blocked', kind: rule.kind ?? 'approval', origin: origin(agent) } : { rule: rule.id, state: rule.state, origin: origin(agent) }

describe('built-in rule files', () => {
  test('SC-8: a file exists for each of the twelve agents and no other', () => {
    const present = readdirSync(rulesDir).filter((name) => name.endsWith('.json')).map((name) => name.slice(0, -'.json'.length)).sort()
    expect(present).toEqual([...AGENTS].sort())
  })

  for (const agent of AGENTS) {
    describe(agent, () => {
      test('parses and has a why on every rule', () => {
        const file = load(agent)
        expect(file.rules.length).toBeGreaterThan(0)
        for (const rule of file.rules) expect(rule.why?.length ?? 0).toBeGreaterThan(0)
      })

      test('has a fixture for every rule and a rule for every fixture', () => {
        const ids = load(agent).rules.map((rule) => rule.id)
        const wanted = ids.flatMap((id) => [`${id}.match.txt`, `${id}.miss.txt`]).sort()
        expect(readdirSync(join(screensDir, agent)).sort()).toEqual(wanted)
      })

      for (const rule of load(agent).rules) {
        test(`${rule.id}: its match fixture yields exactly this rule`, () => {
          expect(run(agent, fixture(agent, rule.id, 'match')).verdict).toEqual(expected(agent, rule))
        })

        test(`${rule.id}: its near-miss fixture does not yield it`, () => {
          expect(run(agent, fixture(agent, rule.id, 'miss')).verdict?.rule).not.toBe(rule.id)
        })

        if (rule.quietMs) {
          test(`${rule.id}: its match fixture waits for quiet`, () => {
            const screen = fixture(agent, rule.id, 'match')
            for (const quietForMs of [0, rule.quietMs! - 1, null]) {
              const result = run(agent, screen, quietForMs)
              expect(result.verdict?.rule).not.toBe(rule.id)
              expect(result.pendingQuiet).toBe(rule.id)
            }
          })
        }
      }
    })
  }
})

describe('built-in rules: SC-8', () => {
  test("SC-8: cursor's command approval menu is blocked, approval", () => {
    const verdict = run('cursor', fixture('cursor', 'approval-menu', 'match')).verdict
    expect(verdict).toMatchObject({ rule: 'approval-menu', state: 'blocked', kind: 'approval' })
  })

  test('SC-8: cursor menu answered and followed by output is not blocked, nor is one scrolled out of the last 8 lines', () => {
    expect(run('cursor', fixture('cursor', 'approval-menu', 'miss')).verdict?.state).not.toBe('blocked')
    const menu = fixture('cursor', 'approval-menu', 'match')
    const scrolled = { title: menu.title, lines: [...menu.lines, ...Array.from({ length: 9 }, (_, index) => `output ${index}`)] }
    expect(run('cursor', scrolled).verdict?.state).not.toBe('blocked')
  })

  test('SC-8: cursor narration that repeats the menu wording is not blocked', () => {
    const lines = ['I asked whether to run this command?', 'and chose Run (once) because the allowlist (tab) was empty.', 'Run Everything (shift+tab) stayed off.']
    expect(run('cursor', { title: 'Cursor Agent', lines }).verdict?.state).not.toBe('blocked')
  })

  test('SC-8: codex Implement this plan? menu with its key row last is blocked, question', () => {
    const verdict = run('codex', fixture('codex', 'plan-implement-menu', 'match')).verdict
    expect(verdict).toMatchObject({ rule: 'plan-implement-menu', state: 'blocked', kind: 'question' })
  })

  test('SC-8: codex menu that scrolled up under later output is not blocked', () => {
    expect(run('codex', fixture('codex', 'plan-implement-menu', 'miss')).verdict?.state).not.toBe('blocked')
  })

  test('SC-8: claude title ✳ Claude Code with a quiet screen is idle', () => {
    const screen: Screen = { title: '✳ Claude Code', lines: ['● Done.', '> '] }
    expect(run('claude', screen, 1000).verdict).toMatchObject({ rule: 'rest-title', state: 'idle' })
  })

  test('SC-8: claude title ✳ Claude Code over a screen that keeps changing is not idle', () => {
    const screen: Screen = { title: '✳ Claude Code', lines: ['● Done.', '> '] }
    for (const quietForMs of [0, 999, null]) {
      const result = run('claude', screen, quietForMs)
      expect(result.verdict).toBeNull()
      expect(result.pendingQuiet).toBe('rest-title')
    }
  })

  test('SC-8: gemini title ✋ gemini is blocked, approval', () => {
    expect(run('gemini', { title: '✋ gemini', lines: [] }).verdict).toMatchObject({ rule: 'permission-title', state: 'blocked', kind: 'approval' })
  })

  test('SC-8: gemini ✦ is working and ◇ is idle', () => {
    expect(run('gemini', { title: '✦ gemini', lines: [] }).verdict).toMatchObject({ state: 'working' })
    expect(run('gemini', { title: '◇ gemini', lines: [] }).verdict).toMatchObject({ state: 'idle' })
  })
})

test('every fixture directory belongs to a built-in agent', () => {
  for (const entry of readdirSync(screensDir)) expect(existsSync(join(rulesDir, `${entry}.json`))).toBe(true)
})
