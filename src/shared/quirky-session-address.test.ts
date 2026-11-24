import { describe, expect, it } from 'vitest'
import {
  formatQuirkySessionAddress,
  isQuirkySessionId,
  parseQuirkySessionAddress
} from './quirky-session-address'
import { testQuirkySessionId } from './quirky-session-address-test-fixture'

const SESSION_ID = testQuirkySessionId('0b7e4c2a-5f1d-4e8a-9c3b-2d6f8a1e4b70')
const ADDRESS = `quirky_session_id:${SESSION_ID}`

describe('Quirky session address', () => {
  it('addresses an Quirky session id as quirky_session_id:<id> and parses the bare id back', () => {
    expect(formatQuirkySessionAddress(SESSION_ID)).toBe(ADDRESS)
    expect(parseQuirkySessionAddress(ADDRESS)).toBe(SESSION_ID)
    const parsed = parseQuirkySessionAddress(ADDRESS)
    expect(parsed && formatQuirkySessionAddress(parsed)).toBe(ADDRESS)
  })

  it('reads only the addressed spelling when parsing an address', () => {
    // A bare id is what the columns store, not an address.
    expect(parseQuirkySessionAddress(SESSION_ID)).toBeNull()
    expect(parseQuirkySessionAddress(null)).toBeNull()
    expect(parseQuirkySessionAddress(undefined)).toBeNull()
    expect(parseQuirkySessionAddress('')).toBeNull()
  })

  it.each([
    ['an unknown prefix', `pane:${SESSION_ID}`],
    ['the Run mailbox namespace', 'run:run_123'],
    ['the Dispatch mailbox namespace', 'dispatch:ctx_123'],
    ['an empty prefix', `:${SESSION_ID}`],
    ['an empty id', 'quirky_session_id:'],
    ['an id with a separator', `quirky_session_id:${SESSION_ID}:extra`],
    ['an id the session predicate rejects', 'quirky_session_id:short'],
    ['a terminal handle', 'term_4f2c9a']
  ])('refuses %s', (_label, value) => {
    expect(parseQuirkySessionAddress(value)).toBeNull()
  })

  it('no longer reads the retired session:<id> spelling as a session, as an address or a bare id', () => {
    expect(parseQuirkySessionAddress(`session:${SESSION_ID}`)).toBeNull()
    expect(isQuirkySessionId(`session:${SESSION_ID}`)).toBe(false)
  })

  it.each([
    ['a PTY terminal handle', 'term_4f2c9a1b-7d3e-4a5f-8b6c-9d0e1f2a3b4c'],
    ['a short PTY terminal handle', 'term_4f2c9a'],
    ['a structured-worker handle', 'structworker_4f2c9a1b-7d3e-4a5f-8b6c-9d0e1f2a3b4c']
  ])('never treats %s as an Quirky session id', (_label, handle) => {
    // Handles share the session-id charset, so the session-record predicate alone would accept them.
    expect(isQuirkySessionId(handle)).toBe(false)
    expect(parseQuirkySessionAddress(`quirky_session_id:${handle}`)).toBeNull()
  })

  it('validates an Quirky session id with the session-record predicate', () => {
    expect(isQuirkySessionId(SESSION_ID)).toBe(true)
    expect(isQuirkySessionId('has space in it')).toBe(false)
    expect(isQuirkySessionId('x'.repeat(129))).toBe(false)
  })
})
