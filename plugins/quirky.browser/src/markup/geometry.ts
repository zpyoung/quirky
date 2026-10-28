export type Point = { x: number; y: number }
export type PointerBounds = { left: number; top: number; width: number; height: number }
export type MarkupBounds = { left: number; top: number; right: number; bottom: number }

export type MarkupShape = (
  | { kind: 'pen'; points: Point[]; color: string; size: number }
  | { kind: 'highlighter'; points: Point[]; color: string; size: number }
  | { kind: 'arrow'; start: Point; end: Point; color: string; size: number }
  | { kind: 'rectangle'; start: Point; end: Point; color: string; size: number }
  | { kind: 'ellipse'; start: Point; end: Point; color: string; size: number }
  | { kind: 'text'; point: Point; text: string; color: string; fontSize: number }
) & { bounds?: MarkupBounds }

export function mapClientPointToSource(
  clientX: number,
  clientY: number,
  bounds: PointerBounds,
  sourceWidth: number,
  sourceHeight: number
): Point {
  if (bounds.width <= 0 || bounds.height <= 0 || sourceWidth <= 0 || sourceHeight <= 0) return { x: 0, y: 0 }
  const x = Number.isFinite(clientX) ? (clientX - bounds.left) * sourceWidth / bounds.width : 0
  const y = Number.isFinite(clientY) ? (clientY - bounds.top) * sourceHeight / bounds.height : 0
  return {
    x: Math.max(0, Math.min(sourceWidth, x)),
    y: Math.max(0, Math.min(sourceHeight, y))
  }
}

type Segment = [Point, Point]

function lineSegments(points: Point[]): Segment[] {
  if (points.length === 0) return []
  const segments: Segment[] = []
  if (points.length === 1) return [[points[0]!, points[0]!]]
  for (let index = 1; index < points.length; index++) segments.push([points[index - 1]!, points[index]!])
  return segments
}

function shapeSegments(shape: { kind: 'arrow' | 'rectangle'; start: Point; end: Point; size: number }): Segment[] {
  const { start, end } = shape
  if (shape.kind === 'arrow') {
    const dx = end.x - start.x
    const dy = end.y - start.y
    const length = Math.hypot(dx, dy)
    if (length === 0) return [[start, end]]
    const head = Math.min(length * 0.4, Math.max(8, shape.size * 4))
    const angle = Math.atan2(dy, dx)
    const left = { x: end.x - head * Math.cos(angle - Math.PI / 6), y: end.y - head * Math.sin(angle - Math.PI / 6) }
    const right = { x: end.x - head * Math.cos(angle + Math.PI / 6), y: end.y - head * Math.sin(angle + Math.PI / 6) }
    return [[start, end], [end, left], [end, right]]
  }
  const left = Math.min(start.x, end.x)
  const right = Math.max(start.x, end.x)
  const top = Math.min(start.y, end.y)
  const bottom = Math.max(start.y, end.y)
  const points = [{ x: left, y: top }, { x: right, y: top }, { x: right, y: bottom }, { x: left, y: bottom }]
  return points.map((point, index) => [point, points[(index + 1) % points.length]!])
}

function pointSegmentDistance(point: Point, start: Point, end: Point): number {
  const dx = end.x - start.x
  const dy = end.y - start.y
  const lengthSquared = dx * dx + dy * dy
  if (lengthSquared === 0) return Math.hypot(point.x - start.x, point.y - start.y)
  const t = Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared))
  return Math.hypot(point.x - (start.x + t * dx), point.y - (start.y + t * dy))
}

function orientation(a: Point, b: Point, c: Point): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)
}

function between(value: number, a: number, b: number): boolean {
  return value >= Math.min(a, b) && value <= Math.max(a, b)
}

