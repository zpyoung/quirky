import { existsSync, readFileSync, rmSync } from 'node:fs'
import { InstallError } from '../types.ts'
import { tildePath, writeFileAtomic } from './common.ts'

/** A text file as lines, with what is needed to put it back together byte for byte. */
export type TextLines = { lines: string[]; eol: string; finalNewline: boolean }

export function splitText(text: string): TextLines {
  const finalNewline = text.endsWith('\n')
  const body = text.endsWith('\r\n') ? text.slice(0, -2) : finalNewline ? text.slice(0, -1) : text
  return { lines: text === '' ? [] : body.split(/\r?\n/), eol: text.includes('\r\n') ? '\r\n' : '\n', finalNewline }
}

export function joinText(parts: TextLines): string {
  return parts.lines.length === 0 ? '' : parts.lines.join(parts.eol) + (parts.finalNewline ? parts.eol : '')
}

export type Region = { start: number; end: number }

/**
 * The lines from a start marker to its end marker, both inclusive. A start marker with no end of
 * its own is skipped, so an interrupted write can't make a region swallow the user's lines below it.
 */
export function findRegion(lines: readonly string[], startMarker: string, endMarker: string): Region | null {
  let start = -1
  for (const [index, line] of lines.entries()) {
    const trimmed = line.trim()
    if (trimmed === startMarker) start = index
    else if (trimmed === endMarker && start !== -1) return { start, end: index }
  }
  return null
}

/** Appends `block` after the existing lines, set off by a blank line when `blankBefore`. */
export function appendBlock(parts: TextLines, block: string[], blankBefore: boolean): void {
  if (blankBefore && parts.lines.length > 0) parts.lines.push('')
  parts.lines.push(...block)
  parts.finalNewline = true
}

/** Removes a region and the one blank line install put above it. */
export function removeRegion(parts: TextLines, region: Region): void {
  const blankAbove = region.start > 0 && parts.lines[region.start - 1]!.trim() === ''
  parts.lines.splice(blankAbove ? region.start - 1 : region.start, region.end - region.start + 1 + (blankAbove ? 1 : 0))
}

/** The file's text, or null when it doesn't exist. Throws InstallError when it can't be read. */
export function readText(path: string, home: string): string | null {
  if (!existsSync(path)) return null
  try {
    const text = readFileSync(path, 'utf8')
    return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  } catch {
    throw new InstallError(`Could not read ${tildePath(path, home)}`)
  }
}

/**
 * Writes the edited text and reports whether the file changed. A file left with nothing in it is
 * deleted, which is how a file Quirky created goes away on remove.
 */
export function commitText(path: string, before: string | null, after: string): boolean {
  if (before === after) return false
  if (after.trim() === '') {
    if (before === null) return false
    rmSync(path, { force: true })
    return true
  }
  writeFileAtomic(path, after)
  return true
}

/**
 * `commitText` for an edit made on lines: a file whose lines are unchanged is left alone, so a
 * rerun doesn't normalize line endings the user chose.
 */
export function commitParts(path: string, before: string | null, original: TextLines, edited: TextLines): boolean {
  const same = original.finalNewline === edited.finalNewline && original.lines.length === edited.lines.length && original.lines.every((line, index) => line === edited.lines[index])
  return same ? false : commitText(path, before, joinText(edited))
}

export function snapshot(parts: TextLines): TextLines {
  return { ...parts, lines: [...parts.lines] }
}
