import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, extname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as ts from 'typescript'

export type UiLintRule = 'ui/no-raw-color' | 'ui/no-raw-pixel' | 'ui/no-plugin-css'

export type UiLintDiagnostic = {
  file: string
  line: number
  column: number
  rule: UiLintRule
  message: string
}

export type UiLintOptions = { plugin?: boolean }

type LocatedDiagnostic = { diagnostic: UiLintDiagnostic; offset: number; order: number }
type Emitter = {
  file: string
  source: string
  diagnostics: LocatedDiagnostic[]
  seen: Set<string>
  lineStarts: number[]
}

const messages: Record<UiLintRule, string> = {
  'ui/no-raw-color': 'Replace raw color literals with semantic UI tokens.',
  'ui/no-raw-pixel': 'Replace raw pixel dimensions with semantic UI tokens.',
  'ui/no-plugin-css': 'Plugin source must use shared UI components and tokens instead of stylesheet CSS.'
}

const sourceExtensions = new Set(['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs', '.html', '.htm', '.svg', '.css', '.scss', '.sass', '.less'])
const cssExtensions = new Set(['.css', '.scss', '.sass', '.less'])
const excludedDirectories = new Set(['node_modules', 'vendor', 'dist', 'build', 'coverage', '.git', 'test', 'tests', '__tests__', '__test__', '_test', '_tests', 'fixture', 'fixtures', '__fixtures__', '_fixtures'])
function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}
const unitlessProperties = new Set([
  'animationIterationCount', 'aspectRatio', 'borderImageOutset', 'borderImageSlice', 'borderImageWidth', 'boxFlex',
  'boxFlexGroup', 'boxOrdinalGroup', 'columnCount', 'columns', 'flex', 'flexGrow', 'flexPositive', 'flexShrink',
  'flexNegative', 'flexOrder', 'gridArea', 'gridColumn', 'gridColumnEnd', 'gridColumnSpan', 'gridColumnStart',
  'gridRow', 'gridRowEnd', 'gridRowSpan', 'gridRowStart', 'fontWeight', 'lineClamp', 'lineHeight', 'opacity',
  'order', 'orphans', 'tabSize', 'widows', 'zIndex', 'zoom', 'fillOpacity', 'floodOpacity', 'stopOpacity',
  'strokeDasharray', 'strokeDashoffset', 'strokeMiterlimit', 'strokeOpacity', 'strokeWidth', 'MozBoxFlex',
  'msFlex', 'WebkitBoxFlex', 'WebkitLineClamp'
])
const unitlessLower = new Set([...unitlessProperties, 'scale'].map((name) => name.toLowerCase()))
const cssColorProperties = /(?:^|[-_])(?:color|background|border|outline|box-shadow|text-shadow|text-decoration|text-emphasis|column-rule|caret|accent|fill|stroke|stop|flood|lighting|mask-border|filter)(?:$|[-_])/i
const exactColorProperties = new Set([
  'background', 'background-color', 'background-image', 'border', 'border-color', 'border-top', 'border-right',
  'border-bottom', 'border-left', 'border-block', 'border-inline', 'outline', 'outline-color', 'box-shadow',
  'text-shadow', 'text-decoration', 'text-decoration-color', 'text-emphasis', 'text-emphasis-color', 'column-rule',
  'column-rule-color', 'caret-color', 'accent-color', 'fill', 'stroke', 'stop-color', 'flood-color', 'lighting-color',
  'filter', 'mask', 'mask-border', '-webkit-text-stroke', '-webkit-text-fill-color'
])
const colorFunctions = /\b(?:rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch|color)\s*\(/gi
const colorNames = new Set((`aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue slateblue slategray slategrey snow springgreen steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke yellow yellowgreen transparent`).split(/\s+/))
const propertyNamePattern = /^\s*([@$]?-{0,2}[A-Za-z_][A-Za-z0-9_-]*)\s*$/
const pixelPattern = /[-+]?(?:\d+(?:\.\d*)?|\.\d+)px\b/gi
const hexColorPattern = /#(?:[\da-f]{8}|[\da-f]{6}|[\da-f]{4}|[\da-f]{3})(?![\da-f])/gi

function makeEmitter(file: string, source: string): Emitter {
  const lineStarts = [0]
  for (let index = 0; index < source.length; index += 1) {
    if (source.charCodeAt(index) === 10) lineStarts.push(index + 1)
  }
  return { file, source, diagnostics: [], seen: new Set(), lineStarts }
}

function locate(emitter: Emitter, offset: number): { line: number; column: number } {
  const bounded = Math.max(0, Math.min(offset, emitter.source.length))
  let low = 0
  let high = emitter.lineStarts.length
  while (low < high) {
    const middle = (low + high) >>> 1
    if (emitter.lineStarts[middle] <= bounded) low = middle + 1
    else high = middle
  }
  const lineIndex = Math.max(0, low - 1)
  return { line: lineIndex + 1, column: bounded - emitter.lineStarts[lineIndex] + 1 }
}

function report(emitter: Emitter, offset: number, rule: UiLintRule): void {
  const bounded = Math.max(0, Math.min(offset, emitter.source.length))
  const key = `${bounded}:${rule}`
  if (emitter.seen.has(key)) return
  emitter.seen.add(key)
  emitter.diagnostics.push({
    diagnostic: { file: emitter.file, ...locate(emitter, bounded), rule, message: messages[rule] },
    offset: bounded,
    order: emitter.diagnostics.length
  })
}

function finish(emitter: Emitter): UiLintDiagnostic[] {
  return emitter.diagnostics
    .sort((left, right) => left.offset - right.offset || left.order - right.order)
    .map(({ diagnostic }) => diagnostic)
}

function isPrimitiveFile(file: string): boolean {
  const normalized = file.replaceAll('\\', '/')
  return /(?:^|\/)packages\/ui\/src\/design-system\/(?:tokens|compatibility-tokens)\.css$/.test(normalized)
}

function isColorProperty(property: string): boolean {
  const normalized = property.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`).toLowerCase()
  return property.startsWith('--') || property.startsWith('$') || property.startsWith('@') || exactColorProperties.has(normalized) || cssColorProperties.test(normalized)
}

function maskNonStyleText(value: string): string {
  const chars = value.split('')
  const blank = (start: number, end: number) => {
    for (let index = start; index < end; index += 1) {
      if (chars[index] !== '\n' && chars[index] !== '\r') chars[index] = ' '
    }
  }
  let index = 0
  while (index < value.length) {
    if (value.startsWith('/*', index)) {
      const endMarker = value.indexOf('*/', index + 2)
      const end = endMarker < 0 ? value.length : endMarker + 2
      blank(index, end)
      index = end
      continue
    }
    const character = value[index]
    if (character === '"' || character === "'") {
      const quote = character
      const start = index
      index += 1
      while (index < value.length) {
        if (value[index] === '\\') {
          index += 2
          continue
        }
        if (value[index] === quote) {
          index += 1
          break
        }
        index += 1
      }
      blank(start, Math.min(index, value.length))
      continue
    }
    if ((index === 0 || !/[\w-]/.test(value[index - 1])) && /^url\s*\(/i.test(value.slice(index))) {
      const open = value.indexOf('(', index)
      let depth = 1
      let cursor = open + 1
      let quote = ''
      while (cursor < value.length && depth > 0) {
        const current = value[cursor]
        if (quote) {
          if (current === '\\') cursor += 2
          else {
            if (current === quote) quote = ''
            cursor += 1
          }
        } else if (current === '"' || current === "'") {
          quote = current
          cursor += 1
        } else if (current === '(') {
          depth += 1
          cursor += 1
        } else if (current === ')') {
          depth -= 1
          cursor += 1
        } else cursor += 1
      }
      blank(index, cursor)
      index = cursor
      continue
    }
    index += 1
  }
  return chars.join('')
}

function reportStyleValue(emitter: Emitter, value: string, valueOffset: number, property: string, maskCss: boolean): void {
  const candidate = maskCss ? maskNonStyleText(value) : value
  for (const match of candidate.matchAll(pixelPattern)) {
    const literal = match[0]
    if (Number(literal.slice(0, -2)) !== 0) report(emitter, valueOffset + (match.index ?? 0), 'ui/no-raw-pixel')
  }
  if (!isColorProperty(property)) return
  for (const match of candidate.matchAll(hexColorPattern)) {
    report(emitter, valueOffset + (match.index ?? 0), 'ui/no-raw-color')
  }
  for (const match of candidate.matchAll(colorFunctions)) {
    report(emitter, valueOffset + (match.index ?? 0), 'ui/no-raw-color')
  }
  const namedColorPattern = /(?<![\w-])[A-Za-z]+(?![\w-])/g
  for (const match of candidate.matchAll(namedColorPattern)) {
    if (colorNames.has(match[0].toLowerCase())) report(emitter, valueOffset + (match.index ?? 0), 'ui/no-raw-color')
  }
}

function skipCssTrivia(source: string, index: number, end: number): number {
  let cursor = index
  while (cursor < end) {
    if (/\s/.test(source[cursor])) cursor += 1
    else if (source.startsWith('/*', cursor)) {
      const marker = source.indexOf('*/', cursor + 2)
      cursor = marker < 0 || marker + 2 > end ? end : marker + 2
    } else break
  }
  return cursor
}

function findCssDelimiter(source: string, start: number, end: number): { index: number; character: string } {
  let parentheses = 0
  let brackets = 0
  let quote = ''
  for (let index = start; index < end; index += 1) {
    const character = source[index]
    if (quote) {
      if (character === '\\') index += 1
      else if (character === quote) quote = ''
      continue
    }
    if (source.startsWith('/*', index)) {
      const marker = source.indexOf('*/', index + 2)
      index = marker < 0 ? end : marker + 1
      continue
    }
    if (character === '"' || character === "'") quote = character
    else if (character === '(') parentheses += 1
    else if (character === ')' && parentheses > 0) parentheses -= 1
    else if (character === '[') brackets += 1
    else if (character === ']' && brackets > 0) brackets -= 1
    else if (parentheses === 0 && brackets === 0 && (character === '{' || character === ';' || character === '}')) return { index, character }
  }
  return { index: end, character: '' }
}

function findTopLevelColon(source: string, start: number, end: number): number {
  let parentheses = 0
  let brackets = 0
  let quote = ''
  for (let index = start; index < end; index += 1) {
    const character = source[index]
    if (quote) {
      if (character === '\\') index += 1
      else if (character === quote) quote = ''
      continue
    }
    if (source.startsWith('/*', index)) {
      const marker = source.indexOf('*/', index + 2)
      index = marker < 0 ? end : marker + 1
      continue
    }
    if (character === '"' || character === "'") quote = character
    else if (character === '(') parentheses += 1
    else if (character === ')' && parentheses > 0) parentheses -= 1
    else if (character === '[') brackets += 1
    else if (character === ']' && brackets > 0) brackets -= 1
    else if (character === ':' && parentheses === 0 && brackets === 0) return index
  }
  return -1
}

function isInsideCssOpaqueContext(prefix: string): boolean {
  const marker = '__ui_style_interpolation__'
  return maskNonStyleText(`${prefix}${marker}`).slice(-marker.length).trim().length === 0
}

function propertyBeforeCssInterpolation(prefix: string): string | undefined {
  let cursor = 0
  let declarationStart = 0
  while (cursor < prefix.length) {
    const delimiter = findCssDelimiter(prefix, cursor, prefix.length)
    if (!delimiter.character) break
    declarationStart = delimiter.index + 1
    cursor = delimiter.index + 1
  }
  const colon = findTopLevelColon(prefix, declarationStart, prefix.length)
  if (colon < 0) return undefined
  const propertyText = prefix.slice(declarationStart, colon).replace(/\/\*[\s\S]*?\*\//g, '')
  return propertyText.match(propertyNamePattern)?.[1]
}

function checkCssDeclaration(emitter: Emitter, start: number, end: number, primitive: boolean): void {
  const colon = findTopLevelColon(emitter.source, start, end)
  if (colon < 0) return
  const propertyText = emitter.source.slice(start, colon).replace(/\/\*[\s\S]*?\*\//g, '')
  const propertyMatch = propertyText.match(propertyNamePattern)
  if (!propertyMatch) return
  const property = propertyMatch[1]
  const rawValue = emitter.source.slice(colon + 1, end)
  const leading = rawValue.match(/^\s*/)?.[0].length ?? 0
  const valueOffset = colon + 1 + leading
  if (primitive && property.startsWith('--')) return
  reportStyleValue(emitter, rawValue.slice(leading), valueOffset, property, true)
}

function scanCssRange(emitter: Emitter, start: number, end: number, plugin: boolean): void {
  const primitive = isPrimitiveFile(emitter.file)
  let cursor = start
  while (cursor < end) {
    cursor = skipCssTrivia(emitter.source, cursor, end)
    if (cursor >= end) break
    const segmentStart = cursor
    const delimiter = findCssDelimiter(emitter.source, cursor, end)
    if (delimiter.character === '{') {
      cursor = scanCssRange(emitter, delimiter.index + 1, end, plugin)
      continue
    }
    checkCssDeclaration(emitter, segmentStart, delimiter.index, primitive)
    if (delimiter.character === '}') return
    cursor = delimiter.index + 1
  }
}

function scanInlineCss(emitter: Emitter, start: number, end: number, plugin: boolean): void {
  let cursor = start
  while (cursor < end) {
    cursor = skipCssTrivia(emitter.source, cursor, end)
    if (cursor >= end) break
    const delimiter = findCssDelimiter(emitter.source, cursor, end)
    if (delimiter.character === '{') {
      cursor = scanCssRange(emitter, delimiter.index + 1, end, plugin)
      continue
    }
    checkCssDeclaration(emitter, cursor, delimiter.index, false)
    if (delimiter.character === '}') return
    cursor = delimiter.index + 1
  }
}

function isPluginCssFile(file: string): boolean {
  return cssExtensions.has(extname(file).toLowerCase())
}


function scanCssSource(file: string, source: string, plugin: boolean): UiLintDiagnostic[] {
  const emitter = makeEmitter(file, source)
  if (plugin && isPluginCssFile(file)) report(emitter, 0, 'ui/no-plugin-css')
  scanCssRange(emitter, 0, source.length, plugin)
  return finish(emitter)
}

function unwrapExpression(expression: ts.Expression): ts.Expression {
  let node = expression
  while (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isTypeAssertionExpression(node) || ts.isSatisfiesExpression(node) || ts.isNonNullExpression(node)) {
    node = node.expression
  }
  return node
}

function propertyNameOf(name: ts.PropertyName | ts.BindingName): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text
  if (ts.isComputedPropertyName(name) && (ts.isStringLiteral(name.expression) || ts.isNumericLiteral(name.expression))) return name.expression.text
  return undefined
}

function propertyIsUnitless(property: string): boolean {
  const vendorNormalized = property.replace(/^-(?:webkit|moz|ms|o)-/i, '').replace(/^(?:Webkit|Moz|ms|O)(?=[A-Z])/, '')
  const normalized = vendorNormalized.replace(/[-_]/g, '').toLowerCase()
  return unitlessLower.has(normalized)
}

function isCssPropertyName(property: string): boolean {
  if (property.startsWith('--')) return true
  const normalized = property.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`).toLowerCase()
  return /^(?:all|appearance|align|animation|backdrop|background|block|border|bottom|box|break|caption|caret|clear|clip|color|column|contain|content|cursor|direction|display|empty|filter|flex|float|font|gap|grid|height|hyphens|inset|isolation|justify|left|letter|line|list|margin|mask|max-|min-|object|opacity|order|outline|overflow|overscroll|padding|perspective|place|pointer|position|resize|right|rotate|row|scale|scroll|shape|stop|stroke|table|tab|text|top|transform|transition|translate|unicode|user|vertical|visibility|white|width|will|word|writing|z-index)/.test(normalized)
}