function segmentsIntersect(a: Point, b: Point, c: Point, d: Point): boolean {
  const abC = orientation(a, b, c)
  const abD = orientation(a, b, d)
  const cdA = orientation(c, d, a)
  const cdB = orientation(c, d, b)
  if (((abC > 0 && abD < 0) || (abC < 0 && abD > 0)) && ((cdA > 0 && cdB < 0) || (cdA < 0 && cdB > 0))) return true
  return (abC === 0 && between(c.x, a.x, b.x) && between(c.y, a.y, b.y)) ||
    (abD === 0 && between(d.x, a.x, b.x) && between(d.y, a.y, b.y)) ||
    (cdA === 0 && between(a.x, c.x, d.x) && between(a.y, c.y, d.y)) ||
    (cdB === 0 && between(b.x, c.x, d.x) && between(b.y, c.y, d.y))
}

function segmentDistance(a: Point, b: Point, c: Point, d: Point): number {
  if (segmentsIntersect(a, b, c, d)) return 0
  return Math.min(
    pointSegmentDistance(a, c, d),
    pointSegmentDistance(b, c, d),
    pointSegmentDistance(c, a, b),
    pointSegmentDistance(d, a, b)
  )
}
function ellipseIntersectsPath(
  shape: { kind: 'ellipse'; start: Point; end: Point },
  pathSegments: Segment[],
  hitRadius: number
): boolean {
  const left = Math.min(shape.start.x, shape.end.x)
  const right = Math.max(shape.start.x, shape.end.x)
  const top = Math.min(shape.start.y, shape.end.y)
  const bottom = Math.max(shape.start.y, shape.end.y)
  const center = { x: (left + right) / 2, y: (top + bottom) / 2 }
  const radiusX = (right - left) / 2
  const radiusY = (bottom - top) / 2
  const maxRadius = Math.max(radiusX, radiusY)
  const approximationError = Math.max(0.05, hitRadius * 0.25)
  const step = maxRadius <= approximationError
    ? Math.PI / 24
    : 2 * Math.acos(Math.max(-1, 1 - approximationError / maxRadius))
  const segmentCount = Math.max(48, Math.ceil(Math.PI * 2 / step))
  let previous = { x: center.x + radiusX, y: center.y }
  let current = { x: previous.x, y: previous.y }
  for (let index = 1; index <= segmentCount; index++) {
    const angle = index * Math.PI * 2 / segmentCount
    current.x = center.x + Math.cos(angle) * radiusX
    current.y = center.y + Math.sin(angle) * radiusY
    for (const [start, end] of pathSegments) {
      if (segmentDistance(start, end, previous, current) <= hitRadius + approximationError) return true
    }
    const last = previous
    previous = current
    current = last
  }
  return false
}
 

function textBounds(shape: Extract<MarkupShape, { kind: 'text' }>) {
  const width = Math.max(shape.fontSize * 0.35, [...shape.text].length * shape.fontSize * 0.62)
  return {
    left: shape.point.x,
    top: shape.point.y - shape.fontSize,
    right: shape.point.x + width,
    bottom: shape.point.y + shape.fontSize * 0.25
  }
}
function shapeBounds(shape: MarkupShape): MarkupBounds {
  if (shape.bounds) return shape.bounds
  if (shape.kind === 'text') return textBounds(shape)
  if (shape.kind === 'pen' || shape.kind === 'highlighter') {
    if (shape.points.length === 0) return { left: 0, top: 0, right: 0, bottom: 0 }
    let left = shape.points[0]!.x
    let right = left
    let top = shape.points[0]!.y
    let bottom = top
    for (const point of shape.points) {
      left = Math.min(left, point.x)
      right = Math.max(right, point.x)
      top = Math.min(top, point.y)
      bottom = Math.max(bottom, point.y)
    }
    return { left, top, right, bottom }
  }
  const padding = shape.kind === 'arrow' ? Math.max(8, shape.size * 4) : 0
  return {
    left: Math.min(shape.start.x, shape.end.x) - padding,
    top: Math.min(shape.start.y, shape.end.y) - padding,
    right: Math.max(shape.start.x, shape.end.x) + padding,
    bottom: Math.max(shape.start.y, shape.end.y) + padding
  }
}

