import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { QUIRKYD_VERSION, quirkydArtifactFilenames } from '../../src/shared/quirkyd-artifacts.ts'
import { readQuirkydMobileWebAssetFilenames } from './quirkyd-mobile-web-bundle.mjs'

/** The runtime enters through `.runtime-node`'s executableSha256 string, never its bytes (design D2). */
export function computeQuirkydFullVersion(artifactDir, { target, agentBrowserFilename }) {
  const hash = createHash('sha256')
  for (const filename of quirkydArtifactFilenames(
    target,
    readQuirkydMobileWebAssetFilenames(artifactDir)
  )) {
    const artifactPath = join(artifactDir, filename)
    if (!existsSync(artifactPath)) {
      throw new Error(
        `quirkyd declares ${filename} in QUIRKYD_ARTIFACTS but never emitted it. Add the build ` +
          'step, or drop it from src/shared/quirkyd-artifacts.ts.'
      )
    }
    hash.update(readFileSync(artifactPath))
  }
  if (agentBrowserFilename && existsSync(join(artifactDir, agentBrowserFilename))) {
    hash.update(readFileSync(join(artifactDir, agentBrowserFilename)))
  }
  return `${QUIRKYD_VERSION}+${hash.digest('hex').slice(0, 12)}`
}
