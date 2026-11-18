import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Page } from 'playwright'
import { captureApplication } from './capture'
import { captureBrowserExecutable } from './browser'
import { DEVICE_SCALE_FACTOR, pngDimensions, SCREENSHOT_SIZE } from './goldens'
import type { CaptureTheme } from './contracts'
import { hostContractContext } from './host-contracts'

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))
const targetId = 'view:quirky.automations/automations'
const toolId = 'sidebar-section:quirky.automations/automations'
const tokenCss = readFileSync(new URL('../../packages/ui/src/design-system/tokens.css', import.meta.url), 'utf8')
const darkTokenBlock = tokenCss.match(/:root,\s*\[data-theme='dark'\]\s*\{([\s\S]*?)\n\}/)?.[1]
const lightTokenBlock = tokenCss.match(/\[data-theme='light'\]\s*\{([\s\S]*?)\n\}/)?.[1]

if (!darkTokenBlock || !lightTokenBlock) throw new Error('Could not read dark and light UI token blocks')

const parseDeclarations = (block: string): Map<string, string> => {
  const declarations = new Map<string, string>()
  for (const match of block.matchAll(/--(ui-[a-z0-9-]+)\s*:\s*([^;]+);/g)) {
    declarations.set(match[1], match[2].trim())
  }
  return declarations
}

const darkTokens = parseDeclarations(darkTokenBlock)
const lightTokens = new Map([...darkTokens, ...parseDeclarations(lightTokenBlock)])

type FrameTokens = {
  rail: string
  surface: string
  selected: string
  cardGapCss: number
  radiusCss: number
  toolRailCss: number
  workspaceTop: number
  workspaceBottom: number
}

function cssLengthPx(name: string, values: Map<string, string>, resolving = new Set<string>()): number {
  if (resolving.has(name)) throw new Error(`Circular CSS token reference: ${name}`)
  const raw = values.get(name)
  if (!raw) throw new Error(`Missing CSS token --${name}`)
  resolving.add(name)
  const expression = raw.startsWith('calc(') && raw.endsWith(')') ? raw.slice(5, -1) : raw
  let total = 0
  for (const term of expression.split('+').map((part) => part.trim())) {
    const reference = term.match(/^var\(\s*--(ui-[a-z0-9-]+)\s*\)$/)
    if (reference) {
      total += cssLengthPx(reference[1], values, resolving)
      continue
    }
    const length = term.match(/^(\d+(?:\.\d+)?)px$/)
    if (!length) throw new Error(`Unsupported CSS length token --${name}: ${raw}`)
    total += Number(length[1])
  }
  resolving.delete(name)
  return total
}

function frameTokens(theme: CaptureTheme): FrameTokens {
  const values = theme === 'dark' ? darkTokens : lightTokens
  const rail = values.get('ui-rail')
  const surface = values.get('ui-surface')
  const selected = values.get('ui-selected')
  if (!rail || !surface || !selected) throw new Error(`Missing frame color token for ${theme}`)
  const scale = DEVICE_SCALE_FACTOR
  const windowBarCss = cssLengthPx('ui-window-bar-height', values)
  const statusBarCss = cssLengthPx('ui-row-single', values)
  const cardGapCss = cssLengthPx('ui-card-gap', values)
  const radiusCss = cssLengthPx('ui-radius-window', values)
  const toolRailCss = cssLengthPx('ui-tool-rail-width', values)
  return {
    rail,
    surface,
    selected,
    cardGapCss,
    radiusCss,
    toolRailCss,
    workspaceTop: windowBarCss * scale,
    workspaceBottom: SCREENSHOT_SIZE.height - statusBarCss * scale - 1,
  }
}

