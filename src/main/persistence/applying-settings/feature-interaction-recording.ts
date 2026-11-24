import type { PersistedState } from '../../../shared/persisted-state-types'
import {
  normalizeFeatureInteractions,
  type FeatureInteractionId
} from '../../../shared/feature-interactions'

export type FeatureInteractionOperations = {
  state: PersistedState
  scheduleSave: (domains?: readonly string[]) => void
  notifyUIChanged: () => void
  getUI: () => PersistedState['ui']
}

export function recordFeatureInteraction(
  operations: FeatureInteractionOperations,
  id: FeatureInteractionId
): PersistedState['ui'] {
  const featureInteractions = normalizeFeatureInteractions(operations.state.ui?.featureInteractions)
  const existing = featureInteractions[id]
  const previousCount = existing?.interactionCount ?? 0
  const nextCount = previousCount + 1

  operations.state.ui = {
    ...operations.state.ui,
    featureInteractions: {
      ...featureInteractions,
      [id]: {
        firstInteractedAt: existing?.firstInteractedAt ?? Date.now(),
        interactionCount: nextCount
      }
    }
  }
  operations.scheduleSave(['ui'])
  // Why: live UI only consumes the seen transition; count-only updates must not re-hydrate the renderer.
  if (!existing) {
    operations.notifyUIChanged()
  }

  return operations.getUI()
}
