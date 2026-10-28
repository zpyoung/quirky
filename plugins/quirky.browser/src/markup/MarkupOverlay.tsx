import { useEffect, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent, CSSProperties, SyntheticEvent } from 'react'
import type { DesignScreenshot } from '../design-contract'
import { cacheMarkupBounds, eraseShapes, mapClientPointToSource } from './geometry'
import type { MarkupShape, Point } from './geometry'
import {
  clearMarkup,
  commitMarkupAction,
  createMarkupHistory,
  redoMarkup,
  undoMarkup
} from './history'
import type { MarkupHistory } from './history'

export type MarkupOverlayProps = {
  screenshot: DesignScreenshot
  onClose(): void
  onCopied(): void
  onError(message: string): void
}

type MarkupTool = 'pen' | 'highlighter' | 'arrow' | 'rectangle' | 'ellipse' | 'text' | 'eraser'

const MAX_SHAPES = 500
const MAX_STROKE_POINTS = 6000
const MAX_SCREENSHOT_DIMENSION = 16_384
const MAX_SCREENSHOT_PIXELS = 32_000_000
const MAX_SCREENSHOT_DATA_URL_CHARS = 4 * 1024 * 1024
const TOOL_LABELS: Array<{ tool: MarkupTool; label: string }> = [
  { tool: 'pen', label: 'Pen' },
  { tool: 'highlighter', label: 'Highlighter' },
  { tool: 'arrow', label: 'Arrow' },
  { tool: 'rectangle', label: 'Rectangle' },
  { tool: 'ellipse', label: 'Ellipse' },
  { tool: 'text', label: 'Text' },
  { tool: 'eraser', label: 'Eraser' }
]

const buttonBase: CSSProperties = {
  border: '1px solid #59606d',
  borderRadius: 6,
  color: '#f7f8fa',
  background: '#303640',
  padding: '7px 10px',
  font: 'inherit',
  cursor: 'pointer'
}

function screenshotIsValid(screenshot: DesignScreenshot): boolean {
  return screenshot.mimeType === 'image/png' &&
    typeof screenshot.dataUrl === 'string' &&
    screenshot.dataUrl.startsWith('data:image/png;base64,') &&
    screenshot.dataUrl.length <= MAX_SCREENSHOT_DATA_URL_CHARS &&
    Number.isSafeInteger(screenshot.width) && Number.isSafeInteger(screenshot.height) &&
    screenshot.width > 0 && screenshot.height > 0 &&
    screenshot.width <= MAX_SCREENSHOT_DIMENSION && screenshot.height <= MAX_SCREENSHOT_DIMENSION &&
    screenshot.width * screenshot.height <= MAX_SCREENSHOT_PIXELS
}

function stopOverlayPropagation(event: SyntheticEvent): void {
  event.stopPropagation()
}

function stopOverlayContextMenu(event: SyntheticEvent): void {
  event.preventDefault()
  event.stopPropagation()
}

