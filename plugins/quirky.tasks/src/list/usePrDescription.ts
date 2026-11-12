import { useCallback, useEffect, useRef, useState } from 'react'
import type { UiPluginContext } from '@quirky/protocol'
import { errorMessage, object, type ListItem } from './model'

export type PrDescription = { body: string; loading: boolean; error: string | null; retry(): void }

type DescriptionTarget = { worktree: string; number: number; url: string }
type DescriptionRead = DescriptionTarget & { body: string; loading: boolean; error: string | null }

function sameTarget(left: DescriptionTarget | null, right: DescriptionTarget): boolean {
  return left !== null && left.worktree === right.worktree && left.number === right.number && left.url === right.url
}

/** Reads an on-page pull request's description without retaining one PR's result for another. */
export function usePrDescription(context: UiPluginContext, item: ListItem | null): PrDescription {
  const pullRequest = item?.kind === 'pullRequest' ? item : null
  const isPullRequest = pullRequest !== null
  const worktree = pullRequest?.worktree ?? ''
  const number = pullRequest?.number ?? 0
  const url = pullRequest?.url ?? ''
  const itemBody = pullRequest?.body ?? ''
  const [attempt, setAttempt] = useState(0)
  const [read, setRead] = useState<DescriptionRead | null>(null)
  const generation = useRef(0)
  const currentTarget = useRef<DescriptionTarget | null>(null)
  const target = isPullRequest ? { worktree, number, url } : null
  currentTarget.current = target
  const retry = useCallback(() => {
    const current = currentTarget.current
    if (!isPullRequest || itemBody !== '' || !sameTarget(current, { worktree, number, url })) return
    setAttempt((value) => value + 1)
  }, [isPullRequest, itemBody, number, url, worktree])

  useEffect(() => {
    if (!isPullRequest || itemBody !== '') return
    const request = ++generation.current
    let active = true
    const requestTarget = { worktree, number, url }
    setRead({ ...requestTarget, body: '', loading: true, error: null })
    void context.call('quirky.hosting/workItem', {
      worktree,
      number,
      kind: 'pullRequest',
      reference: url
    }).then((value) => {
      if (!active || generation.current !== request || !sameTarget(currentTarget.current, requestTarget)) return
      const result = object(value)
      if (!result || typeof result.body !== 'string') throw new Error('The pull request description is unavailable.')
      setRead({ ...requestTarget, body: result.body, loading: false, error: null })
    }).catch((error: unknown) => {
      if (!active || generation.current !== request || !sameTarget(currentTarget.current, requestTarget)) return
      setRead({ ...requestTarget, body: '', loading: false, error: errorMessage(error) })
    })
    return () => {
      active = false
      if (generation.current === request) generation.current += 1
    }
  }, [attempt, context, isPullRequest, itemBody, number, url, worktree])

  if (!target) return { body: '', loading: false, error: null, retry }
  if (itemBody !== '') return { body: itemBody, loading: false, error: null, retry }
  if (read !== null && sameTarget(read, target)) {
    return { body: read.body, loading: read.loading, error: read.error, retry }
  }
  return { body: '', loading: true, error: null, retry }
}