function scanHtmlText(emitter: Emitter, raw: string, baseOffset: number, plugin: boolean): void {
  let cursor = 0
  while (cursor < raw.length) {
    const commentStart = raw.indexOf('<!--', cursor)
    let tagStart = raw.indexOf('<', cursor)
    while (tagStart >= 0 && commentStart >= 0 && tagStart > commentStart) {
      const commentEnd = raw.indexOf('-->', commentStart + 4)
      if (commentEnd < 0) return
      cursor = commentEnd + 3
      tagStart = raw.indexOf('<', cursor)
    }
    if (tagStart < 0) return
    if (raw.startsWith('<!--', tagStart)) {
      const commentEnd = raw.indexOf('-->', tagStart + 4)
      if (commentEnd < 0) return
      cursor = commentEnd + 3
      continue
    }
    const openEnd = raw.indexOf('>', tagStart + 1)
    if (openEnd < 0) return
    const openingTag = raw.slice(tagStart, openEnd + 1)
    if (/^<\s*style\b/i.test(openingTag)) {
      if (plugin) report(emitter, baseOffset + tagStart, 'ui/no-plugin-css')
      const closeStart = raw.toLowerCase().indexOf('</style', openEnd + 1)
      if (closeStart < 0) {
        scanCssRange(emitter, baseOffset + openEnd + 1, baseOffset + raw.length, plugin)
        return
      }
      scanCssRange(emitter, baseOffset + openEnd + 1, baseOffset + closeStart, plugin)
      const closeEnd = raw.indexOf('>', closeStart + 2)
      cursor = closeEnd < 0 ? raw.length : closeEnd + 1
      continue
    }
    const rawTextTag = openingTag.match(/^<\s*(script|textarea)\b/i)?.[1]
    if (rawTextTag) {
      const closeStart = raw.toLowerCase().indexOf(`</${rawTextTag.toLowerCase()}`, openEnd + 1)
      if (closeStart < 0) return
      if (rawTextTag.toLowerCase() === 'script') {
        const typeMatch = /(?:^|\s)type\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(openingTag)
        const scriptType = (typeMatch?.[1] ?? typeMatch?.[2] ?? typeMatch?.[3] ?? '').trim().toLowerCase()
        const isJavaScript = scriptType === '' || scriptType === 'module' || ['text/javascript', 'application/javascript', 'text/ecmascript', 'application/ecmascript'].includes(scriptType)
        if (isJavaScript) {
          const contentStart = openEnd + 1
          const scriptText = raw.slice(contentStart, closeStart)
          const starts = [0]
          for (let index = 0; index < scriptText.length; index += 1) if (scriptText.charCodeAt(index) === 10) starts.push(index + 1)
          for (const diagnostic of scanTypeScriptSource(emitter.file, scriptText, plugin)) {
            const localOffset = (starts[diagnostic.line - 1] ?? scriptText.length) + diagnostic.column - 1
            report(emitter, baseOffset + contentStart + localOffset, diagnostic.rule)
          }
        }
      }
      const closeEnd = raw.indexOf('>', closeStart + 2)
      cursor = closeEnd < 0 ? raw.length : closeEnd + 1
      continue
    }
    const tagName = openingTag.match(/^<\s*([A-Za-z][A-Za-z0-9:-]*)/)?.[1]?.toLowerCase()
    const relMatch = /(?:^|\s)rel\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(openingTag)
    const relValue = relMatch?.[1] ?? relMatch?.[2] ?? relMatch?.[3] ?? ''
    if (plugin && tagName === 'link' && relValue.toLowerCase().split(/\s+/).includes('stylesheet')) {
      report(emitter, baseOffset + tagStart, 'ui/no-plugin-css')
    }
    const styleAttribute = /(?:^|\s)style\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(openingTag)
    if (styleAttribute) {
      const groupIndex = styleAttribute[1] !== undefined ? 1 : styleAttribute[2] !== undefined ? 2 : 3
      const styleText = styleAttribute[groupIndex] ?? ''
      const groupOffset = styleAttribute.index + styleAttribute[0].indexOf(styleText)
      scanInlineCss(emitter, baseOffset + tagStart + groupOffset, baseOffset + tagStart + groupOffset + styleText.length, plugin)
    }
    if (['svg', 'path', 'circle', 'rect', 'line', 'polyline', 'polygon', 'ellipse', 'text', 'stop', 'lineargradient', 'radialgradient', 'mask', 'g'].includes(tagName ?? '')) {
      const attributes = /(?:^|\s)(fill|stroke|color|stop-color|flood-color|lighting-color|stroke-width|width|height|r|rx|ry|cx|cy|x|y)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi
      for (const match of openingTag.matchAll(attributes)) {
        const groupIndex = match[2] !== undefined ? 2 : match[3] !== undefined ? 3 : 4
        const value = match[groupIndex] ?? ''
        const valueOffset = (match.index ?? 0) + match[0].indexOf(value)
        reportStyleValue(emitter, value, baseOffset + tagStart + valueOffset, match[1], true)
      }
    }
    cursor = openEnd + 1
  }
}


