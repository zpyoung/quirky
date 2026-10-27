import { describe, expect, test } from 'bun:test'
import { captureProviderSession } from '../src/capture'

const T = '/tmp/t/abc.jsonl'

describe('captureProviderSession', () => {
  test.each(['claude', 'openclaude', 'codex', 'qoder', 'qoder-cn', 'qwen-code', 'codebuddy', 'muse'])(
    '%s: session_id with the hook transcript',
    (source) => {
      expect(captureProviderSession(source, { session_id: 'abc', transcript_path: T })).toEqual({ id: 'abc', transcriptPath: T })
      expect(captureProviderSession(source, { session_id: 'abc', transcriptPath: T })).toEqual({ id: 'abc', transcriptPath: T })
      expect(captureProviderSession(source, { session_id: 'abc' })).toEqual({ id: 'abc', transcriptPath: null })
      expect(captureProviderSession(source, {})).toBeNull()
    }
  )

  test.each(['gemini', 'droid', 'kimi', 'zcode', 'kiro', 'dsh'])('%s: session_id only, never the transcript', (source) => {
    expect(captureProviderSession(source, { session_id: 'abc', transcript_path: T })).toEqual({ id: 'abc', transcriptPath: null })
  })

  test('SC-12: antigravity, opencode family, cursor and pi use their own keys', () => {
    expect(captureProviderSession('antigravity', { conversationId: 'cv1', session_id: 'no' })).toEqual({ id: 'cv1', transcriptPath: null })
    for (const source of ['opencode', 'opencode2', 'mimo-code']) {
      expect(captureProviderSession(source, { sessionID: 'oc1', session_id: 'no' })).toEqual({ id: 'oc1', transcriptPath: null })
    }
    expect(captureProviderSession('cursor', { conversation_id: 'cu1', session_id: 'no' })).toEqual({ id: 'cu1', transcriptPath: null })
    expect(captureProviderSession('pi', { session_id: 'p1', session_file: '/p.jsonl' })).toEqual({ id: 'p1', transcriptPath: '/p.jsonl' })
  })

  test('pi and prime-agent need the session file; omp does not', () => {
    for (const source of ['pi', 'prime-agent']) {
      expect(captureProviderSession(source, { session_id: 'p1' })).toBeNull()
      expect(captureProviderSession(source, { session_id: 'p1', session_file: '/p.jsonl' })).toEqual({ id: 'p1', transcriptPath: '/p.jsonl' })
      expect(captureProviderSession(source, { session_id: 'p1', transcript_path: T })).toBeNull()
    }
    expect(captureProviderSession('omp', { session_id: 'o1' })).toEqual({ id: 'o1', transcriptPath: null })
    expect(captureProviderSession('omp', { session_id: 'o1', session_file: '/o.jsonl' })).toEqual({ id: 'o1', transcriptPath: '/o.jsonl' })
  })

  test('grok prefers sessionId; devin, jcode and copilot take either spelling', () => {
    expect(captureProviderSession('grok', { sessionId: 'g1', session_id: 'g2' })).toEqual({ id: 'g1', transcriptPath: null })
    expect(captureProviderSession('grok', { session_id: 'g2' })).toEqual({ id: 'g2', transcriptPath: null })
    for (const source of ['devin', 'jcode', 'copilot']) {
      expect(captureProviderSession(source, { session_id: 's1', sessionId: 's2' })).toEqual({ id: 's1', transcriptPath: null })
      expect(captureProviderSession(source, { sessionId: 's2' })).toEqual({ id: 's2', transcriptPath: null })
    }
  })

  test.each(['amp', 'command-code', 'hermes', 'nonsense'])('%s captures nothing', (source) => {
    expect(captureProviderSession(source, { session_id: 'abc', sessionId: 'abc', conversation_id: 'abc' })).toBeNull()
  })

  test('ids that fail the stored-id rules are not captured', () => {
    const bad = ['', '   ', '-flag', 'a\nb', 'a\u0000b', 'x'.repeat(513), 42, null]
    for (const id of bad) expect(captureProviderSession('claude', { session_id: id })).toBeNull()
    expect(captureProviderSession('claude', { session_id: '  abc  ' })).toEqual({ id: 'abc', transcriptPath: null })
    expect(captureProviderSession('claude', { session_id: 'x'.repeat(512) })?.id).toHaveLength(512)
  })

  test('an unsafe transcript path is dropped, the session is kept', () => {
    expect(captureProviderSession('claude', { session_id: 'abc', transcript_path: '/t\n/x' })).toEqual({ id: 'abc', transcriptPath: null })
    expect(captureProviderSession('claude', { session_id: 'abc', transcript_path: '  ' })).toEqual({ id: 'abc', transcriptPath: null })
  })

  test.each(['constructor', 'toString', '__proto__'])('inherited property name %s is an unknown source', (source) => {
    expect(captureProviderSession(source, { session_id: 'abc', transcript_path: T })).toBeNull()
  })

  test('a falsy first key falls through to the next', () => {
    expect(captureProviderSession('grok', { sessionId: '', session_id: 'g2' })).toEqual({ id: 'g2', transcriptPath: null })
  })
})
