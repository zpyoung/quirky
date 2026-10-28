import type { ItemKind } from '../contracts'

export type SearchPlan = { query: string; repositories: string[] }

function queryTokens(value: string): string[] {
  const tokens: string[] = []
  let start = -1
  let quoted = false
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!
    if (start < 0) {
      if (/\s/u.test(character)) continue
      start = index
    }
    if (character === '\\') {
      index += 1
      continue
    }
    if (character === '"') quoted = !quoted
    if (!quoted && /\s/u.test(character)) {
      tokens.push(value.slice(start, index))
      start = -1
    }
  }
  if (start >= 0) tokens.push(value.slice(start))
  return tokens
}

function repoIdentity(value: string): string {
  const normalized = value.replace(/^github\.com\//iu, '').toLowerCase()
  const parts = normalized.split('/')
  if (parts.length !== 2 || parts.some((part) => part.length === 0)) throw new Error(`invalid repo qualifier: ${value}`)
  return `${parts[0]}/${parts[1]}`
}

/** Removes kind and repo qualifiers before fanning a safe, kind-specific query across repos. */
export function planSearch(value: string, kind: ItemKind): SearchPlan {
  if (new TextEncoder().encode(value).byteLength > 8192) throw new Error('Search query exceeds the 8192-byte limit.')
  const repositories: string[] = []
  const remaining: string[] = []
  for (const token of queryTokens(value)) {
    const separator = token.indexOf(':')
    if (separator < 0) {
      remaining.push(token)
      continue
    }
    const qualifier = token.slice(0, separator).toLowerCase()
    const argument = token.slice(separator + 1)
    if (qualifier === 'repo') {
      repositories.push(repoIdentity(argument))
      continue
    }
    if (qualifier === 'is' && (argument.toLowerCase() === 'issue' || argument.toLowerCase() === 'pr')) continue
    if (kind === 'issue' && ((qualifier === 'is' && ['merged', 'draft'].includes(argument.toLowerCase())) || qualifier === 'review-requested' || qualifier === 'reviewed-by')) continue
    remaining.push(token)
  }
  return { query: remaining.join(' ').trim(), repositories }
}

/** Removes the previous list kind and fields unavailable to the selected list without adding search bytes. */
export function queryForKind(value: string, kind: ItemKind): string {
  const plan = planSearch(value, kind)
  return [plan.query, ...plan.repositories.map((repo) => `repo:${repo}`)].join(' ').trim()
}