function drawShape(context: CanvasRenderingContext2D, shape: MarkupShape): void {
  context.save()
  context.strokeStyle = shape.color
  context.fillStyle = shape.color
  context.lineWidth = shape.kind === 'text' ? 1 : shape.size
  context.lineCap = 'round'
  context.lineJoin = 'round'
  if (shape.kind === 'pen' || shape.kind === 'highlighter') {
    context.globalAlpha = shape.kind === 'highlighter' ? 0.35 : 1
    if (shape.points.length === 1) {
      const point = shape.points[0]!
      context.beginPath()
      context.arc(point.x, point.y, shape.size / 2, 0, Math.PI * 2)
      context.fill()
    } else if (shape.points.length > 1) {
      context.beginPath()
      context.moveTo(shape.points[0]!.x, shape.points[0]!.y)
      for (let index = 1; index < shape.points.length; index++) {
        const point = shape.points[index]!
        context.lineTo(point.x, point.y)
      }
      context.stroke()
    }
  } else if (shape.kind === 'arrow') {
    const dx = shape.end.x - shape.start.x
    const dy = shape.end.y - shape.start.y
    const length = Math.hypot(dx, dy)
    const head = Math.min(length * 0.4, Math.max(8, shape.size * 4))
    const angle = Math.atan2(dy, dx)
    const left = { x: shape.end.x - head * Math.cos(angle - Math.PI / 6), y: shape.end.y - head * Math.sin(angle - Math.PI / 6) }
    const right = { x: shape.end.x - head * Math.cos(angle + Math.PI / 6), y: shape.end.y - head * Math.sin(angle + Math.PI / 6) }
    context.beginPath()
    context.moveTo(shape.start.x, shape.start.y)
    context.lineTo(shape.end.x, shape.end.y)
    context.lineTo(left.x, left.y)
    context.moveTo(shape.end.x, shape.end.y)
    context.lineTo(right.x, right.y)
    context.stroke()
  } else if (shape.kind === 'rectangle') {
    const left = Math.min(shape.start.x, shape.end.x)
    const top = Math.min(shape.start.y, shape.end.y)
    context.strokeRect(left, top, Math.abs(shape.end.x - shape.start.x), Math.abs(shape.end.y - shape.start.y))
  } else if (shape.kind === 'ellipse') {
    const centerX = (shape.start.x + shape.end.x) / 2
    const centerY = (shape.start.y + shape.end.y) / 2
    context.beginPath()
    context.ellipse(centerX, centerY, Math.abs(shape.end.x - shape.start.x) / 2, Math.abs(shape.end.y - shape.start.y) / 2, 0, 0, Math.PI * 2)
    context.stroke()
  } else {
    context.font = `${shape.fontSize}px sans-serif`
    context.textBaseline = 'alphabetic'
    context.fillText(shape.text, shape.point.x, shape.point.y)
  }
  context.restore()
}

function drawScene(canvas: HTMLCanvasElement | null, shapes: MarkupShape[], draft?: MarkupShape): void {
  const context = canvas?.getContext('2d')
  if (!canvas || !context) return
  context.clearRect(0, 0, canvas.width, canvas.height)
  for (const shape of shapes) drawShape(context, shape)
  if (draft) drawShape(context, draft)
}
function drawStrokeSegment(
  canvas: HTMLCanvasElement | null,
  tool: 'pen' | 'highlighter',
  color: string,
  size: number,
  start: Point,
  end: Point
): void {
  const context = canvas?.getContext('2d')
  if (!context) return
  context.save()
  context.strokeStyle = color
  context.fillStyle = color
  context.lineWidth = size
  context.lineCap = 'round'
  context.lineJoin = 'round'
  if (tool === 'highlighter') context.globalAlpha = 0.35
  if (start.x === end.x && start.y === end.y) {
    context.beginPath()
    context.arc(start.x, start.y, size / 2, 0, Math.PI * 2)
    context.fill()
  } else {
    context.beginPath()
    context.moveTo(start.x, start.y)
    context.lineTo(end.x, end.y)
    context.stroke()
  }
  context.restore()
}

async function loadScreenshot(dataUrl: string, width: number, height: number): Promise<HTMLImageElement> {
  const image = new Image()
  image.src = dataUrl
  try {
    await image.decode()
  } catch {
    throw new Error('The frozen browser screenshot could not be decoded.')
  }
  if (image.naturalWidth !== width || image.naturalHeight !== height) {
    throw new Error('The frozen browser screenshot dimensions do not match its image.')
  }
  return image
}

async function canvasPng(canvas: HTMLCanvasElement): Promise<Blob> {
  const { promise, resolve, reject } = Promise.withResolvers<Blob>()
  canvas.toBlob((blob) => {
    if (blob) resolve(blob)
    else reject(new Error('The marked screenshot could not be encoded as PNG.'))
  }, 'image/png')
  return promise
}

type ActivePointer = {
  pointerId: number
  tool: Exclude<MarkupTool, 'text'>
  start: Point
  current: Point
  points: Point[]
  color: string
  size: number
  erasingShapes: MarkupShape[]
}