type CardName = 'left-top' | 'left-bottom' | 'main' | `card-${number}`
type CardFrame = { name: CardName; x1: number; x2: number; y1: number; y2: number }
type GapFrame = { start: number; end: number; width: number }
type CornerFrame = { card: CardName; corner: string; firstSurfaceOffset: number | null; radiusCss: number | null }
type FrameMeasurement = {
  cards: CardFrame[]
  sideGap: GapFrame | null
  stackedGap: GapFrame | null
  corners: CornerFrame[]
  railColumns: { start: number; end: number }[]
  railRows: { start: number; end: number }[]
  tokens: FrameTokens
}

type Rgb = readonly [number, number, number]
const MATCH_TOLERANCE = 2
const CARD_SCAN_END_INSET = 24
const CORNER_NAMES = ['top-left', 'top-right', 'bottom-left', 'bottom-right'] as const

function colorRgb(hex: string): Rgb {
  const match = hex.match(/^#([0-9a-f]{6})$/i)
  if (!match) throw new Error(`Expected a six-digit hex color, got ${hex}`)
  const value = Number.parseInt(match[1], 16)
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff]
}

function colorMatches(rgba: Uint8ClampedArray, x: number, y: number, color: Rgb): boolean {
  const index = (y * SCREENSHOT_SIZE.width + x) * 4
  return Math.abs(rgba[index] - color[0]) <= MATCH_TOLERANCE &&
    Math.abs(rgba[index + 1] - color[1]) <= MATCH_TOLERANCE &&
    Math.abs(rgba[index + 2] - color[2]) <= MATCH_TOLERANCE
}

function pixelHex(rgba: Uint8ClampedArray, x: number, y: number): string {
  const index = (y * SCREENSHOT_SIZE.width + x) * 4
  return `#${[rgba[index], rgba[index + 1], rgba[index + 2]].map((channel) => channel.toString(16).padStart(2, '0')).join('')}`
}

function segments(length: number, qualifies: (index: number) => boolean): { start: number; end: number }[] {
  const found: { start: number; end: number }[] = []
  let start = -1
  for (let index = 0; index < length; index++) {
    if (qualifies(index)) {
      if (start < 0) start = index
    } else if (start >= 0) {
      found.push({ start, end: index - 1 })
      start = -1
    }
  }
  if (start >= 0) found.push({ start, end: length - 1 })
  return found
}

function rowMatchesColor(rgba: Uint8ClampedArray, y: number, x1: number, x2: number, color: Rgb): boolean {
  const width = x2 - x1 + 1
  if (width <= 0) return false
  let matches = 0
  for (let x = x1; x <= x2; x++) if (colorMatches(rgba, x, y, color)) matches++
  return matches / width >= 0.95
}

function columnMatchesColor(rgba: Uint8ClampedArray, x: number, y1: number, y2: number, color: Rgb): boolean {
  const height = y2 - y1 + 1
  if (height <= 0) return false
  let matches = 0
  for (let y = y1; y <= y2; y++) if (colorMatches(rgba, x, y, color)) matches++
  return matches / height >= 0.95
}

function cornerPoint(card: CardFrame, corner: typeof CORNER_NAMES[number], offset: number): [number, number] {
  const x = corner.endsWith('left') ? card.x1 + offset : card.x2 - offset
  const y = corner.startsWith('top') ? card.y1 + offset : card.y2 - offset
  return [x, y]
}

function measureCorner(rgba: Uint8ClampedArray, card: CardFrame, corner: typeof CORNER_NAMES[number], tokens: FrameTokens): CornerFrame {
  const surface = colorRgb(tokens.surface)
  const maxOffset = Math.min(card.x2 - card.x1, card.y2 - card.y1, tokens.radiusCss * DEVICE_SCALE_FACTOR * 2 + 8)
  let firstSurfaceOffset: number | null = null
  for (let offset = 0; offset <= maxOffset; offset++) {
    const [x, y] = cornerPoint(card, corner, offset)
    if (colorMatches(rgba, x, y, surface)) {
      firstSurfaceOffset = offset
      break
    }
  }
  const radiusCss = firstSurfaceOffset === null
    ? null
    : Math.round(firstSurfaceOffset / (1 - 1 / Math.sqrt(2)) / DEVICE_SCALE_FACTOR)
  return { card: card.name, corner, firstSurfaceOffset, radiusCss }
}

