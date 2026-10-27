import { describe, expect, test } from 'bun:test'
import { CLAUDE_VERSION_FLOOR, SUPPRESSION_PROMPT, missingSuppressionArgs, versionAtLeast } from '../../src/core/claude-flags'

const DISALLOWED = ['--disallowedTools', 'AskUserQuestion']
const PROMPT = ['--append-system-prompt', SUPPRESSION_PROMPT]

describe('missingSuppressionArgs', () => {
  test('both pairs, in order, when neither flag is present', () => {
    expect(missingSuppressionArgs(['claude', 'fix it'])).toEqual([...DISALLOWED, ...PROMPT])
    expect(missingSuppressionArgs([])).toEqual([...DISALLOWED, ...PROMPT])
  })

  test('the prompt names quirky ask', () => {
    expect(SUPPRESSION_PROMPT).toBe('When you need to ask the user a question, run quirky ask (see quirky ask --help) instead of asking in chat.')
  })

  test('only the missing pair when one flag is present', () => {
    expect(missingSuppressionArgs(['claude', '--disallowedTools', 'Bash'])).toEqual(PROMPT)
    expect(missingSuppressionArgs(['claude', '--append-system-prompt', 'be terse'])).toEqual(DISALLOWED)
  })

  test('nothing when both flags are present', () => {
    expect(missingSuppressionArgs(['--disallowedTools', 'Bash', '--append-system-prompt', 'be terse'])).toEqual([])
  })

  test('a --flag=value token counts as the flag', () => {
    expect(missingSuppressionArgs(['claude', '--disallowedTools=Bash'])).toEqual(PROMPT)
    expect(missingSuppressionArgs(['claude', '--append-system-prompt=be terse'])).toEqual(DISALLOWED)
  })

  test('SC-26: the aliases --disallowed-tools and --append-system-prompt-file count, bare or with =value', () => {
    expect(missingSuppressionArgs(['--disallowed-tools=Bash', '--append-system-prompt-file', 'p.md'])).toEqual([])
    expect(missingSuppressionArgs(['--disallowed-tools', 'Bash'])).toEqual(PROMPT)
    expect(missingSuppressionArgs(['--append-system-prompt-file=p.md'])).toEqual(DISALLOWED)
  })

  test('a flag that only shares a prefix does not count', () => {
    expect(missingSuppressionArgs(['--disallowedToolsExtra', '--append-system-prompts'])).toEqual([...DISALLOWED, ...PROMPT])
  })
})

describe('versionAtLeast', () => {
  test('reads the first x.y.z in the output', () => {
    expect(versionAtLeast('2.1.0 (Claude Code)', CLAUDE_VERSION_FLOOR)).toBe(true)
    expect(versionAtLeast('claude 1.0.51\n', '1.0.51')).toBe(true)
    expect(versionAtLeast('1.0.50', CLAUDE_VERSION_FLOOR)).toBe(false)
  })

  test('compares numerically, not as text', () => {
    expect(versionAtLeast('1.0.100', '1.0.51')).toBe(true)
    expect(versionAtLeast('1.10.0', '1.9.9')).toBe(true)
    expect(versionAtLeast('0.99.99', '1.0.0')).toBe(false)
  })

  test('null when no version is found', () => {
    expect(versionAtLeast('garbage', CLAUDE_VERSION_FLOOR)).toBeNull()
    expect(versionAtLeast('', CLAUDE_VERSION_FLOOR)).toBeNull()
    expect(versionAtLeast('1.2', CLAUDE_VERSION_FLOOR)).toBeNull()
  })

  test('the floor is 1.0.51', () => {
    expect(CLAUDE_VERSION_FLOOR).toBe('1.0.51')
  })
})