function makeShape(active: ActivePointer, copyStroke: boolean): MarkupShape | null {
  const style = { color: active.color, size: active.size }
  if (active.tool === 'pen') {
    return { kind: 'pen', points: copyStroke ? [...active.points] : active.points, ...style }
  }
  if (active.tool === 'highlighter') {
    return { kind: 'highlighter', points: copyStroke ? [...active.points] : active.points, ...style }
  }
  if (active.tool === 'eraser') return null
  const shape = { start: active.start, end: active.current, ...style }
  if (active.tool === 'arrow') return { kind: 'arrow', ...shape }
  if (active.tool === 'rectangle') return { kind: 'rectangle', ...shape }
  return { kind: 'ellipse', ...shape }
}

export function MarkupOverlay({ screenshot, onClose, onCopied, onError }: MarkupOverlayProps) {
  const isValid = screenshotIsValid(screenshot)
  const sourceWidth = isValid ? screenshot.width : 1
  const sourceHeight = isValid ? screenshot.height : 1
  const [history, setHistory] = useState<MarkupHistory>(() => createMarkupHistory())
  const [tool, setTool] = useState<MarkupTool>('pen')
  const [color, setColor] = useState('#ff3b30')
  const [strokeSize, setStrokeSize] = useState(6)
  const [fontSize, setFontSize] = useState(28)
  const [textValue, setTextValue] = useState('')
  const [copying, setCopying] = useState(false)
  const [committingCopy, setCommittingCopy] = useState(false)
  const [stageSize, setStageSize] = useState(() => ({
    width: typeof window === 'undefined' ? 1024 : Math.max(1, window.innerWidth - 32),
    height: typeof window === 'undefined' ? 640 : Math.max(1, window.innerHeight - 160)
  }))
  const baseCanvasRef = useRef<HTMLCanvasElement>(null)
  const previewCanvasRef = useRef<HTMLCanvasElement>(null)
  const dialogRef = useRef<HTMLDivElement>(null)
  const historyRef = useRef(history)
  const activeRef = useRef<ActivePointer | null>(null)
  const closedRef = useRef(false)
  const copyGenerationRef = useRef(0)
  const rejectCopyDataRef = useRef<((error: Error) => void) | null>(null)
  const committingCopyRef = useRef(false)
  const onCloseRef = useRef(onClose)
  const onCopiedRef = useRef(onCopied)
  const onErrorRef = useRef(onError)
  onCloseRef.current = onClose
  onCopiedRef.current = onCopied
  onErrorRef.current = onError
  historyRef.current = history

  const scale = isValid ? Math.min(1, stageSize.width / sourceWidth, stageSize.height / sourceHeight) : 1
  const displayWidth = sourceWidth * scale
  const displayHeight = sourceHeight * scale

  const reportError = (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    onErrorRef.current(message)
  }

  const closeOverlay = () => {
    if (closedRef.current || committingCopyRef.current) return
    closedRef.current = true
    activeRef.current = null
    copyGenerationRef.current++
    rejectCopyDataRef.current?.(new Error('Markup copy was cancelled.'))
    rejectCopyDataRef.current = null
    onCloseRef.current()
  }

  useEffect(() => {
    if (!isValid) onErrorRef.current('The frozen browser screenshot is invalid or exceeds the supported pixel bounds.')
  }, [isValid])

  useEffect(() => {
    const updateStage = () => setStageSize({
      width: Math.max(1, window.innerWidth - 32),
      height: Math.max(1, window.innerHeight - 160)
    })
    updateStage()
    window.addEventListener('resize', updateStage)
    dialogRef.current?.focus()
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        closeOverlay()
      }
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => {
      window.removeEventListener('resize', updateStage)
      window.removeEventListener('keydown', onKeyDown, true)
      copyGenerationRef.current++
      committingCopyRef.current = false
      rejectCopyDataRef.current?.(new Error('Markup overlay was unmounted.'))
      rejectCopyDataRef.current = null
    }
  }, [])

  useEffect(() => {
    drawScene(baseCanvasRef.current, history.shapes)
    drawScene(previewCanvasRef.current, [])
  }, [history, sourceWidth, sourceHeight])

  const updateHistory = (next: MarkupHistory) => {
    historyRef.current = next
    setHistory(next)
  }

  const commitShapes = (shapes: MarkupShape[]) => {
    const bounded = shapes.length > MAX_SHAPES ? shapes.slice(-MAX_SHAPES) : shapes
    updateHistory(commitMarkupAction(historyRef.current, bounded.map(cacheMarkupBounds)))
  }

  const mapEventPoint = (event: ReactPointerEvent<HTMLCanvasElement>): Point => {
    const rect = event.currentTarget.getBoundingClientRect()
    return mapClientPointToSource(event.clientX, event.clientY, rect, sourceWidth, sourceHeight)
  }

  const renderActive = (active: ActivePointer) => {
    drawScene(previewCanvasRef.current, [], active.tool === 'eraser' ? undefined : makeShape(active, false) ?? undefined)
  }

  const updateActivePointer = (event: ReactPointerEvent<HTMLCanvasElement>, active: ActivePointer) => {
    const point = mapEventPoint(event)
    if (active.tool === 'eraser') {
      const erased = eraseShapes(active.erasingShapes, [active.current, point], active.size / 2)
      if (erased.removed.length > 0) {
        active.erasingShapes = erased.remaining
        drawScene(baseCanvasRef.current, active.erasingShapes)
      }
    } else if (active.tool === 'pen' || active.tool === 'highlighter') {
      const previous = active.points.at(-1)
      if (previous && Math.hypot(previous.x - point.x, previous.y - point.y) > 0.5 && active.points.length < MAX_STROKE_POINTS) {
        active.points.push(point)
        drawStrokeSegment(previewCanvasRef.current, active.tool, active.color, active.size, previous, point)
      }
    }
    active.current = point
    if (active.tool === 'arrow' || active.tool === 'rectangle' || active.tool === 'ellipse') renderActive(active)
  }

  const pointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!isValid || copying || event.button !== 0) return
    event.preventDefault()
    const point = mapEventPoint(event)
    if (tool === 'text') {
      const text = textValue.trim()
      if (text) {
        commitShapes([...historyRef.current.shapes, { kind: 'text', point, text, color, fontSize }])
      }
      return
    }
    const active: ActivePointer = {
      pointerId: event.pointerId,
      tool,
      start: point,
      current: point,
      points: [point],
      color,
      size: strokeSize,
      erasingShapes: historyRef.current.shapes
    }
    if (tool === 'eraser') {
      const erased = eraseShapes(active.erasingShapes, [point], strokeSize / 2)
      if (erased.removed.length > 0) {
        active.erasingShapes = erased.remaining
        drawScene(baseCanvasRef.current, active.erasingShapes)
      }
    }
    activeRef.current = active
    try { event.currentTarget.setPointerCapture(event.pointerId) } catch {}
    if (tool === 'pen' || tool === 'highlighter') {
      drawStrokeSegment(previewCanvasRef.current, tool, color, strokeSize, point, point)
    } else {
      renderActive(active)
    }
  }

  const pointerMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const active = activeRef.current
    if (!active || active.pointerId !== event.pointerId) return
    event.preventDefault()
    updateActivePointer(event, active)
  }

  const releasePointer = (canvas: HTMLCanvasElement, pointerId: number) => {
    try {
      if (canvas.hasPointerCapture(pointerId)) canvas.releasePointerCapture(pointerId)
    } catch {}
  }

  const pointerUp = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const active = activeRef.current
    if (!active || active.pointerId !== event.pointerId) return
    updateActivePointer(event, active)
    activeRef.current = null
    releasePointer(event.currentTarget, event.pointerId)
    if (active.tool === 'eraser') {
      commitShapes(active.erasingShapes)
      return
    }
    const shape = makeShape(active, true)
    if (shape) commitShapes([...historyRef.current.shapes, shape])
  }

  const cancelPointer = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const active = activeRef.current
    if (!active || active.pointerId !== event.pointerId) return
    activeRef.current = null
    releasePointer(event.currentTarget, event.pointerId)
    drawScene(baseCanvasRef.current, historyRef.current.shapes)
    drawScene(previewCanvasRef.current, [])
  }

  const copyMarkup = async () => {
    const generation = copyGenerationRef.current
    const shapes = historyRef.current.shapes
    setCopying(true)
    const data = Promise.withResolvers<Blob>()
    let dataSettled = false
    const resolveData = (blob: Blob) => {
      if (dataSettled) return
      dataSettled = true
      data.resolve(blob)
    }
    const rejectData = (error: Error) => {
      if (dataSettled) return
      dataSettled = true
      data.reject(error)
    }
    let writeOutcome: Promise<{ ok: true } | { ok: false; error: unknown }> | null = null
    let writeSettled = false
    try {
      if (!isValid) throw new Error('The frozen browser screenshot is unavailable.')
      if (typeof ClipboardItem === 'undefined' || !navigator.clipboard?.write) {
        throw new Error('Image clipboard access is unavailable in this browser window.')
      }
      rejectCopyDataRef.current = rejectData
      const pendingWrite = navigator.clipboard.write([
        new ClipboardItem({ 'image/png': data.promise })
      ]).then(
        () => { writeSettled = true; return { ok: true as const } },
        (error: unknown) => { writeSettled = true; return { ok: false as const, error } }
      )
      writeOutcome = pendingWrite
      const image = await loadScreenshot(screenshot.dataUrl, sourceWidth, sourceHeight)
      if (generation !== copyGenerationRef.current) {
        rejectData(new Error('Markup copy was cancelled.'))
        await pendingWrite
        return
      }
      const composite = document.createElement('canvas')
      composite.width = sourceWidth
      composite.height = sourceHeight
      const context = composite.getContext('2d')
      if (!context) throw new Error('A 2D canvas is unavailable for screenshot compositing.')
      context.drawImage(image, 0, 0, sourceWidth, sourceHeight)
      for (const shape of shapes) drawShape(context, shape)
      const blob = await canvasPng(composite)
      if (generation !== copyGenerationRef.current) {
        rejectData(new Error('Markup copy was cancelled.'))
        await pendingWrite
        return
      }
      if (writeSettled) {
        const outcome = await pendingWrite
        if (!outcome.ok) throw outcome.error
        throw new Error('The image clipboard finished before the PNG was ready.')
      }
      committingCopyRef.current = true
      setCommittingCopy(true)
      resolveData(blob)
      const outcome = await pendingWrite
      if (!outcome.ok) throw outcome.error
      if (generation === copyGenerationRef.current) onCopiedRef.current()
    } catch (error) {
      if (writeOutcome) {
        rejectData(error instanceof Error ? error : new Error(String(error)))
        await writeOutcome
      }
      if (generation === copyGenerationRef.current) reportError(error)
    } finally {
      if (rejectCopyDataRef.current === rejectData) rejectCopyDataRef.current = null
      committingCopyRef.current = false
      if (generation === copyGenerationRef.current) {
        setCommittingCopy(false)
        setCopying(false)
      }
    }
  }

  const toolbarButton = (selected = false): CSSProperties => ({
    ...buttonBase,
    background: selected ? '#245ec7' : buttonBase.background,
    borderColor: selected ? '#80aaff' : buttonBase.borderColor
  })

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby="markup-overlay-title"
      tabIndex={-1}
      onPointerDown={stopOverlayPropagation}
      onPointerMove={stopOverlayPropagation}
      onPointerUp={stopOverlayPropagation}
      onPointerCancel={stopOverlayPropagation}
      onPointerOver={stopOverlayPropagation}
      onPointerOut={stopOverlayPropagation}
      onMouseDown={stopOverlayPropagation}
      onMouseMove={stopOverlayPropagation}
      onMouseUp={stopOverlayPropagation}
      onMouseOver={stopOverlayPropagation}
      onMouseOut={stopOverlayPropagation}
      onTouchStart={stopOverlayPropagation}
      onTouchMove={stopOverlayPropagation}
      onTouchEnd={stopOverlayPropagation}
      onTouchCancel={stopOverlayPropagation}
      onClick={stopOverlayPropagation}
      onDoubleClick={stopOverlayPropagation}
      onContextMenu={stopOverlayContextMenu}
      onWheel={stopOverlayPropagation}
      onKeyDown={stopOverlayPropagation}
      onKeyUp={stopOverlayPropagation}
      onChange={stopOverlayPropagation}
      onInput={stopOverlayPropagation}
      onScroll={stopOverlayPropagation}
      style={{
        position: 'fixed', inset: 0, zIndex: 2_147_483_647, display: 'flex', flexDirection: 'column',
        pointerEvents: 'auto',
        color: '#f7f8fa', background: 'rgba(17, 20, 26, 0.97)', font: '14px/1.4 system-ui, sans-serif', outline: 'none'
      }}
    >
      <div
        role="toolbar"
        aria-label="Screenshot markup tools"
        style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, padding: 12, borderBottom: '1px solid #444b57' }}
      >
        <strong id="markup-overlay-title" style={{ marginRight: 8 }}>Draw on screenshot</strong>
        {TOOL_LABELS.map(({ tool: item, label }) => (
          <button
            key={item}
            type="button"
            aria-label={label}
            aria-pressed={tool === item}
            title={label}
            style={toolbarButton(tool === item)}
            onClick={() => setTool(item)}
          >{label}</button>
        ))}
        <label style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
          Color
          <input aria-label="Markup color" type="color" value={color} onChange={(event) => setColor(event.currentTarget.value)} />
        </label>
        {tool !== 'text' && <label style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
          {tool === 'eraser' ? 'Eraser size' : 'Stroke size'}
          <input aria-label={tool === 'eraser' ? 'Eraser size' : 'Stroke size'} type="range" min={1} max={50} value={strokeSize} onChange={(event) => setStrokeSize(Number(event.currentTarget.value))} />
          <output>{strokeSize}</output>
        </label>}
        {tool === 'text' && <>
          <label style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
            Font size
            <input aria-label="Font size" type="range" min={8} max={96} value={fontSize} onChange={(event) => setFontSize(Number(event.currentTarget.value))} />
            <output>{fontSize}</output>
          </label>
          <label style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
            Text
            <input aria-label="Text to place" maxLength={200} value={textValue} onChange={(event) => setTextValue(event.currentTarget.value)} />
          </label>
        </>}
        <button type="button" aria-label="Undo" disabled={!history.undo.length || copying} style={toolbarButton()} onClick={() => updateHistory(undoMarkup(historyRef.current))}>Undo</button>
        <button type="button" aria-label="Redo" disabled={!history.redo.length || copying} style={toolbarButton()} onClick={() => updateHistory(redoMarkup(historyRef.current))}>Redo</button>
        <button type="button" aria-label="Clear all markup" disabled={!history.shapes.length || copying} style={toolbarButton()} onClick={() => updateHistory(clearMarkup(historyRef.current))}>Clear all</button>
      </div>
      <div style={{ flex: 1, minHeight: 0, overflow: 'auto', display: 'grid', placeItems: 'center', padding: 8 }}>
        {isValid ? <div
          style={{ position: 'relative', flex: '0 0 auto', width: displayWidth, height: displayHeight, boxShadow: '0 8px 32px rgba(0,0,0,.45)' }}
        >
          <img
            src={screenshot.dataUrl}
            alt="Frozen browser screenshot being marked up"
            draggable={false}
            width={sourceWidth}
            height={sourceHeight}
            style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', userSelect: 'none', pointerEvents: 'none' }}
          />
          <canvas
            ref={baseCanvasRef}
            width={sourceWidth}
            height={sourceHeight}
            aria-hidden="true"
            style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }}
          />
          <canvas
            ref={previewCanvasRef}
            width={sourceWidth}
            height={sourceHeight}
            aria-label="Markup canvas"
            style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', touchAction: 'none', cursor: tool === 'text' ? 'text' : 'crosshair' }}
            onPointerDown={pointerDown}
            onPointerMove={pointerMove}
            onPointerUp={pointerUp}
            onPointerCancel={cancelPointer}
            onLostPointerCapture={cancelPointer}
          />
        </div> : <p role="alert">The frozen screenshot cannot be displayed.</p>}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8, padding: 12, borderTop: '1px solid #444b57' }}>
        <span style={{ marginRight: 'auto' }}>Changes apply only to this frozen screenshot.</span>
        <button type="button" disabled={committingCopy} style={toolbarButton()} onClick={closeOverlay}>Cancel</button>
        <button type="button" style={toolbarButton(true)} disabled={!isValid || copying} onClick={() => void copyMarkup()}>
          {committingCopy ? 'Writing PNG…' : copying ? 'Preparing PNG…' : 'Copy Markup'}
        </button>
      </div>
    </div>
  )
}
