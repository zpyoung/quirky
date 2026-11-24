/**
 * A second quirkyd template that differs from the first only in its build identity, so a relaunch
 * with it stands in for an app update that bundles a newer quirkyd.
 */
import { createHash } from 'node:crypto'
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import {
  QUIRKYD_TEMPLATE_MANIFEST_FILENAME,
  QUIRKYD_VERSION
} from '../../../src/shared/quirkyd-artifacts'

const ENTRY = 'quirkyd.js'

/** Rewrites `templateDir` in place; its manifest keeps verifying. */
export function makeQuirkydTemplateVariant(templateDir: string, tag: string): void {
  const entry = path.join(templateDir, ENTRY)
  appendFileSync(entry, `\n// quirkyd e2e template variant ${tag}\n`)
  const manifestPath = path.join(templateDir, QUIRKYD_TEMPLATE_MANIFEST_FILENAME)
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  manifest.commonSha256[ENTRY] = createHash('sha256').update(readFileSync(entry)).digest('hex')
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
}

/** The host's activation record, read the way a client reads it. */
export function readHostQuirkydActivation(exec: (command: string) => string): {
  active?: string
  previous?: string
  activeAppVersion?: string
} {
  return JSON.parse(exec('cat "$HOME/.quirky-remote/quirkyd-active.json"'))
}

export function isQuirkydFullVersion(value: unknown): boolean {
  return typeof value === 'string' && value.startsWith(`${QUIRKYD_VERSION}+`)
}
