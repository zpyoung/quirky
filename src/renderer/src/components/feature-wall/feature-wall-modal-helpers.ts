import type { FeatureWallOpenSource } from '../../../../shared/add-repo-source'
export { usePrefersReducedMotion } from '@/hooks/usePrefersReducedMotion'

export function getFeatureWallOpenSource(
  modalData: Record<string, unknown>
): FeatureWallOpenSource {
  const source = modalData.source
  return source === 'help_menu' || source === 'popup' || source === 'onboarding'
    ? source
    : 'unknown'
}
