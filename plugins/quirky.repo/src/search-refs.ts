import { GitError, gitApi } from '@quirky/git'
import type { Env } from './env'

type SearchRefsParams = { repo: string; query: string; limit?: number }

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200

export async function searchRefs(env: Env, params: SearchRefsParams) {
  if (typeof params.repo !== 'string') throw env.fail('invalid-params', 'repo must be a string')
  if (typeof params.query !== 'string') throw env.fail('invalid-params', 'query must be a string')
  if (params.query.length > 200) throw env.fail('invalid-params', 'query must be at most 200 characters')
  const query = params.query.trim()
  if (query.length === 0) throw env.fail('invalid-params', 'query must not be empty')

  const limit = params.limit === undefined ? DEFAULT_LIMIT : params.limit
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw env.fail('invalid-params', 'limit must be an integer from 1 to 200')
  }

  const repo = env.resolve(params.repo)
  if (repo.kind !== 'git') throw env.fail('invalid-params', `${repo.name} is not a Git repository`, { reason: 'not-git' })

  try {
    return await gitApi().searchRefs(repo.path, query, limit)
  } catch (error) {
    if (!(error instanceof GitError)) throw error
    const detail = error.stderr.trim().split(/\r?\n/).at(-1) || error.message
    throw env.fail('invalid-params', `could not read refs of ${repo.name}: ${detail}`)
  }
}
