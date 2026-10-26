import { isAbsolute, resolve } from 'node:path'
import type { Repo } from '@quirky/protocol'
import { contains, pathForms } from './paths'

/** A selector that cannot be evaluated at all, as opposed to one that matches nothing. */
export class SelectorSyntaxError extends Error {}

/** The repo with the longest path containing `path`, comparing real and literal paths. */
function innermost(repos: Repo[], path: string): Repo[] {
  const targets = pathForms(resolve(path))
  let best: { repo: Repo; length: number } | null = null
  for (const repo of repos) {
    for (const form of pathForms(repo.path)) {
      if (targets.some((target) => contains(form, target)) && (!best || form.length > best.length)) {
        best = { repo, length: form.length }
      }
    }
  }
  return best ? [best.repo] : []
}

/**
 * The repos a selector names: `id:<id>`, `name:<name>`, `path:<path>` (the repo containing the
 * path), or a bare value matched as an exact ID first and a name second. Throws
 * SelectorSyntaxError for an empty selector or value, or a relative `path:`.
 */
export function matchRepos(repos: Repo[], selector: string): Repo[] {
  const text = selector.trim()
  if (text === '') throw new SelectorSyntaxError('selector must not be empty')
  const prefixed = /^(id|name|path):(.*)$/s.exec(text)
  if (!prefixed) {
    const byId = repos.filter((repo) => repo.id === text)
    return byId.length > 0 ? byId : repos.filter((repo) => repo.name === text)
  }
  const [, form, value] = prefixed
  if (value === '') throw new SelectorSyntaxError(`${form}: needs a value`)
  if (form === 'id') return repos.filter((repo) => repo.id === value)
  if (form === 'name') return repos.filter((repo) => repo.name === value)
  if (!isAbsolute(value!)) throw new SelectorSyntaxError('path: needs an absolute path')
  return innermost(repos, value!)
}