function measureFrame(rgba: Uint8ClampedArray, theme: CaptureTheme): FrameMeasurement {
  const tokens = frameTokens(theme)
  const rail = colorRgb(tokens.rail)
  const bandTop = tokens.workspaceTop
  const bandBottom = tokens.workspaceBottom
  const sampleTop = bandTop + CARD_SCAN_END_INSET
  const sampleBottom = bandBottom - CARD_SCAN_END_INSET
  const toolRailWidth = tokens.toolRailCss * DEVICE_SCALE_FACTOR
  const cardColumns = segments(SCREENSHOT_SIZE.width, (x) =>
    x >= toolRailWidth && x < SCREENSHOT_SIZE.width - toolRailWidth &&
    !columnMatchesColor(rgba, x, sampleTop, sampleBottom, rail))
    .filter((run) => run.end - run.start + 1 > CARD_SCAN_END_INSET * 2)
  const railColumns = segments(SCREENSHOT_SIZE.width, (x) => columnMatchesColor(rgba, x, sampleTop, sampleBottom, rail))
  const verticalCards = cardColumns.map((column) => {
    const x1 = column.start + CARD_SCAN_END_INSET
    const x2 = column.end - CARD_SCAN_END_INSET
    const cardRows = segments(SCREENSHOT_SIZE.height, (y) =>
      y >= bandTop && y <= bandBottom && !rowMatchesColor(rgba, y, x1, x2, rail))
      .filter((run) => run.end - run.start + 1 > 20)
    return cardRows.map((row) => ({ x1: column.start, x2: column.end, y1: row.start, y2: row.end }))
  })

  const rectangles = verticalCards.flat()
  const cards = rectangles.map((rect, index): CardFrame => ({
    ...rect,
    name: (['left-top', 'left-bottom', 'main'][index] ?? `card-${index + 1}`) as CardName
  }))
  const leftTop = cards.find((card) => card.name === 'left-top')
  const leftBottom = cards.find((card) => card.name === 'left-bottom')
  const main = cards.find((card) => card.name === 'main')
  const sideRail = leftTop && main
    ? railColumns.find((run) => run.start > leftTop.x2 && run.end < main.x1)
    : undefined
  const sideGap = leftTop && main
    ? {
        start: sideRail?.start ?? leftTop.x2 + 1,
        end: sideRail?.end ?? main.x1 - 1,
        width: sideRail ? sideRail.end - sideRail.start + 1 : main.x1 - leftTop.x2 - 1
      }
    : null
  const railRows = leftTop
    ? segments(SCREENSHOT_SIZE.height, (y) =>
        y >= bandTop && y <= bandBottom && rowMatchesColor(rgba, y, leftTop.x1 + CARD_SCAN_END_INSET, leftTop.x2 - CARD_SCAN_END_INSET, rail))
    : []
  const stackRail = leftTop && leftBottom
    ? railRows.find((run) => run.start > leftTop.y2 && run.end < leftBottom.y1)
    : undefined
  const stackedGap = leftTop && leftBottom
    ? {
        start: stackRail?.start ?? leftTop.y2 + 1,
        end: stackRail?.end ?? leftBottom.y1 - 1,
        width: stackRail ? stackRail.end - stackRail.start + 1 : leftBottom.y1 - leftTop.y2 - 1
      }
    : null
  const corners = cards.length === 3
    ? cards.flatMap((card) => CORNER_NAMES.map((corner) => measureCorner(rgba, card, corner, tokens)))
    : []
  return { cards, sideGap, stackedGap, corners, railColumns, railRows, tokens }
}

