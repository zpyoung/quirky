import { useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { createCodePlugin } from '@streamdown/code'
import type { HighlightResult } from '@streamdown/code'
import { createCssVariablesTheme } from 'shiki'
import type { BundledLanguage } from 'shiki'

export const LINE_NUMBER_THRESHOLD = 8
export const COLLAPSE_THRESHOLD = 20
const COPIED_MS = 1200

const baseTheme = createCssVariablesTheme({ name: 'quirky', variablePrefix: '--shiki-' })

/** Shiki's css-variables theme has no number or type variable, so those scopes get their own. */
const cssVarsTheme = {
  ...baseTheme,
  tokenColors: [
    ...(baseTheme.tokenColors ?? []),
    { scope: ['constant.numeric'], settings: { foreground: 'var(--shiki-token-number)' } },
    {
      scope: ['entity.name.type', 'support.type', 'support.class', 'entity.other.inherited-class'],
      settings: { foreground: 'var(--shiki-token-type)' }
    }
  ]
}

const THEMES: [typeof cssVarsTheme, typeof cssVarsTheme] = [cssVarsTheme, cssVarsTheme]

/** Shiki highlighter whose colours are `--shiki-*` variables that markdown.css maps onto `--ui-syntax-*`. */
export const codePlugin = createCodePlugin({ themes: THEMES })

const TITLE_META = /(?:^|\s)title=(?:"([^"]*)"|'([^']*)'|(\S+))/

/** The `title=` value of a fence's meta string, such as ```` ```ts title=Prose.tsx ````. */
export function fenceTitle(meta: string | undefined): string | undefined {
  const match = meta ? TITLE_META.exec(meta) : null
  return match ? (match[1] ?? match[2] ?? match[3]) : undefined
}

function diffKind(line: string): 'add' | 'del' | 'ctx' {
  if (line.startsWith('+') && !line.startsWith('+++')) return 'add'
  if (line.startsWith('-') && !line.startsWith('---')) return 'del'
  return 'ctx'
}

const TOKEN_STYLE_KEYS: Record<string, keyof CSSProperties> = {
  color: 'color',
  'font-style': 'fontStyle',
  'font-weight': 'fontWeight',
  'text-decoration': 'textDecoration'
}

function tokenStyle(token: HighlightResult['tokens'][number][number]): CSSProperties | undefined {
  const style: Record<string, string> = {}
  if (token.color) style.color = token.color
  for (const [key, value] of Object.entries(token.htmlStyle ?? {})) {
    const mapped = TOKEN_STYLE_KEYS[key]
    if (mapped && typeof value === 'string') style[mapped] = value
  }
  return Object.keys(style).length > 0 ? (style as CSSProperties) : undefined
}

function useHighlighted(code: string, language: string, enabled: boolean): HighlightResult | null {
  // a cached result is returned synchronously, so a remounted block does not flash back to plain text
  const [result, setResult] = useState<HighlightResult | null>(() => (
    enabled ? codePlugin.highlight({ code, language: language as BundledLanguage, themes: THEMES, isIncomplete: false }) : null
  ))
  useEffect(() => {
    if (!enabled) {
      setResult(null)
      return
    }
    let live = true
    const ready = codePlugin.highlight({ code, language: language as BundledLanguage, themes: THEMES, isIncomplete: false }, (next) => {
      if (live) setResult(next)
    })
    if (ready) setResult(ready)
    return () => {
      live = false
    }
  }, [code, language, enabled])
  return result
}

/** The Copy button: writes the raw text and reads "Copied" for a moment. */
export function CopyButton({ code }: { code: string }) {
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current)
  }, [])
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code)
    } catch {
      return
    }
    setCopied(true)
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => setCopied(false), COPIED_MS)
  }
  return (
    <button type="button" className="qmd-code-button" data-streamdown="code-block-copy-button" onClick={() => void copy()}>
      {copied ? 'Copied' : 'Copy'}
    </button>
  )
}

/** The shared card around code, diagrams and data fences: a slim header with a label and actions. */
export function BlockFrame({ label, language, actions, children, state }: {
  label: string
  language: string
  actions: ReactNode
  children: ReactNode
  state?: Record<`data-${string}`, string | undefined>
}) {
  return (
    <div className="qmd-code" data-streamdown="code-block" data-language={language} {...state}>
      <div className="qmd-code-header" data-streamdown="code-block-header">
        <span className="qmd-code-title">{label}</span>
        <span className="qmd-code-actions">{actions}</span>
      </div>
      {children}
    </div>
  )
}

export interface CodeBlockProps {
  code: string
  language: string
  meta?: string | undefined
  isIncomplete: boolean
}

/**
 * A fenced code block with a header, Copy, line numbers past 8 lines and a collapse past 20. While the
 * fence is open it is plain text with a caret; Shiki runs once it closes, in the same line boxes.
 */
export function CodeBlock({ code, language, meta, isIncomplete }: CodeBlockProps) {
  const lines = useMemo(() => code.split('\n'), [code])
  const diff = language === 'diff'
  const highlightable = !isIncomplete && !diff && language !== '' && codePlugin.supportsLanguage(language as BundledLanguage)
  const highlighted = useHighlighted(code, language, highlightable)
  const [expanded, setExpanded] = useState(false)
  const collapsible = !isIncomplete && lines.length > COLLAPSE_THRESHOLD
  const collapsed = collapsible && !expanded
  const title = fenceTitle(meta) ?? (language || 'text')

  return (
    <BlockFrame
      label={title}
      language={language || 'text'}
      actions={<CopyButton code={code} />}
      state={{
        'data-incomplete': isIncomplete ? 'true' : undefined,
        'data-numbered': lines.length > LINE_NUMBER_THRESHOLD ? 'true' : undefined,
        'data-collapsed': collapsed ? 'true' : undefined,
        'data-highlighted': highlighted ? 'true' : undefined
      }}
    >
      <div className="qmd-code-body" data-streamdown="code-block-body">
        <pre>
          <code>
            {lines.map((line, index) => {
              const caret = isIncomplete && index === lines.length - 1
              const tokens = highlighted?.tokens[index]
              return (
                <span key={index} className="qmd-line" data-diff={diff ? diffKind(line) : undefined}>
                  {tokens?.length
                    ? tokens.map((token, position) => <span key={position} style={tokenStyle(token)}>{token.content}</span>)
                    : line === '' && !caret ? '\n' : line}
                  {caret ? <span className="qmd-caret" aria-hidden="true">{'\u258D'}</span> : null}
                </span>
              )
            })}
          </code>
        </pre>
        {collapsed ? <div className="qmd-code-fade" aria-hidden="true" /> : null}
      </div>
      {collapsible ? (
        <button type="button" className="qmd-code-toggle" onClick={() => setExpanded((value) => !value)} aria-expanded={expanded}>
          {expanded ? 'Show less' : `Show all ${lines.length} lines`}
        </button>
      ) : null}
    </BlockFrame>
  )
}
