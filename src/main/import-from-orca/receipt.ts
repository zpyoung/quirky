import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ImportFromOrcaMode } from '../../shared/import-from-orca-types'
import { RECEIPT_FILE } from './constants'

export type ImportReceiptRun = {
  at: string
  mode: ImportFromOrcaMode
  imported: Record<string, string[]>
  skippedSecrets: string[]
  secretsImported?: string[]
  /** Account folders and files this run copied, relative to their roots; absent in older receipts. */
  copiedFiles?: string[]
}

export type ImportReceipt = {
  version: 1
  sourceRoot: string
  runs: ImportReceiptRun[]
  /** Source id to the id Quirky minted, for the domains whose setters mint their own ids. */
  idMap?: Record<string, Record<string, string>>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
}

function isRun(value: unknown): value is ImportReceiptRun {
  return (
    isRecord(value) &&
    typeof value.at === 'string' &&
    isRecord(value.imported) &&
    Object.values(value.imported).every(isStringArray)
  )
}

function isIdMap(value: unknown): value is Record<string, Record<string, string>> {
  return (
    isRecord(value) &&
    Object.values(value).every(
      (inner) => isRecord(inner) && Object.values(inner).every((id) => typeof id === 'string')
    )
  )
}

export function receiptPath(userDataPath: string): string {
  return join(userDataPath, RECEIPT_FILE)
}

/** Reads the receipt, treating a missing or damaged file as no prior import. */
export function readReceipt(userDataPath: string, sourceRoot: string): ImportReceipt {
  const empty: ImportReceipt = { version: 1, sourceRoot, runs: [] }
  const path = receiptPath(userDataPath)
  if (!existsSync(path)) {
    return empty
  }
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (!isRecord(parsed) || parsed.version !== 1 || !Array.isArray(parsed.runs)) {
      return empty
    }
    return {
      version: 1,
      sourceRoot,
      runs: parsed.runs.filter(isRun),
      ...(isIdMap(parsed.idMap) ? { idMap: parsed.idMap } : {})
    }
  } catch {
    return empty
  }
}

/** Ids a previous run already brought over for `domain`. */
export function receiptIds(receipt: ImportReceipt, domain: string): Set<string> {
  return new Set(receipt.runs.flatMap((run) => run.imported[domain] ?? []))
}

export function receiptSecretSlots(receipt: ImportReceipt): Set<string> {
  return new Set(receipt.runs.flatMap((run) => run.secretsImported ?? []))
}

/** Folders and files a previous run copied, so a rerun never restores one the owner deleted. */
export function receiptCopiedFiles(receipt: ImportReceipt): Set<string> {
  return new Set(
    receipt.runs.flatMap((run) => (isStringArray(run.copiedFiles) ? run.copiedFiles : []))
  )
}