function longestRailRun(
  rgba: Uint8ClampedArray,
  start: number,
  end: number,
  fixed: number,
  horizontal: boolean,
  rail: Rgb
): number {
  let longest = 0
  let current = 0
  for (let position = start; position <= end; position++) {
    const x = horizontal ? position : fixed
    const y = horizontal ? fixed : position
    if (colorMatches(rgba, x, y, rail)) {
      current++
      longest = Math.max(longest, current)
    } else {
      current = 0
    }
  }
  return longest
}

function intervalIsColor(
  rgba: Uint8ClampedArray,
  start: number,
  end: number,
  fixed: number,
  horizontal: boolean,
  color: Rgb
): boolean {
  for (let position = start; position <= end; position++) {
    const x = horizontal ? position : fixed
    const y = horizontal ? fixed : position
    if (!colorMatches(rgba, x, y, color)) return false
  }
  return true
}

function frameFailures(rgba: Uint8ClampedArray, theme: CaptureTheme, reference?: FrameMeasurement): string[] {
  const frame = reference ?? measureFrame(rgba, theme)
  const failures = new Set<string>()
  const cards = new Map(frame.cards.map((card) => [card.name, card]))
  const leftTop = cards.get('left-top')
  const leftBottom = cards.get('left-bottom')
  const main = cards.get('main')
  if (frame.cards.length !== 3 || !leftTop || !leftBottom || !main) return ['cards-missing']

  const tokens = frame.tokens
  const rail = colorRgb(tokens.rail)
  const surface = colorRgb(tokens.surface)
  const gapWidth = tokens.cardGapCss * DEVICE_SCALE_FACTOR
  const midY = Math.floor((tokens.workspaceTop + tokens.workspaceBottom) / 2)
  if (!colorMatches(rgba, 0, midY, rail)) return ['cards-missing']
  for (const card of frame.cards) {
    const centerX = Math.floor((card.x1 + card.x2) / 2)
    if (!colorMatches(rgba, centerX, Math.floor((card.y1 + card.y2) / 2), surface)) return ['cards-missing']
  }

  if (frame.sideGap && frame.sideGap.width > 0) {
    const gap = frame.sideGap
    const mainHeight = main.y2 - main.y1
    const sampleYs = [0.25, 0.5, 0.75].map((fraction) => Math.round(main.y1 + mainHeight * fraction))
    const railWidths = sampleYs.map((y) => longestRailRun(rgba, gap.start, gap.end, y, true, rail))
    const allSurface = sampleYs.every((y) => intervalIsColor(rgba, gap.start, gap.end, y, true, surface))
    if (railWidths.every((width) => width === 0)) {
      failures.add(allSurface ? 'side-gap-missing' : 'side-gap-color')
    } else {
      if (railWidths.some((width) => width < gapWidth - 1 || width > gapWidth + 1)) failures.add('side-gap-width')
      for (const y of sampleYs) {
        const centerX = Math.floor((gap.start + gap.end) / 2)
        if (!colorMatches(rgba, centerX, y, rail) || !colorMatches(rgba, gap.end + 3, y, surface)) {
          failures.add('side-gap-color')
        }
        const adjacentLeft = [leftTop, leftBottom].find((card) => y >= card.y1 && y <= card.y2)
        if (adjacentLeft && !colorMatches(rgba, gap.start - 3, y, surface)) failures.add('side-gap-color')
      }
    }
  } else {
    failures.add('side-gap-missing')
  }

  if (frame.stackedGap && frame.stackedGap.width > 0) {
    const gap = frame.stackedGap
    const leftWidth = leftTop.x2 - leftTop.x1
    const sampleXs = [0.25, 0.5, 0.75].map((fraction) => Math.round(leftTop.x1 + leftWidth * fraction))
    const railHeights = sampleXs.map((x) => longestRailRun(rgba, gap.start, gap.end, x, false, rail))
    const allSurface = sampleXs.every((x) => intervalIsColor(rgba, gap.start, gap.end, x, false, surface))
    if (railHeights.every((height) => height === 0)) {
      failures.add(allSurface ? 'stacked-gap-missing' : 'stacked-gap-color')
    } else {
      if (railHeights.some((height) => height < gapWidth - 1 || height > gapWidth + 1)) failures.add('stacked-gap-width')
      for (const x of sampleXs) {
        const centerY = Math.floor((gap.start + gap.end) / 2)
        if (!colorMatches(rgba, x, centerY, rail) ||
          !colorMatches(rgba, x, gap.start - 3, surface) ||
          !colorMatches(rgba, x, gap.end + 3, surface)) {
          failures.add('stacked-gap-color')
        }
      }
    }
  } else {
    failures.add('stacked-gap-missing')
  }

  for (const corner of frame.corners) {
    const card = cards.get(corner.card)
    if (!card) continue
    for (const offset of [1, 4]) {
      const [x, y] = cornerPoint(card, corner.corner as typeof CORNER_NAMES[number], offset)
      if (!colorMatches(rgba, x, y, rail)) failures.add(`corner-square:${corner.card}:${corner.corner}`)
    }
    for (const offset of [8, 20]) {
      const [x, y] = cornerPoint(card, corner.corner as typeof CORNER_NAMES[number], offset)
      if (!colorMatches(rgba, x, y, surface)) failures.add(`corner-clipped:${corner.card}:${corner.corner}`)
    }
    const actual = measureCorner(rgba, card, corner.corner as typeof CORNER_NAMES[number], tokens)
    if (actual.radiusCss !== tokens.radiusCss) failures.add(`corner-radius:${corner.card}:${corner.corner}`)
  }

  for (const card of frame.cards) {
    const innerX1 = card.x1 + CARD_SCAN_END_INSET
    const innerX2 = card.x2 - CARD_SCAN_END_INSET
    if (!rowMatchesColor(rgba, card.y1, innerX1, innerX2, surface) ||
      (card.name !== 'left-bottom' && card.y1 !== tokens.workspaceTop)) failures.add(`outer-inset:${card.name}`)
    if (card.y1 > 0 && !colorMatches(rgba, Math.floor((card.x1 + card.x2) / 2), card.y1 - 1, rail)) {
      failures.add(`outer-edge-color:${card.name}`)
    }
    if (!rowMatchesColor(rgba, card.y2, innerX1, innerX2, surface) ||
      (card.name !== 'left-top' && card.y2 !== tokens.workspaceBottom)) failures.add(`outer-inset:${card.name}`)
    if (card.y2 + 1 < SCREENSHOT_SIZE.height &&
      !colorMatches(rgba, Math.floor((card.x1 + card.x2) / 2), card.y2 + 1, rail)) {
      failures.add(`outer-edge-color:${card.name}`)
    }
  }
  return [...failures]
}