function cssTemplateStrings(node: ts.Expression): { text: string; offset: number }[] {
  const expression = unwrapExpression(node)
  if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) {
    const text = expression.getText()
    return [{ text: text.slice(1, -1), offset: expression.getStart() + 1 }]
  }
  if (ts.isTemplateExpression(expression)) {
    const result = [{ text: expression.head.text, offset: expression.head.getStart() + 1 }]
    for (const span of expression.templateSpans) {
      result.push({ text: span.literal.text, offset: span.literal.getStart() + 1 })
    }
    return result
  }
  return []
}

function scanCssLiteralTemplate(
  emitter: Emitter,
  expression: ts.Expression,
  sourceFile: ts.SourceFile,
  plugin: boolean,
  resolveStaticValue: (expression: ts.Expression) => { text: string; offset: number } | undefined
): void {
  const node = unwrapExpression(expression)
  if (!ts.isTemplateExpression(node)) {
    for (const part of cssTemplateStrings(node)) scanInlineCss(emitter, part.offset, part.offset + part.text.length, plugin)
    return
  }
  const chunks: string[] = []
  const originalOffsets: number[] = []
  const append = (text: string, offset: number) => {
    chunks.push(text)
    for (let index = 0; index < text.length; index += 1) originalOffsets.push(offset + index)
  }
  append(node.head.text, node.head.getStart(sourceFile) + 1)
  for (const span of node.templateSpans) {
    const staticValue = resolveStaticValue(span.expression)
    if (staticValue) append(staticValue.text, staticValue.offset)
    else append('__ui_dynamic__', span.expression.getStart(sourceFile))
    append(span.literal.text, span.literal.getStart(sourceFile) + 1)
  }
  const virtual = chunks.join('')
  const virtualEmitter = makeEmitter(emitter.file, virtual)
  scanCssRange(virtualEmitter, 0, virtual.length, plugin)
  for (const diagnostic of virtualEmitter.diagnostics) {
    report(emitter, originalOffsets[diagnostic.offset] ?? node.getStart(sourceFile), diagnostic.diagnostic.rule)
  }
}

