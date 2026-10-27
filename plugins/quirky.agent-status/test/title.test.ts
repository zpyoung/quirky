import { describe, expect, test } from 'bun:test'
import { classifyTitle, type TitleStatus } from '../src/title'

const cases: [string, string, TitleStatus | null][] = [
  ['SC-21 braille spinner without an agent name', '⠋ Working on it', 'working'],
  ['SC-21 gemini permission glyph', '✋ gemini', 'permission'],
  ['SC-21 claude rest glyph', '✳ Claude Code', 'idle'],
  ['SC-21 plain cwd title', '~/src/app', null],
  ['empty title', '', null],
  ['quarter-circle spinner', '◐ Claude Code', 'working'],
  ['gemini working glyph', '✦ Gemini CLI', 'working'],
  ['gemini silent working glyph', '⏲ Gemini CLI', 'working'],
  ['gemini idle glyph', '◇ Gemini CLI', 'idle'],
  ['claude rest glyph alone', '✳', 'idle'],
  ['claude management title', 'claude agents', null],
  ['claude management title with path', '/usr/local/bin/claude agents', null],
  ['cursor native title', 'Cursor Agent', null],
  ['codex action required', 'codex - action required', 'permission'],
  ['name plus waiting', 'copilot waiting', 'permission'],
  ['name plus ready', 'codex ready', 'idle'],
  ['name plus thinking', 'codex thinking', 'working'],
  ['name only defaults to idle', 'codex', 'idle'],
  ['name plus dot prefix', '. codex session', 'working'],
  ['name plus star prefix', '* codex session', 'idle'],
  ['agent name inside a path is not a token', '~/codex/ready', null],
  ['hyphenated compound is not a token', 'opencode-blinker', null],
  ['android is not droid', 'android build', null],
  ['droid name alone is not completion', 'droid', null],
  ['droid with ready', 'droid ready', 'idle'],
  ['keyword without an agent name', 'build is ready', null],
  ['dsh whale outranks the gemini working glyph', '✦ 🐋 session', null],
  ['dsh spinner still works', '⠙ 🐋 session', 'working'],
  ['pi state marker working', 'π : my-project', 'working'],
  ['pi state marker permission', 'π ! my-project', 'permission'],
  ['pi state marker idle', 'π > my-project', 'idle'],
  ['pi marker behind a wrapper', 'zsh | OMP : cwd', 'working'],
  ['pi synthetic ready', 'Pi ready', 'idle'],
  ['pi synthetic action required', 'OMP - action required', 'permission'],
  ['pi synthetic spinner', '⠋ Pi', 'working'],
  ['legacy pi label', 'π - session - cwd', 'idle'],
  ['legacy pi label with spinner', '⠋ π - session - cwd', 'working'],
  ['qoder working', '✦ Qoder CLI', 'working'],
  ['qoder permission', '▲ Qoder CLI', 'permission'],
  ['qoder idle', '◇ Qoder CLI', 'idle'],
  ['qoder dynamic title', '✦ fix the bug | Running', 'working'],
  ['opencode native idle', 'OC | session name', 'idle'],
  ['opencode native spinner', '⠋ OC | session name', 'working'],
  ['deepseek build idle', 'deepseek build', 'idle'],
  ['deepseek build working', '⠋ - fixing tests - deepseek build', 'working'],
  ['deepseek build action required', '⚠ Action Required - deepseek build', 'permission'],
  ['grok spinner', '⠋ Grok', 'working'],
]

describe('classifyTitle', () => {
  test.each(cases)('%s: %j', (_name, title, expected) => {
    expect(classifyTitle(title)).toBe(expected)
  })
})
