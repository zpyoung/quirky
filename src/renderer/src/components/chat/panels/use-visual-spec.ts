import { useEffect, useMemo, useState } from 'react'
import {
  readStructuredAgentSessionItem,
  supportsStructuredAgentSessionItemDetail
} from '@/runtime/structured-agent-session-client'
import type { RuntimeClientTarget } from '../../../../../shared/runtime-client-target'
import {
  loadVisualSpec,
  readCompleteVisualSpec,
  type VisualRenderItem,
  type VisualSpecState
} from './visual-spec-source'

const LOADING: VisualSpecState = { kind: 'loading' }

/** The validated spec of a visual item, fetching the whole item first when it arrived shortened. */
export function useVisualSpec(
  item: VisualRenderItem,
  scope: { target: RuntimeClientTarget; sessionId: string }
): VisualSpecState {
  const { target, sessionId } = scope
  const complete = useMemo(() => readCompleteVisualSpec(item), [item])
  const [fetched, setFetched] = useState<{ key: string; state: VisualSpecState } | null>(null)
  const key = `${item.itemId}:${item.revision}`
  const needsFetch = complete === null

  useEffect(() => {
    if (!needsFetch) {
      return
    }
    let live = true
    void loadVisualSpec(item, async () => {
      if (!(await supportsStructuredAgentSessionItemDetail(target))) {
        throw new Error('This host cannot send the whole visual. Update it to see this one.')
      }
      return readStructuredAgentSessionItem(target, sessionId, item.itemId)
    }).then((state) => {
      if (live) {
        setFetched({ key, state })
      }
    })
    return () => {
      live = false
    }
  }, [needsFetch, item, key, target, sessionId])

  if (complete !== null) {
    return complete
  }
  return fetched?.key === key ? fetched.state : LOADING
}