function paintRect(rgba: Uint8ClampedArray, x1: number, y1: number, x2: number, y2: number, color: Rgb): void {
  for (let y = y1; y <= y2; y++) {
    for (let x = x1; x <= x2; x++) {
      const index = (y * SCREENSHOT_SIZE.width + x) * 4
      rgba[index] = color[0]
      rgba[index + 1] = color[1]
      rgba[index + 2] = color[2]
      rgba[index + 3] = 255
    }
  }
}

function withCopy(rgba: Uint8ClampedArray, mutate: (copy: Uint8ClampedArray) => void): Uint8ClampedArray {
  const copy = new Uint8ClampedArray(rgba)
  mutate(copy)
  return copy
}


async function decodePng(page: Page, bytes: Uint8Array): Promise<Uint8ClampedArray> {
  const pngDataUrl = `data:image/png;base64,${Buffer.from(bytes).toString('base64')}`
  const decoded = await page.evaluate(async (dataUrl) => {
    const image = new Image()
    image.src = dataUrl
    await image.decode()
    const canvas = document.createElement('canvas')
    canvas.width = 2800
    canvas.height = 1760
    const context = canvas.getContext('2d', { willReadFrequently: true })
    if (!context) throw new Error('Chromium did not provide a 2D canvas context')
    context.drawImage(image, 0, 0)
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data
    let binary = ''
    const chunkSize = 0x8000
    for (let offset = 0; offset < pixels.length; offset += chunkSize) {
      binary += String.fromCharCode(...pixels.subarray(offset, offset + chunkSize))
    }
    return { width: canvas.width, height: canvas.height, rgbaBase64: btoa(binary) }
  }, pngDataUrl)
  expect(decoded.width).toBe(SCREENSHOT_SIZE.width)
  expect(decoded.height).toBe(SCREENSHOT_SIZE.height)
  const buffer = Buffer.from(decoded.rgbaBase64, 'base64')
  const rgba = new Uint8ClampedArray(buffer)
  expect(rgba.byteLength).toBe(SCREENSHOT_SIZE.width * SCREENSHOT_SIZE.height * 4)
  return rgba
}

