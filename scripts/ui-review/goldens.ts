import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { THEMES, type CaptureTheme, type ImageEvidence } from './contracts'

export const VIEWPORT = { width: 1400, height: 880 } as const
export const DEVICE_SCALE_FACTOR = 2
export const SCREENSHOT_SIZE = { width: VIEWPORT.width * DEVICE_SCALE_FACTOR, height: VIEWPORT.height * DEVICE_SCALE_FACTOR } as const
export const GOLDEN_ROOT = 'docs/quirk/specs/2026-10-30-ui-pycharm-shell/img'

const GOLDEN_KINDS = ['shell', 'scoped', 'popups'] as const
type GoldenKind = typeof GOLDEN_KINDS[number]
export type GoldenReferences = Record<GoldenKind, Record<CaptureTheme, ImageEvidence>>

const DEFAULT_REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url))
const KIND_BY_TARGET: Record<string, GoldenKind | undefined> = {
  'host:scoped': 'scoped',
  'host:popups': 'popups'
}

/** Width and height from a PNG's IHDR, or null when the bytes are not a PNG. */
export function pngDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 24 || bytes[0] !== 0x89 || bytes[1] !== 0x50 || bytes[2] !== 0x4e || bytes[3] !== 0x47) return null
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return { width: view.getUint32(16), height: view.getUint32(20) }
}

/** Absolute path of the approved golden a target is scored against: shell by default, scoped and popups for their host targets. */
export function goldenFor(targetId: string, theme: CaptureTheme, repoRoot: string = DEFAULT_REPO_ROOT): string {
  return goldenPath(KIND_BY_TARGET[targetId] ?? 'shell', theme, repoRoot)
}

function goldenPath(kind: GoldenKind, theme: CaptureTheme, repoRoot: string): string {
  return join(repoRoot, GOLDEN_ROOT, `golden-${kind}-${theme}.png`)
}

/**
 * Reads every approved golden under `repoRoot` and returns its path and digest.
 * Throws naming the file when one is missing or is not exactly the screenshot size.
 */
export function loadGoldenReferences(repoRoot: string): GoldenReferences {
  const references = {} as GoldenReferences
  for (const kind of GOLDEN_KINDS) {
    references[kind] = {} as Record<CaptureTheme, ImageEvidence>
    for (const theme of THEMES) {
      const path = goldenPath(kind, theme, repoRoot)
      if (!existsSync(path) || !statSync(path).isFile()) throw new Error(`approved ${kind} ${theme} golden PNG is missing: ${path}`)
      const bytes = readFileSync(path)
      const dimensions = pngDimensions(bytes)
      if (!dimensions || dimensions.width !== SCREENSHOT_SIZE.width || dimensions.height !== SCREENSHOT_SIZE.height) {
        const actual = dimensions ? `${dimensions.width}x${dimensions.height}` : 'not a PNG'
        throw new Error(`approved golden ${path} is ${actual}; expected ${SCREENSHOT_SIZE.width}x${SCREENSHOT_SIZE.height}`)
      }
      references[kind][theme] = { path, sha256: createHash('sha256').update(bytes).digest('hex') }
    }
  }
  return references
}

/** The loaded golden evidence a target's capture is scored against in `theme`. */
export function referenceFor(references: GoldenReferences, targetId: string, theme: CaptureTheme): ImageEvidence {
  return references[KIND_BY_TARGET[targetId] ?? 'shell'][theme]
}
