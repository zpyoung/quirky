import type { MobileBundleRoute } from '../src/contracts'
import { PAGE_BUNDLE_ROUTES } from '../src/shell/generation'

export function bundleRoutesFixture(): MobileBundleRoute[] {
  return PAGE_BUNDLE_ROUTES.map(({ kind, path, grants }) => ({
    kind,
    path,
    grants: [...grants]
  }))
}