function setThemeData(pixels: Uint8ClampedArray, index: number, color: Rgb): void {
  pixels[index] = color[0]
  pixels[index + 1] = color[1]
  pixels[index + 2] = color[2]
  pixels[index + 3] = 255
}

function proveMutations(rgba: Uint8ClampedArray, theme: CaptureTheme, frame: FrameMeasurement): void {
  const tokens = frame.tokens
  const rail = colorRgb(tokens.rail)
  const surface = colorRgb(tokens.surface)
  const selected = colorRgb(tokens.selected)
  const leftTop = frame.cards.find((card) => card.name === 'left-top')!
  const leftBottom = frame.cards.find((card) => card.name === 'left-bottom')!
  const main = frame.cards.find((card) => card.name === 'main')!
  const sideGap = frame.sideGap!
  const stackedGap = frame.stackedGap!
  const check = (copy: Uint8ClampedArray, failure: string) => expect(frameFailures(copy, theme, frame)).toContain(failure)

  const sideMissing = withCopy(rgba, (copy) => paintRect(copy, sideGap.start, tokens.workspaceTop, sideGap.end, tokens.workspaceBottom, surface))
  check(sideMissing, 'side-gap-missing')

  const sideWidth = withCopy(rgba, (copy) => {
    const centerStart = sideGap.start + Math.floor((sideGap.width - 2) / 2)
    const centerEnd = centerStart + 1
    paintRect(copy, sideGap.start, tokens.workspaceTop, centerStart - 1, tokens.workspaceBottom, surface)
    paintRect(copy, centerEnd + 1, tokens.workspaceTop, sideGap.end, tokens.workspaceBottom, surface)
  })
  check(sideWidth, 'side-gap-width')

  const stackedMissing = withCopy(rgba, (copy) => paintRect(copy, leftTop.x1, stackedGap.start, leftTop.x2, stackedGap.end, surface))
  check(stackedMissing, 'stacked-gap-missing')

  const cornerSquares = withCopy(rgba, (copy) => {
    for (const card of frame.cards) {
      for (const corner of CORNER_NAMES) {
        const x1 = corner.endsWith('left') ? card.x1 : card.x2 - 19
        const x2 = corner.endsWith('left') ? card.x1 + 19 : card.x2
        const y1 = corner.startsWith('top') ? card.y1 : card.y2 - 19
        const y2 = corner.startsWith('top') ? card.y1 + 19 : card.y2
        paintRect(copy, x1, y1, x2, y2, surface)
      }
    }
  })
  const cornerFailures = frameFailures(cornerSquares, theme, frame)
  for (const card of frame.cards) for (const corner of CORNER_NAMES) {
    expect(cornerFailures).toContain(`corner-square:${card.name}:${corner}`)
  }

  const allSurfaceFrame = withCopy(rgba, (copy) => {
    const railRgb = colorRgb(tokens.rail)
    const surfaceRgb = colorRgb(tokens.surface)
    for (let y = 0; y < SCREENSHOT_SIZE.height; y++) {
      for (let x = 0; x < SCREENSHOT_SIZE.width; x++) {
        const index = (y * SCREENSHOT_SIZE.width + x) * 4
        if (Math.abs(copy[index] - railRgb[0]) <= MATCH_TOLERANCE &&
          Math.abs(copy[index + 1] - railRgb[1]) <= MATCH_TOLERANCE &&
          Math.abs(copy[index + 2] - railRgb[2]) <= MATCH_TOLERANCE) {
          setThemeData(copy, index, surfaceRgb)
        }
      }
    }
  })
  check(allSurfaceFrame, 'cards-missing')

  const wrongGapColor = withCopy(rgba, (copy) => {
    paintRect(copy, sideGap.start, tokens.workspaceTop, sideGap.end, tokens.workspaceBottom, selected)
    paintRect(copy, leftTop.x1, stackedGap.start, leftTop.x2, stackedGap.end, selected)
  })
  const wrongColorFailures = frameFailures(wrongGapColor, theme, frame)
  expect(wrongColorFailures).toContain('side-gap-color')
  expect(wrongColorFailures).toContain('stacked-gap-color')

  const insetTops = withCopy(rgba, (copy) => {
    for (const card of frame.cards) paintRect(copy, card.x1, card.y1, card.x2, card.y1 + 9, rail)
  })
  const insetFailures = frameFailures(insetTops, theme, frame)
  for (const card of frame.cards) expect(insetFailures).toContain(`outer-inset:${card.name}`)

  expect(frameFailures(rgba, theme)).toEqual([])
  expect(leftBottom.y2).toBe(tokens.workspaceBottom)
  expect(main.y2).toBe(tokens.workspaceBottom)
}

