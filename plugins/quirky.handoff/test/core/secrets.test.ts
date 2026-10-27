import { describe, expect, test } from 'bun:test'
import { scanSecrets } from '../../src/core/secrets'

describe('scanSecrets', () => {
  test('finds two hits in text order with short excerpts (SC-39)', () => {
    const text = 'keys: AKIAABCDEFGHIJKLMNOP and api_key=abcdefghijklmnop1234'
    const hits = scanSecrets(text)
    expect(hits.map((hit) => [hit.rule, hit.excerpt])).toEqual([
      ['aws-access-key-id', 'AKIA…'],
      ['env-assignment', 'api_…']
    ])
    expect(text.slice(hits[0]!.start, hits[0]!.end)).toBe('AKIAABCDEFGHIJKLMNOP')
    expect(text.slice(hits[1]!.start, hits[1]!.end)).toBe('api_key=abcdefghijklmnop1234')
  })

  test('matches every rule (SC-39)', () => {
    const samples: Record<string, string> = {
      'aws-access-key-id': 'AKIA0123456789ABCDEF',
      'github-token': `ghp_${'a'.repeat(36)}`,
      'stripe-key': 'sk_live_0123456789',
      'slack-token': 'xoxb-0123456789-abc',
      'private-key-header': '-----BEGIN OPENSSH PRIVATE KEY-----',
      'env-assignment': 'PASSWORD: s3cr3t/value+0123456'
    }
    for (const [rule, sample] of Object.entries(samples)) {
      const hits = scanSecrets(`before ${sample} after`)
      expect(hits.map((hit) => hit.rule as string)).toEqual([rule])
      expect(hits[0]!.excerpt).toBe(`${sample.slice(0, 4)}…`)
    }
  })

  test('accepts every variant of the token and header rules', () => {
    for (const prefix of ['ghp', 'gho', 'ghu', 'ghs', 'ghr']) {
      expect(scanSecrets(`${prefix}_${'A1'.repeat(18)}`)).toHaveLength(1)
    }
    for (const kind of ['b', 'a', 'p', 'r', 's']) expect(scanSecrets(`xox${kind}-abcdefghij`)).toHaveLength(1)
    for (const kind of ['RSA ', 'EC ', 'DSA ', 'OPENSSH ', 'PGP ', '']) {
      expect(scanSecrets(`-----BEGIN ${kind}PRIVATE KEY-----`)).toHaveLength(1)
    }
    expect(scanSecrets('-----BEGIN PGP PRIVATE KEY BLOCK-----')).toHaveLength(1)
    expect(scanSecrets('sk_test_abcdefghij')).toHaveLength(1)
    expect(scanSecrets('tokens = abcdefghijklmnopqrstuvwxyz')).toHaveLength(1)
  })

  test('ignores values that are too short or malformed', () => {
    expect(scanSecrets('AKIA1234')).toEqual([])
    expect(scanSecrets(`ghp_${'a'.repeat(35)}`)).toEqual([])
    expect(scanSecrets('sk_live_short')).toEqual([])
    expect(scanSecrets('xoxb-short')).toEqual([])
    expect(scanSecrets('password = short')).toEqual([])
    expect(scanSecrets('-----BEGIN CERTIFICATE-----')).toEqual([])
    expect(scanSecrets('ordinary prose about tokens and passwords')).toEqual([])
  })

  test('sorts hits found by different rules by position', () => {
    const text = `${'x'.repeat(5)} sk_test_abcdefghij ${'y'.repeat(3)} AKIA0123456789ABCDEF`
    expect(scanSecrets(text).map((hit) => hit.rule)).toEqual(['stripe-key', 'aws-access-key-id'])
  })

  test('is repeatable', () => {
    const text = 'AKIA0123456789ABCDEF'
    expect(scanSecrets(text)).toEqual(scanSecrets(text))
  })
})
