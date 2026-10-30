import { useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { CSSProperties } from 'react'
import type { ControlIconProps, FileIconProps, ProjectTileProps, ToolIconProps } from './contracts'
import { CONTROL_ICON_MARKUP } from './icons/generated-controls'
import { FILE_ICON_MARKUP } from './icons/generated-files'
import { TOOL_ICON_MARKUP } from './icons/generated-tools'
import { fileIconName } from './icons/file-icon-map'

const DEFAULT_SIZE = 16
const TILE_COUNT = 8
const STATUS_COLORS = ['#4cc38a', '#e5b454', '#ef6b73', '#7c8cff', '#1f9d63', '#c98a0b', '#d6455d', '#5b6cff']
const STATUS_TOKENS = ['--ui-working', '--ui-needs-you', '--ui-failing', '--ui-accent']

type VarStyle = CSSProperties & Record<`--${string}`, string>

const sizeVariable = (size: number | undefined): VarStyle | undefined => (size === undefined ? undefined : { '--ui-icon-box': `${size}px` })

function accessibility(label: string | undefined) {
  return label === undefined ? { 'aria-hidden': true as const } : { role: 'img' as const, 'aria-label': label }
}

/** The stand-in for a name with no icon: its first letter, so a bad registration is visible and harmless. */
function FallbackIcon({ name, size, label }: { name: string; size?: number; label?: string }) {
  const letter = Array.from(name.trim())[0] ?? '?'
  return <span className="ui-icon-fallback" style={sizeVariable(size)} {...accessibility(label)}>{letter}</span>
}

function Glyph({ markup, viewBox, size, label, className, style, ...data }: {
  markup: string
  viewBox: string
  size: number
  label?: string
  className: string
  style?: CSSProperties
  'data-icon'?: string
  'data-flavor'?: string
}) {
  return (
    <svg
      {...data}
      className={className}
      viewBox={viewBox}
      width={size}
      height={size}
      fill="currentColor"
      style={style}
      {...accessibility(label)}
      dangerouslySetInnerHTML={{ __html: markup }}
    />
  )
}

/**
 * A tool's Phosphor Duotone mark, colored by the `--ui-hue-<hue>` token. A name outside the generated
 * set draws its first letter in the muted color instead of throwing.
 */
export function ToolIcon({ name, hue, size, label }: ToolIconProps) {
  if (!Object.hasOwn(TOOL_ICON_MARKUP, name)) return <FallbackIcon name={name} size={size} label={label} />
  return (
    <Glyph
      className="ui-tool-icon"
      markup={TOOL_ICON_MARKUP[name as keyof typeof TOOL_ICON_MARKUP]}
      viewBox="0 0 256 256"
      size={size ?? DEFAULT_SIZE}
      label={label}
      style={{ color: `var(--ui-hue-${hue})` }}
    />
  )
}

/** A control glyph (carets, search, plus) in Phosphor Regular, drawn in the surrounding text color. */
export function ControlIcon({ name, size, label }: ControlIconProps) {
  if (!Object.hasOwn(CONTROL_ICON_MARKUP, name)) return <FallbackIcon name={name} size={size} label={label} />
  return (
    <Glyph
      className="ui-control-icon"
      markup={CONTROL_ICON_MARKUP[name as keyof typeof CONTROL_ICON_MARKUP]}
      viewBox="0 0 256 256"
      size={size ?? DEFAULT_SIZE}
      label={label}
    />
  )
}

type Flavor = 'mocha' | 'latte'

let themeVersion = 0
const themeListeners = new Set<() => void>()
let themeObserver: MutationObserver | null = null

function subscribeToTheme(listener: () => void): () => void {
  if (typeof MutationObserver === 'undefined' || typeof document === 'undefined') return () => {}
  if (themeListeners.size === 0) {
    themeObserver = new MutationObserver(() => {
      themeVersion += 1
      for (const notify of themeListeners) notify()
    })
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'], subtree: true })
  }
  themeListeners.add(listener)
  return () => {
    themeListeners.delete(listener)
    if (themeListeners.size === 0) {
      themeObserver?.disconnect()
      themeObserver = null
    }
  }
}

const themeSnapshot = () => themeVersion

function flavorOf(element: Element | null): Flavor {
  return element?.closest('[data-theme]')?.getAttribute('data-theme') === 'light' ? 'latte' : 'mocha'
}

/**
 * A file's Catppuccin icon, Mocha under a dark theme and Latte under a light one. The flavor comes
 * from the nearest `data-theme` ancestor and updates in place when it changes.
 */
export function FileIcon({ path, size, label }: FileIconProps) {
  const ref = useRef<SVGSVGElement>(null)
  const [flavor, setFlavor] = useState<Flavor>('mocha')
  const version = useSyncExternalStore(subscribeToTheme, themeSnapshot, themeSnapshot)
  useLayoutEffect(() => {
    setFlavor(flavorOf(ref.current))
  }, [version])
  const name = fileIconName(path)
  return (
    <svg
      ref={ref}
      className="ui-file-icon"
      viewBox="0 0 16 16"
      width={size ?? DEFAULT_SIZE}
      height={size ?? DEFAULT_SIZE}
      data-icon={name}
      data-flavor={flavor}
      {...accessibility(label)}
      dangerouslySetInnerHTML={{ __html: FILE_ICON_MARKUP[flavor][name] }}
    />
  )
}

function tileLetters(name: string): string {
  const words = name.split(/[-_\s]+/).filter(Boolean)
  const letters = words.length >= 2 ? [Array.from(words[0]!)[0]!, Array.from(words[1]!)[0]!] : Array.from(words[0] ?? '').slice(0, 2)
  return letters.length === 0 ? '?' : letters.join('').toUpperCase()
}

function tileIndex(name: string): number {
  let hash = 0x811c9dc5
  for (const unit of name) {
    hash ^= unit.codePointAt(0)!
    hash = Math.imul(hash, 0x01000193)
  }
  return ((hash >>> 0) % TILE_COUNT) + 1
}

function isStatusColor(color: string): boolean {
  const normalized = color.trim().toLowerCase()
  if (STATUS_COLORS.includes(normalized)) return true
  if (typeof document === 'undefined') return false
  const root = document.documentElement
  const computed = typeof getComputedStyle === 'function' ? getComputedStyle(root) : null
  return STATUS_TOKENS.some((token) => {
    const live = (root.style.getPropertyValue(token) || computed?.getPropertyValue(token) || '').trim().toLowerCase()
    return live !== '' && live === normalized
  })
}

/**
 * A project's two-letter colored tile. A project's own `color` is used unless it equals a status
 * color, which would read as status; then (and with no color) one of the eight tile tokens is chosen
 * from a stable hash of the name.
 */
export function ProjectTile({ name, color, size, label }: ProjectTileProps) {
  const own = typeof color === 'string' && color.trim() !== '' && !isStatusColor(color) ? color.trim() : null
  const style: VarStyle = { background: own ?? `var(--ui-tile-${tileIndex(name)})`, ...(size === undefined ? null : { '--ui-tile-size': `${size}px` }) }
  return <span className="ui-project-tile" style={style} {...accessibility(label)}>{tileLetters(name)}</span>
}
