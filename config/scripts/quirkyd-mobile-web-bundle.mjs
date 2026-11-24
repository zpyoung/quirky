import { cpSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import {
  QUIRKYD_MOBILE_WEB_DIR,
  QUIRKYD_MOBILE_WEB_MANIFEST,
  quirkydMobileWebAssetFilenames
} from '../../src/shared/quirkyd-artifacts.ts'

const { MOBILE_WEB_BUNDLE_DIR, assertMobileWebBundleBuilt } = createRequire(import.meta.url)(
  './verify-packaged-mobile-web-bundle.cjs'
)
const { assertNoDarkOutputOfOffSwitches } = createRequire(import.meta.url)(
  '../dark-build-switches.cjs'
)

/**
 * The built page (pnpm build:mobile-web) into an quirkyd package. Fatal when it is missing or stale,
 * as electron-builder's beforePack is: a server without it serves phones no page.
 */
export function stageQuirkydMobileWebBundle(outputDir, bundleDir = MOBILE_WEB_BUNDLE_DIR) {
  // The release template refuses the variable itself.
  assertNoDarkOutputOfOffSwitches([bundleDir])
  assertMobileWebBundleBuilt(bundleDir)
  // The guard refuses unlisted files, so the tree is the manifest, its assets and a dark marker.
  cpSync(bundleDir, join(outputDir, ...QUIRKYD_MOBILE_WEB_DIR.split('/')), { recursive: true })
}

/** The asset half of a package's artifact list, read from the page it carries. */
export function readQuirkydMobileWebAssetFilenames(packageDir) {
  return quirkydMobileWebAssetFilenames(
    readFileSync(join(packageDir, ...QUIRKYD_MOBILE_WEB_MANIFEST.split('/')), 'utf8')
  )
}