function isCssImportSpecifier(text: string): boolean {
  return /\.(?:css|scss|sass|less)(?:[?#].*)?$/i.test(text)
}

function isCssKey(property: string): boolean {
  return isCssPropertyName(property)
}

function scanTypeScriptSource(file: string, source: string, plugin: boolean): UiLintDiagnostic[] {
  const emitter = makeEmitter(file, source)
  const scriptKind = /\.tsx$|\.jsx$/i.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, scriptKind)
  const declarations = new Map<string, ts.VariableDeclaration[]>()
  const styleElementVariables = new Set<string>()
  const styleSheetVariables = new Set<string>()
  const linkVariables = new Set<string>()
  const scannedObjects = new Set<ts.ObjectLiteralExpression>()
  const scannedExpressions = new Set<ts.Expression>()

  const isCreateElement = (expression: ts.Expression): 'style' | 'link' | undefined => {
    if (!ts.isCallExpression(expression)) return undefined
    const callee = expression.expression
    if (!ts.isPropertyAccessExpression(callee) || !['createElement', 'createElementNS'].includes(callee.name.text)) return undefined
    const objectName = callee.expression.getText(sourceFile)
    if (objectName !== 'document' && objectName !== 'window.document') return undefined
    const arg = expression.arguments[callee.name.text === 'createElementNS' ? 1 : 0]
    if (!arg || !ts.isStringLiteralLike(arg)) return undefined
    const tag = arg.text.toLowerCase()
    return tag === 'style' || tag === 'link' ? tag : undefined
  }

  const isStyleSheetConstructor = (expression: ts.Expression): boolean => ts.isNewExpression(expression) && ts.isIdentifier(expression.expression) && expression.expression.text === 'CSSStyleSheet'

  const collect = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      const list = declarations.get(node.name.text) ?? []
      list.push(node)
      declarations.set(node.name.text, list)
      const kind = node.initializer && isCreateElement(node.initializer)
      if (kind === 'style') styleElementVariables.add(node.name.text)
      if (kind === 'link') linkVariables.add(node.name.text)
      if (node.initializer && isStyleSheetConstructor(node.initializer)) styleSheetVariables.add(node.name.text)
    }
    ts.forEachChild(node, collect)
  }
  collect(sourceFile)

  const resolveVariable = (identifier: ts.Identifier): ts.Expression | undefined => {
    const candidates = declarations.get(identifier.text)
    if (!candidates) return undefined
    const position = identifier.getStart(sourceFile)
    let selected: ts.VariableDeclaration | undefined
    for (const candidate of candidates) {
      if (!candidate.initializer) continue
      if (candidate.getStart(sourceFile) <= position && (!selected || candidate.getStart(sourceFile) > selected.getStart(sourceFile))) selected = candidate
    }
    selected ??= candidates.find((candidate) => candidate.initializer)
    return selected?.initializer
  }

  const staticNumber = (expression: ts.Expression, seen = new Set<ts.Expression>()): { value: number; offset: number } | undefined => {
    const node = unwrapExpression(expression)
    if (seen.has(node)) return undefined
    seen.add(node)
    if (ts.isNumericLiteral(node)) return { value: Number(node.text.replaceAll('_', '')), offset: node.getStart(sourceFile) }
    if (ts.isPrefixUnaryExpression(node) && (node.operator === ts.SyntaxKind.MinusToken || node.operator === ts.SyntaxKind.PlusToken) && ts.isNumericLiteral(node.operand)) {
      const value = Number(node.operand.text.replaceAll('_', '')) * (node.operator === ts.SyntaxKind.MinusToken ? -1 : 1)
      return { value, offset: node.getStart(sourceFile) }
    }
    if (ts.isIdentifier(node)) {
      const initializer = resolveVariable(node)
      if (initializer) return staticNumber(initializer, seen)
    }
    return undefined
  }

  function staticString(expression: ts.Expression, seen = new Set<ts.Expression>()): { text: string; offset: number } | undefined {
    const node = unwrapExpression(expression)
    if (seen.has(node)) return undefined
    seen.add(node)
    if (ts.isStringLiteralLike(node) || ts.isNoSubstitutionTemplateLiteral(node)) return cssTemplateStrings(node)[0]
    if (ts.isIdentifier(node)) {
      const initializer = resolveVariable(node)
      return initializer ? staticString(initializer, seen) : undefined
    }
    return undefined
  }

  function staticCssValue(expression: ts.Expression, seen = new Set<ts.Expression>()): { text: string; offset: number } | undefined {
    const node = unwrapExpression(expression)
    if (seen.has(node)) return undefined
    seen.add(node)
    if (ts.isNumericLiteral(node) || (ts.isPrefixUnaryExpression(node) && (node.operator === ts.SyntaxKind.MinusToken || node.operator === ts.SyntaxKind.PlusToken) && ts.isNumericLiteral(node.operand))) {
      return { text: node.getText(sourceFile), offset: node.getStart(sourceFile) }
    }
    if (ts.isStringLiteralLike(node) || ts.isNoSubstitutionTemplateLiteral(node)) return staticString(node)
    if (ts.isIdentifier(node)) {
      const initializer = resolveVariable(node)
      return initializer ? staticCssValue(initializer, seen) : undefined
    }
    return undefined
  }

  function scanCssTemplate(expression: ts.Expression, seen = new Set<ts.Expression>()): void {
    const node = unwrapExpression(expression)
    if (seen.has(node)) return
    seen.add(node)
    if (ts.isIdentifier(node)) {
      const initializer = resolveVariable(node)
      if (initializer) scanCssTemplate(initializer, seen)
      return
    }
    scanCssLiteralTemplate(emitter, node, sourceFile, plugin, staticCssValue)
  }

  const scanObject = (object: ts.ObjectLiteralExpression, mode: 'style' | 'codemirror'): void => {
    if (scannedObjects.has(object)) return
    scannedObjects.add(object)
    for (const property of object.properties) {
      if (ts.isSpreadAssignment(property)) {
        scanStyleExpression(property.expression, mode)
        continue
      }
      if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) continue
      const key = propertyNameOf(property.name)
      if (!key) continue
      const value = ts.isPropertyAssignment(property) ? property.initializer : property.name
      const unwrappedValue = unwrapExpression(value)
      const nestedObject = ts.isObjectLiteralExpression(unwrappedValue) || ts.isArrayLiteralExpression(unwrappedValue)
      const selectorKey = key.startsWith('.') || key.startsWith('&') || key.startsWith(':') || key.startsWith('@') || key.startsWith('[') || key === 'to' || key === 'from'
      if (mode === 'codemirror' && (selectorKey || nestedObject || !isCssKey(key))) {
        scanStyleExpression(value, 'codemirror')
        continue
      }
      if (nestedObject) {
        scanStyleExpression(value, mode)
        continue
      }
      scanStyleProperty(key, value)
    }
  }

  const scanStyleExpression = (expression: ts.Expression, mode: 'style' | 'codemirror'): void => {
    const node = unwrapExpression(expression)
    if (mode === 'style' && (ts.isStringLiteralLike(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node))) {
      scanCssTemplate(node)
      return
    }
    if (scannedExpressions.has(node)) return
    if (ts.isObjectLiteralExpression(node)) {
      scanObject(node, mode)
      return
    }
    if (ts.isArrayLiteralExpression(node)) {
      scannedExpressions.add(node)
      for (const element of node.elements) if (!ts.isOmittedExpression(element)) scanStyleExpression(element, mode)
      return
    }
    if (ts.isIdentifier(node)) {
      scannedExpressions.add(node)
      const initializer = resolveVariable(node)
      if (initializer) scanStyleExpression(initializer, mode)
      return
    }
    if (ts.isConditionalExpression(node)) {
      scannedExpressions.add(node)
      scanStyleExpression(node.whenTrue, mode)
      scanStyleExpression(node.whenFalse, mode)
      return
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.expression.getText(sourceFile) === 'Object' && node.expression.name.text === 'assign') {
      scannedExpressions.add(node)
      for (const argument of node.arguments) scanStyleExpression(argument, mode)
    }
  }

  const scanStyleProperty = (property: string, expression: ts.Expression, seen = new Set<ts.Expression>()): void => {
    const value = unwrapExpression(expression)
    if (seen.has(value)) return
    seen.add(value)
    if (ts.isConditionalExpression(value)) {
      scanStyleProperty(property, value.whenTrue, seen)
      scanStyleProperty(property, value.whenFalse, seen)
      return
    }
    if (ts.isBinaryExpression(value) && (value.operatorToken.kind === ts.SyntaxKind.BarBarToken || value.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken || value.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)) {
      scanStyleProperty(property, value.left, seen)
      scanStyleProperty(property, value.right, seen)
      return
    }
    const staticValue = staticNumber(value)
    if (staticValue && staticValue.value !== 0 && !propertyIsUnitless(property) && !property.startsWith('--')) {
      report(emitter, staticValue.offset, 'ui/no-raw-pixel')
      return
    }
    if (ts.isIdentifier(value)) {
      const initializer = resolveVariable(value)
      if (initializer) {
        scanStyleProperty(property, initializer, seen)
        return
      }
    }
    if (ts.isTemplateExpression(value)) {
      let prefix = value.head.text
      for (const span of value.templateSpans) {
        if (!isInsideCssOpaqueContext(prefix)) {
          const staticPart = staticNumber(span.expression)
          if (/^\s*px\b/i.test(span.literal.text) && staticPart && staticPart.value !== 0) {
            report(emitter, staticPart.offset, 'ui/no-raw-pixel')
          }
          const staticText = staticString(span.expression)
          if (staticText) reportStyleValue(emitter, staticText.text, staticText.offset, property, true)
        }
        prefix += span.literal.text
      }
    }
    for (const part of cssTemplateStrings(value)) reportStyleValue(emitter, part.text, part.offset, property, true)
    if (ts.isObjectLiteralExpression(value) || ts.isArrayLiteralExpression(value)) scanStyleExpression(value, 'style')
  }

  const scanStyleAttribute = (attribute: ts.JsxAttribute): void => {
    const initializer = attribute.initializer
    if (!initializer) return
    if (ts.isStringLiteral(initializer)) {
      scanInlineCss(emitter, initializer.getStart(sourceFile) + 1, initializer.end - 1, plugin)
      return
    }
    if (ts.isJsxExpression(initializer) && initializer.expression) scanStyleExpression(initializer.expression, 'style')
  }

  const scanJsxStyleElement = (element: ts.JsxElement | ts.JsxSelfClosingElement): void => {
    if (!ts.isJsxElement(element)) return
    const opening = element.openingElement
    if (!ts.isIdentifier(opening.tagName) || opening.tagName.text.toLowerCase() !== 'style') return
    if (plugin) report(emitter, opening.getStart(sourceFile), 'ui/no-plugin-css')
    for (const child of element.children) {
      if (ts.isJsxText(child)) scanInlineCss(emitter, child.getStart(sourceFile), child.end, plugin)
      else if (ts.isJsxExpression(child) && child.expression) scanCssTemplate(child.expression)
    }
  }

  const scanCodeMirrorCall = (node: ts.CallExpression): boolean => {
    if (!ts.isPropertyAccessExpression(node.expression)) return false
    const receiver = node.expression.expression.getText(sourceFile)
    const method = node.expression.name.text
    if ((receiver === 'EditorView' && method === 'theme') || (receiver === 'HighlightStyle' && method === 'define')) {
      for (const argument of node.arguments) scanStyleExpression(argument, 'codemirror')
      return true
    }
    return false
  }

  const stringArgument = (expression: ts.Expression | undefined): boolean => {
    if (!expression) return false
    const node = unwrapExpression(expression)
    return ts.isStringLiteralLike(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node) || (ts.isIdentifier(node) && !!staticString(node))
  }

  function scanHtmlArgument(expression: ts.Expression, seen = new Set<ts.Expression>()): void {
    const node = unwrapExpression(expression)
    if (seen.has(node)) return
    seen.add(node)
    if (ts.isIdentifier(node)) {
      const initializer = resolveVariable(node)
      if (initializer) scanHtmlArgument(initializer, seen)
      return
    }
    for (const part of cssTemplateStrings(node)) scanHtmlText(emitter, part.text, part.offset, plugin)
  }

  function findObjectProperty(expression: ts.Expression, propertyName: string, seen = new Set<ts.Expression>()): ts.Expression | undefined {
    const node = unwrapExpression(expression)
    if (seen.has(node)) return undefined
    seen.add(node)
    if (ts.isIdentifier(node)) {
      const initializer = resolveVariable(node)
      return initializer ? findObjectProperty(initializer, propertyName, seen) : undefined
    }
    if (!ts.isObjectLiteralExpression(node)) return undefined
    for (let index = node.properties.length - 1; index >= 0; index -= 1) {
      const property = node.properties[index]
      if (ts.isSpreadAssignment(property)) {
        const spreadValue = findObjectProperty(property.expression, propertyName, seen)
        if (spreadValue) return spreadValue
      } else if (ts.isPropertyAssignment(property) && propertyNameOf(property.name) === propertyName) {
        return property.initializer
      } else if (ts.isShorthandPropertyAssignment(property) && property.name.text === propertyName) {
        return property.name
      }
    }
    return undefined
  }

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      const specifier = node.moduleSpecifier
      if (plugin && specifier && ts.isStringLiteralLike(specifier) && isCssImportSpecifier(specifier.text)) {
        report(emitter, specifier.getStart(sourceFile), 'ui/no-plugin-css')
      }
    }
    if (ts.isCallExpression(node) && plugin && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) {
      const specifier = node.arguments[0]
      if (specifier && ts.isStringLiteralLike(specifier) && isCssImportSpecifier(specifier.text)) report(emitter, specifier.getStart(sourceFile), 'ui/no-plugin-css')
    }
    if (ts.isJsxAttribute(node) && ts.isIdentifier(node.name) && node.name.text === 'style') scanStyleAttribute(node)
    if (ts.isJsxElement(node)) scanJsxStyleElement(node)
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tagName = node.tagName.getText(sourceFile).toLowerCase()
      if (plugin && tagName === 'style' && ts.isJsxSelfClosingElement(node)) report(emitter, node.getStart(sourceFile), 'ui/no-plugin-css')
      if (plugin && tagName === 'link') {
        const rel = node.attributes.properties.find((attribute) => ts.isJsxAttribute(attribute) && ts.isIdentifier(attribute.name) && attribute.name.text === 'rel')
        if (rel && ts.isJsxAttribute(rel) && rel.initializer && ts.isStringLiteral(rel.initializer) && rel.initializer.text.toLowerCase().split(/\s+/).includes('stylesheet')) {
          report(emitter, node.getStart(sourceFile), 'ui/no-plugin-css')
        }
      }
      if (['svg', 'path', 'circle', 'rect', 'line', 'polyline', 'polygon', 'ellipse', 'text', 'stop', 'lineargradient', 'radialgradient', 'mask', 'g'].includes(tagName)) {
        for (const attribute of node.attributes.properties) {
          if (!ts.isJsxAttribute(attribute) || !ts.isIdentifier(attribute.name) || !attribute.initializer) continue
          const property = attribute.name.text
          if (!['fill', 'stroke', 'color', 'stopcolor', 'floodcolor', 'lightingcolor', 'strokewidth', 'width', 'height', 'r', 'rx', 'ry', 'cx', 'cy', 'x', 'y'].includes(property.toLowerCase())) continue
          if (ts.isStringLiteral(attribute.initializer)) {
            const value = attribute.initializer
            reportStyleValue(emitter, value.text, value.getStart(sourceFile) + 1, property, true)
          } else if (ts.isJsxExpression(attribute.initializer) && attribute.initializer.expression && isColorProperty(property)) {
            const value = staticString(attribute.initializer.expression)
            if (value) reportStyleValue(emitter, value.text, value.offset, property, true)
          }
        }
      }
    }
    if (ts.isTaggedTemplateExpression(node)) {
      const tagText = node.tag.getText(sourceFile)
      if (/^(?:css|stylesheet|style|keyframes)$/.test(tagText) || /^styled(?:\.|\s*\()/.test(tagText)) {
        if (plugin) report(emitter, node.tag.getStart(sourceFile), 'ui/no-plugin-css')
        scanCssTemplate(node.template)
      }
    }
    if (ts.isCallExpression(node)) {
      scanCodeMirrorCall(node)
      const createdKind = isCreateElement(node)
      const elementName = ts.isPropertyAccessExpression(node.expression) ? node.expression.name.text : ''
      const elementTagIndex = elementName === 'createElementNS' ? 1 : 0
      const elementTag = node.arguments[elementTagIndex]
      if (createdKind === 'style' && plugin) report(emitter, elementTag?.getStart(sourceFile) ?? node.getStart(sourceFile), 'ui/no-plugin-css')
      if (createdKind === 'link' && plugin) {
        const parentDeclaration = node.parent
        const isAssigned = ts.isVariableDeclaration(parentDeclaration) && ts.isIdentifier(parentDeclaration.name)
        if (!isAssigned) report(emitter, node.getStart(sourceFile), 'ui/no-plugin-css')
      }
      if (ts.isPropertyAccessExpression(node.expression)) {
        const method = node.expression.name.text
        const receiverName = node.expression.expression.getText(sourceFile)
        const isKnownSheet = styleSheetVariables.has(receiverName) || receiverName.includes('.styleSheets[') || receiverName.includes('.adoptedStyleSheets[')
        if (plugin && isKnownSheet && ['replace', 'replaceSync', 'insertRule', 'deleteRule', 'addRule', 'removeRule'].includes(method)) {
          report(emitter, node.expression.name.getStart(sourceFile), 'ui/no-plugin-css')
        }
        if (plugin && method === 'push' && receiverName.includes('.adoptedStyleSheets')) {
          report(emitter, node.expression.name.getStart(sourceFile), 'ui/no-plugin-css')
        }
        if (isKnownSheet && ['replace', 'replaceSync', 'insertRule', 'addRule'].includes(method) && node.arguments[0] && stringArgument(node.arguments[0])) {
          scanCssTemplate(node.arguments[0])
        }
        if (method === 'setProperty' && receiverName.endsWith('.style') && node.arguments.length > 1) {
          const property = node.arguments[0]
          const value = node.arguments[1]
          if (property && ts.isStringLiteralLike(property)) {
            scanStyleProperty(property.text, value)
          }
        }
        if (receiverName === 'document' && ['write', 'writeln'].includes(method) && node.arguments[0] && stringArgument(node.arguments[0])) {
          scanHtmlArgument(node.arguments[0])
        }
        if (method === 'createContextualFragment' && node.arguments[0] && stringArgument(node.arguments[0])) scanHtmlArgument(node.arguments[0])
        if (method === 'insertAdjacentHTML' && node.arguments[1] && stringArgument(node.arguments[1])) scanHtmlArgument(node.arguments[1])
        if ((method === 'append' || method === 'appendChild' || method === 'insertBefore') && styleElementVariables.has(receiverName)) {
          for (const argument of node.arguments) {
            if (stringArgument(argument)) scanCssTemplate(argument)
            else if (ts.isCallExpression(argument) && ts.isPropertyAccessExpression(argument.expression) && argument.expression.name.text === 'createTextNode' && argument.arguments[0] && stringArgument(argument.arguments[0])) {
              scanCssTemplate(argument.arguments[0])
            }
          }
        }
      }
      if (ts.isPropertyAccessExpression(node.expression) && node.expression.expression.getText(sourceFile) === 'Object' && node.expression.name.text === 'assign') {
        if (node.arguments[0]?.getText(sourceFile).endsWith('.style')) {
          for (const argument of node.arguments.slice(1)) scanStyleExpression(argument, 'style')
        }
      }
      if (node.expression.getText(sourceFile).endsWith('setAttribute') && node.arguments.length > 1) {
        const [name, value] = node.arguments
        if (name && ts.isStringLiteralLike(name) && name.text.toLowerCase() === 'style' && value && stringArgument(value)) scanCssTemplate(value)
        if (name && ts.isStringLiteralLike(name) && name.text.toLowerCase() === 'rel' && value && ts.isStringLiteralLike(value) && value.text.toLowerCase().split(/\s+/).includes('stylesheet') && plugin) {
          report(emitter, node.getStart(sourceFile), 'ui/no-plugin-css')
        }
        if (name && ts.isStringLiteralLike(name) && ['fill', 'stroke'].includes(name.text.toLowerCase()) && value) {
          scanStyleProperty(name.text, value)
        }
      }
      const elementFactory = ts.isIdentifier(node.expression)
        ? node.expression.text === 'createElement'
        : ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'createElement'
      if (elementFactory) {
        const tag = node.arguments[0]
        const props = node.arguments[1]
        if (props) {
          const style = findObjectProperty(props, 'style')
          if (style) scanStyleExpression(style, 'style')
        }
        if (tag && ts.isStringLiteralLike(tag)) {
          const tagName = tag.text.toLowerCase()
          if (tagName === 'style') {
            if (plugin) report(emitter, tag.getStart(sourceFile), 'ui/no-plugin-css')
            const dangerousHtml = props && findObjectProperty(props, 'dangerouslySetInnerHTML')
            const htmlText = dangerousHtml && findObjectProperty(dangerousHtml, '__html')
            if (htmlText && stringArgument(htmlText)) scanCssTemplate(htmlText)
            for (const child of node.arguments.slice(2)) if (stringArgument(child)) scanCssTemplate(child)
          } else if (tagName === 'link' && plugin) {
            const rel = props && findObjectProperty(props, 'rel')
            if (rel && cssTemplateStrings(rel).some((part) => part.text.toLowerCase().split(/\s+/).includes('stylesheet'))) {
              report(emitter, tag.getStart(sourceFile), 'ui/no-plugin-css')
            }
          }
        }
      }
      ts.forEachChild(node, visit)
      return
    }
    if (ts.isNewExpression(node) && isStyleSheetConstructor(node)) {
      if (plugin) report(emitter, node.expression.getStart(sourceFile), 'ui/no-plugin-css')
      ts.forEachChild(node, visit)
      return
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const left = node.left
      if (ts.isPropertyAccessExpression(left)) {
        const property = left.name.text
        const receiverName = left.expression.getText(sourceFile)
        if (property === 'adoptedStyleSheets' && plugin) report(emitter, left.name.getStart(sourceFile), 'ui/no-plugin-css')
        if (property === 'rel' && plugin && linkVariables.has(receiverName) && ts.isStringLiteralLike(node.right) && node.right.text.toLowerCase().split(/\s+/).includes('stylesheet')) {
          report(emitter, left.name.getStart(sourceFile), 'ui/no-plugin-css')
        }
        if ((property === 'textContent' || property === 'innerHTML') && styleElementVariables.has(receiverName)) {
          if (stringArgument(node.right)) scanCssTemplate(node.right)
          else scanStyleExpression(node.right, 'style')
        } else if (property === 'cssText' && receiverName.endsWith('.style')) {
          if (plugin) report(emitter, left.name.getStart(sourceFile), 'ui/no-plugin-css')
          if (stringArgument(node.right)) scanCssTemplate(node.right)
        } else if (property === 'innerHTML' && stringArgument(node.right)) scanHtmlArgument(node.right)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return finish(emitter)
}

function scanSource(file: string, source: string, options: UiLintOptions = {}): UiLintDiagnostic[] {
  const extension = extname(file).toLowerCase()
  if (cssExtensions.has(extension)) return scanCssSource(file, source, options.plugin ?? false)
  if (extension === '.html' || extension === '.htm' || extension === '.svg') {
    const emitter = makeEmitter(file, source)
    scanHtmlText(emitter, source, 0, options.plugin ?? false)
    return finish(emitter)
  }
  return scanTypeScriptSource(file, source, options.plugin ?? false)
}

export function scanSourceContent(file: string, source: string, options: UiLintOptions = {}): UiLintDiagnostic[] {
  return scanSource(file, source, options)
}

export function formatDiagnostic(diagnostic: UiLintDiagnostic): string {
  return `${diagnostic.file}:${diagnostic.line}:${diagnostic.column} ${diagnostic.rule}: ${diagnostic.message}`
}

export function parsePluginConfig(text: string, availablePluginIds: readonly string[]): string[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new Error(`Invalid scripts/ui-lint-plugins.json: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!Array.isArray(parsed)) throw new Error('Invalid scripts/ui-lint-plugins.json: expected an array of plugin directory IDs.')
  const available = new Set(availablePluginIds)
  const seen = new Set<string>()
  const ids: string[] = []
  for (const value of parsed) {
    if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) || value === '.' || value === '..') {
      throw new Error('Invalid scripts/ui-lint-plugins.json: each entry must be a safe immediate plugin directory ID.')
    }
    if (seen.has(value)) throw new Error(`Invalid scripts/ui-lint-plugins.json: duplicate plugin ID "${value}".`)
    if (!available.has(value)) throw new Error(`Invalid scripts/ui-lint-plugins.json: unknown plugin ID "${value}".`)
    seen.add(value)
    ids.push(value)
  }
  return ids
}

function immediatePluginDirectories(pluginRoot: string): string[] {
  return readdirSync(pluginRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.toLowerCase() !== 'test' && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(entry.name))
    .map((entry) => entry.name)
    .sort(compareText)
}

function shouldSkipPath(path: string): boolean {
  const parts = path.split(sep)
  if (parts.some((part) => excludedDirectories.has(part.toLowerCase()))) return true
  const file = parts.at(-1) ?? ''
  return /(?:^|[.-])(?:test|spec|fixture|fixtures)\.[^.]+$/i.test(file)
}

function collectSourceFiles(directory: string): string[] {
  const results: string[] = []
  const visit = (path: string) => {
    const entries = readdirSync(path, { withFileTypes: true }).sort((left, right) => compareText(left.name, right.name))
    for (const entry of entries) {
      const absolute = join(path, entry.name)
      if (entry.isSymbolicLink() || shouldSkipPath(relative(directory, absolute))) continue
      if (entry.isDirectory()) visit(absolute)
      else if (entry.isFile() && sourceExtensions.has(extname(entry.name).toLowerCase())) results.push(absolute)
    }
  }
  visit(directory)
  return results
}

function ensureDirectory(path: string, label: string): void {
  try {
    if (!statSync(path).isDirectory()) throw new Error(`${label} is not a directory: ${path}`)
  } catch (error) {
    throw new Error(`Cannot traverse ${label} at ${path}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

export function runUiLint(root = resolve(dirname(fileURLToPath(import.meta.url)), '..')): number {
  try {
    const uiSourceRoot = resolve(root, 'packages/ui/src')
    const pluginsRoot = resolve(root, 'plugins')
    const configPath = resolve(root, 'scripts/ui-lint-plugins.json')
    ensureDirectory(uiSourceRoot, 'packages/ui/src')
    ensureDirectory(pluginsRoot, 'plugins')
    const pluginIds = parsePluginConfig(readFileSync(configPath, 'utf8'), immediatePluginDirectories(pluginsRoot))
    const files = [
      ...collectSourceFiles(uiSourceRoot).map((path) => ({ path, plugin: false })),
      ...pluginIds.flatMap((id) => {
        const pluginRoot = resolve(pluginsRoot, id)
        if (relative(pluginsRoot, pluginRoot).startsWith('..') || pluginRoot === pluginsRoot) throw new Error(`Invalid plugin directory path: ${id}`)
        ensureDirectory(pluginRoot, `plugin ${id}`)
        return collectSourceFiles(pluginRoot).map((path) => ({ path, plugin: true }))
      })
    ]
    const diagnostics = files.flatMap(({ path, plugin }) => {
      const file = relative(root, path).split(sep).join('/')
      return scanSource(file, readFileSync(path, 'utf8'), { plugin })
    }).sort((left, right) => compareText(left.file, right.file) || left.line - right.line || left.column - right.column || compareText(left.rule, right.rule))
    for (const diagnostic of diagnostics) console.error(formatDiagnostic(diagnostic))
    return diagnostics.length === 0 ? 0 : 1
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    return 1
  }
}

if (import.meta.main) process.exitCode = runUiLint()