test('real Automations capture has the approved host frame in both themes', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'quirky-capture-frame-'))
  const previousHome = process.env.QUIRKY_HOME
  let browser: Browser | undefined
  try {
    process.env.QUIRKY_HOME = join(scratch, 'home')
    mkdirSync(process.env.QUIRKY_HOME)
    const outputDir = join(scratch, 'output')
    mkdirSync(outputDir)
    const manifest = await captureApplication({
      repoRoot,
      outputDir,
      only: [targetId],
      skipBuild: false,
      browserExecutable: captureBrowserExecutable(),
      themes: ['dark', 'light'],
      timeoutMs: 180_000,
      signal: AbortSignal.timeout(560_000)
    })
    expect(manifest.failures).toEqual([])
    expect(manifest.captures).toHaveLength(2)
    expect(manifest.captures.map(({ targetId: capturedTarget, theme }) => `${capturedTarget}\0${theme}`).sort())
      .toEqual([`${targetId}\0dark`, `${targetId}\0light`].sort())
    for (const cell of manifest.captures) {
      expect(cell.targetId).toBe(targetId)
      expect(cell.status).toBe('captured')
      expect(cell.image).not.toBeNull()
      const bytes = readFileSync(cell.image!.path)
      expect(bytes.byteLength).toBeGreaterThan(0)
      expect(pngDimensions(bytes)).toEqual({ width: 2800, height: 1760 })
      expect(pngDimensions(bytes)).toEqual(SCREENSHOT_SIZE)
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(cell.image!.sha256)
    }
    const alias = manifest.contributionInventory?.toolAliases.find((entry) => entry.renderedTarget.id === targetId)
    expect(alias).toBeDefined()
    expect(alias?.toolId).toBe(toolId)

    browser = await chromium.launch({ executablePath: captureBrowserExecutable() })
    const page = await browser.newPage()
    const buffers = new Map<CaptureTheme, Uint8ClampedArray>()
    const geometries = new Map<CaptureTheme, FrameMeasurement>()
    for (const theme of ['dark', 'light'] as const) {
      const cell = manifest.captures.find((entry) => entry.theme === theme && entry.targetId === targetId)!
      const rgba = await decodePng(page, readFileSync(cell.image!.path))
      buffers.set(theme, rgba)
      const frame = measureFrame(rgba, theme)
      geometries.set(theme, frame)
      expect(frame.cards.map(({ name }) => name)).toEqual(['left-top', 'left-bottom', 'main'])
      expect(frame.cards).toHaveLength(3)
      const leftTop = frame.cards[0]
      const leftBottom = frame.cards[1]
      const main = frame.cards[2]
      const tokenValues = frame.tokens
      const gap = tokenValues.cardGapCss * DEVICE_SCALE_FACTOR
      const toolRailWidth = tokenValues.toolRailCss * DEVICE_SCALE_FACTOR
      expect(leftTop.x1).toBe(toolRailWidth)
      expect(leftBottom.x1).toBe(leftTop.x1)
      expect(leftBottom.x2).toBe(leftTop.x2)
      expect(main.x1).toBe(leftTop.x2 + gap + 1)
      expect(main.x2).toBe(SCREENSHOT_SIZE.width - toolRailWidth - 1)
      expect(leftTop.y1).toBe(tokenValues.workspaceTop)
      expect(main.y1).toBe(tokenValues.workspaceTop)
      expect(leftTop.y2 + gap + 1).toBe(leftBottom.y1)
      expect(leftBottom.y2).toBe(tokenValues.workspaceBottom)
      expect(main.y2).toBe(tokenValues.workspaceBottom)
      expect(frame.sideGap).toEqual({ start: leftTop.x2 + 1, end: main.x1 - 1, width: gap })
      expect(frame.stackedGap).toEqual({ start: leftTop.y2 + 1, end: leftBottom.y1 - 1, width: gap })

      const cornerRadiusValues = frame.corners.map(({ radiusCss }) => radiusCss)
      expect(cornerRadiusValues).toHaveLength(12)
      expect(cornerRadiusValues).toEqual(Array(12).fill(tokenValues.radiusCss))
      expect(frameFailures(rgba, theme)).toEqual([])

      const railHex = pixelHex(rgba, Math.floor((frame.sideGap!.start + frame.sideGap!.end) / 2), Math.round(main.y1 + (main.y2 - main.y1) * 0.5))
      const surfaceHex = pixelHex(rgba, Math.floor((main.x1 + main.x2) / 2), Math.floor((main.y1 + main.y2) / 2))
      expect(colorMatches(rgba, Math.floor((frame.sideGap!.start + frame.sideGap!.end) / 2), Math.round(main.y1 + (main.y2 - main.y1) * 0.5), colorRgb(tokenValues.rail))).toBe(true)
      expect(colorMatches(rgba, Math.floor((main.x1 + main.x2) / 2), Math.floor((main.y1 + main.y2) / 2), colorRgb(tokenValues.surface))).toBe(true)
      const captureTarget = manifest.targets.find((candidate) => candidate.id === targetId)
      expect(captureTarget).toBeDefined()
      const contract = hostContractContext(captureTarget!, theme)
      const frameRule = contract.rules.find((rule) => rule.id === 'host-frame-ownership')
      expect(frameRule).toBeDefined()
      const measuredGapCss = Math.round(frame.sideGap!.width / DEVICE_SCALE_FACTOR)
      const measuredRadiusCss = frame.corners[0].radiusCss!
      expect(frameRule!.text).toContain(`${measuredGapCss}px rail-colored gap between neighbors`)
      expect(frameRule!.text).toContain(`${measuredRadiusCss}px corner radius`)
      expect(frameRule!.text).toContain('flush, with no extra outer inset')
      expect(frameRule!.text).toContain(`the rail is ${railHex} and card surfaces are ${surfaceHex}`)
    }
    for (const theme of ['dark', 'light'] as const) {
      proveMutations(buffers.get(theme)!, theme, geometries.get(theme)!)
    }
  } finally {
    try {
      await browser?.close()
    } finally {
      if (previousHome === undefined) delete process.env.QUIRKY_HOME
      else process.env.QUIRKY_HOME = previousHome
      rmSync(scratch, { recursive: true, force: true })
    }
  }
}, 600_000)