export function cacheMarkupBounds(shape: MarkupShape): MarkupShape {
  return shape.bounds ? shape : { ...shape, bounds: shapeBounds(shape) }
}

function pointInExpandedRect(point: Point, rect: ReturnType<typeof textBounds>, radius: number): boolean {
  return point.x >= rect.left - radius && point.x <= rect.right + radius &&
    point.y >= rect.top - radius && point.y <= rect.bottom + radius
}

function pathHitsText(pathSegments: Segment[], shape: Extract<MarkupShape, { kind: 'text' }>, radius: number): boolean {
  const rect = shape.bounds ?? textBounds(shape)
  const leftTop = { x: rect.left - radius, y: rect.top - radius }
  const rightTop = { x: rect.right + radius, y: rect.top - radius }
  const rightBottom = { x: rect.right + radius, y: rect.bottom + radius }
  const leftBottom = { x: rect.left - radius, y: rect.bottom + radius }
  for (const [start, end] of pathSegments) {
    if (pointInExpandedRect(start, rect, radius) || pointInExpandedRect(end, rect, radius)) return true
    if (
      segmentsIntersect(start, end, leftTop, rightTop) ||
      segmentsIntersect(start, end, rightTop, rightBottom) ||
      segmentsIntersect(start, end, rightBottom, leftBottom) ||
      segmentsIntersect(start, end, leftBottom, leftTop)
    ) return true
  }
  return false
}

function isHit(shape: MarkupShape, pathSegments: Segment[], pathBounds: MarkupBounds, radius: number): boolean {
  if (pathSegments.length === 0) return false
  const hitRadius = Math.max(0, radius) + (shape.kind === 'text' ? 0 : Math.max(0, shape.size) / 2)
  const bounds = shapeBounds(shape)
  if (
    bounds.left > pathBounds.right + hitRadius || bounds.right < pathBounds.left - hitRadius ||
    bounds.top > pathBounds.bottom + hitRadius || bounds.bottom < pathBounds.top - hitRadius
  ) return false
  if (shape.kind === 'text') return pathHitsText(pathSegments, shape, Math.max(0, radius))
  if (shape.kind === 'pen' || shape.kind === 'highlighter') {
    if (shape.points.length === 0) return false
    const drawingCount = Math.max(1, shape.points.length - 1)
    for (const eraser of pathSegments) {
      for (let index = 0; index < drawingCount; index++) {
        const start = shape.points.length === 1 ? shape.points[0]! : shape.points[index]!
        const end = shape.points.length === 1 ? start : shape.points[index + 1]!
        if (segmentDistance(eraser[0], eraser[1], start, end) <= hitRadius) return true
      }
    }
    return false
  }
  if (shape.kind === 'ellipse') return ellipseIntersectsPath(shape, pathSegments, hitRadius)
  const drawingSegments = shapeSegments(shape)
  for (const eraser of pathSegments) {
    for (const drawing of drawingSegments) {
      if (segmentDistance(eraser[0], eraser[1], drawing[0], drawing[1]) <= hitRadius) return true
    }
  }
  return false
}

export function eraseShapes(shapes: MarkupShape[], path: Point[], radius: number): { remaining: MarkupShape[]; removed: MarkupShape[] } {
  if (path.length === 0) return { remaining: shapes, removed: [] }
  const remaining: MarkupShape[] = []
  const removed: MarkupShape[] = []
  const pathSegments = lineSegments(path)
  let left = Infinity
  let top = Infinity
  let right = -Infinity
  let bottom = -Infinity
  for (const [start, end] of pathSegments) {
    left = Math.min(left, start.x, end.x)
    top = Math.min(top, start.y, end.y)
    right = Math.max(right, start.x, end.x)
    bottom = Math.max(bottom, start.y, end.y)
  }
  const pathBounds = { left, top, right, bottom }
  for (const shape of shapes) (isHit(shape, pathSegments, pathBounds, radius) ? removed : remaining).push(shape)
  return { remaining, removed }
}
