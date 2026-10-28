import type { SecretHit, SecretRule } from './types'

const RULES: { rule: SecretRule; pattern: RegExp }[] = [
  { rule: 'aws-access-key-id', pattern: /AKIA[0-9A-Z]{16}/g },
  { rule: 'github-token', pattern: /gh[pousr]_[A-Za-z0-9]{36,255}/g },
  { rule: 'stripe-key', pattern: /sk_(?:live|test)_[A-Za-z0-9]{10,}/g },
  { rule: 'slack-token', pattern: /xox[baprs]-[A-Za-z0-9-]{10,}/g },
  { rule: 'private-key-header', pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY(?: BLOCK)?-----/g },
  {
    rule: 'env-assignment',
    pattern: /(?:api_key|secret|token|password|passwd|credential)s?\s*[=:]\s*[A-Za-z0-9_/+=-]{16,}/gi
  }
]

/**
 * Finds likely secrets in `text`, sorted by position. Hits are advisory: the excerpt is the
 * first four characters, never the whole value.
 */
export function scanSecrets(text: string): SecretHit[] {
  const hits: SecretHit[] = []
  for (const { rule, pattern } of RULES) {
    for (const match of text.matchAll(pattern)) {
      const start = match.index
      hits.push({ rule, start, end: start + match[0].length, excerpt: `${match[0].slice(0, 4)}…` })
    }
  }
  return hits.sort((a, b) => a.start - b.start)
}
