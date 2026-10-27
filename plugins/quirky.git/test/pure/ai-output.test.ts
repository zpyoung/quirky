import { describe, expect, test } from 'bun:test'
import { cleanGeneratedMessage, splitCommitMessage } from '../../src/daemon/ai-output'

const clean = (raw: string) => cleanGeneratedMessage(raw, { custom: false })

describe('cleanGeneratedMessage', () => {
  test('trims whitespace', () => {
    expect(clean('  feat: hello  \n')).toBe('feat: hello')
  })

  test('strips a single enclosing fenced code block, with or without a language tag', () => {
    expect(clean('```\nfeat: hello\n```')).toBe('feat: hello')
    expect(clean('```text\nfix: bug\n```')).toBe('fix: bug')
  })

  test('keeps a fence that does not enclose the whole output', () => {
    expect(clean('Fix it\n\n```\ncode\n```')).toBe('Fix it\n\n```\ncode\n```')
  })

  test('drops a leading status line', () => {
    expect(clean('Generating…\nfeat: hello world')).toBe('feat: hello world')
    expect(clean('Thinking about it\nfeat: hello world')).toBe('feat: hello world')
    expect(clean('...\nfeat: hello world')).toBe('feat: hello world')
  })

  test('NA-27 (d): drops the status line and the fence', () => {
    expect(clean('Generating…\n```\nFix crash\n```')).toBe('Fix crash')
  })

  test('strips the trailing jcode [Tokens] usage line', () => {
    expect(clean('feat: hello\n[Tokens] upload: 14926 download: 17 cache_read: 14720 cache_write: 0')).toBe('feat: hello')
  })

  test('extracts the answer from a jcode json envelope', () => {
    expect(clean(JSON.stringify({ session_id: 's1', model: 'm', text: 'fix-login-crash', usage: {} }))).toBe('fix-login-crash')
  })

  test('normalizes CRLF line endings', () => {
    expect(clean('feat: a\r\nbody line\r\n')).toBe('feat: a\nbody line')
  })

  test('cleans large fenced CRLF output', () => {
    const raw = `\r\n\`\`\`text\r\nfeat: large output\r\n${'body line\r\n'.repeat(10_000)}\`\`\`\r\n`
    const result = clean(raw)
    expect(result.startsWith('feat: large output\nbody line')).toBe(true)
    expect(result.endsWith('body line')).toBe(true)
    expect(result).not.toContain('\r\n')
  })

  test('strips a leading list marker', () => {
    expect(clean('● Add Copilot entry to agent results')).toBe('Add Copilot entry to agent results')
    expect(clean('1. Add numbered entry')).toBe('Add numbered entry')
    expect(clean('- Fix crash')).toBe('Fix crash')
  })

  test('returns an empty string for whitespace', () => {
    expect(clean('   \n\t')).toBe('')
  })

  test('drops a leading <think> block and unwraps the answer', () => {
    expect(clean('<think>\nThe diff fixes a typo.\n</think>\n\nFix typo\n\n- Why')).toBe('Fix typo\n\n- Why')
    expect(clean('<think>short</think>\n```\nfeat: add parser\n```')).toBe('feat: add parser')
  })

  test('NA-27 (e): drops the reasoning block and the list marker', () => {
    expect(clean('<think>The diff renames a crash fix.</think>\n- Fix crash')).toBe('Fix crash')
  })

  test('drops a leading Kimi-VL reasoning block', () => {
    expect(clean('◁think▷Typo in README.◁/think▷Fix typo in README')).toBe('Fix typo in README')
  })

  test('keeps think tags that are not a leading reasoning block', () => {
    const quoted = 'Strip <think>…</think> blocks from generated messages'
    expect(clean(quoted)).toBe(quoted)
    expect(clean('fix: handle stray </think> in stream')).toBe('fix: handle stray </think> in stream')
    expect(clean('<think>still reasoning')).toBe('<think>still reasoning')
  })

  test('strips a prefilled-reasoning preamble for a custom command only', () => {
    const raw = "We need the message only.\nLet's finalize.</think>Fix typo"
    expect(cleanGeneratedMessage(raw, { custom: true })).toBe('Fix typo')
    expect(cleanGeneratedMessage('Reasoning.◁/think▷\nFix typo', { custom: true })).toBe('Fix typo')
    expect(clean(raw)).toBe(raw)
  })

  test('keeps a closing tag that follows its own opening tag, even for a custom command', () => {
    const quoted = 'Strip <think>…</think> blocks'
    expect(cleanGeneratedMessage(quoted, { custom: true })).toBe(quoted)
  })

  test('cleans again once a custom preamble is gone', () => {
    expect(cleanGeneratedMessage('thoughts</think>\n```\nFix crash\n```', { custom: true })).toBe('Fix crash')
  })
})

describe('splitCommitMessage', () => {
  test('NA-27 (a): cuts the subject to 72 characters, drops the trailing dot, has no body', () => {
    const long = 'Add parser for the new config format and wire it into the loader and the CLI.'
    const result = splitCommitMessage(long)
    expect(result.subject).toBe(long.slice(0, 72).trimEnd())
    expect(result.subject.length).toBeLessThanOrEqual(72)
    expect(result.body).toBe('')
    expect(result.message).toBe(result.subject)
  })

  test('NA-27 (b): empty output becomes "Update project files"', () => {
    expect(splitCommitMessage('')).toEqual({ message: 'Update project files', subject: 'Update project files', body: '' })
    expect(splitCommitMessage('  \n ')).toEqual({ message: 'Update project files', subject: 'Update project files', body: '' })
  })

  test('NA-27 (c): trailing dots go and the body starts after the subject line', () => {
    expect(splitCommitMessage('Fix crash...\n\n\nBecause the list was empty.')).toEqual({
      message: 'Fix crash\n\nBecause the list was empty.',
      subject: 'Fix crash',
      body: 'Because the list was empty.'
    })
  })

  test('normalizes subject and preserves body text', () => {
    expect(splitCommitMessage('Fix source control generation.\n\n- Move planning into main')).toEqual({
      subject: 'Fix source control generation',
      body: '- Move planning into main',
      message: 'Fix source control generation\n\n- Move planning into main'
    })
  })

  test('cleans the text first', () => {
    expect(splitCommitMessage('Generating…\n```\nFix crash.\n\nWhy.\n```')).toEqual({
      subject: 'Fix crash',
      body: 'Why.',
      message: 'Fix crash\n\nWhy.'
    })
  })

  test('handles a very long body', () => {
    const body = '- Explain one generated change\n'.repeat(10_000).trimEnd()
    const result = splitCommitMessage(`Add generated paste protection\n\n${body}`)
    expect(result.subject).toBe('Add generated paste protection')
    expect(result.body).toBe(body)
  })

  test('falls back when the subject is only dots', () => {
    expect(splitCommitMessage('...x\n\nbody').subject).toBe('...x')
    expect(splitCommitMessage('...')).toEqual({ message: 'Update project files', subject: 'Update project files', body: '' })
  })
})
