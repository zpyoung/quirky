import { useEffect, useMemo, useRef, useState } from 'react'
import { createMathPlugin } from '@streamdown/math'
import rehypeRaw from 'rehype-raw'
import rehypeSanitize from 'rehype-sanitize'
import remarkBreaks from 'remark-breaks'
import remarkGemoji from 'remark-gemoji'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import { Streamdown, defaultRemarkPlugins } from 'streamdown'
import type { ControlsConfig, CustomRenderer, LinkSafetyConfig, PluginConfig } from 'streamdown'
import { codePlugin } from './blocks/CodeBlock'
import { BUILT_IN_RENDERERS, QUIRKY_COMPONENTS, RenderersContext } from './components'
import { collectChartSources, collectLocalImageSources, endsInOpenFence } from './fences'
import { escapeLooseDollars } from './math-dollars'
import { MATH_ERROR_COLOR } from './math-errors'
import { remarkHtmlAllowlist } from './remark-html-allowlist'
import { remarkMark } from './remark-mark'
import { collectPathCandidates, remarkPathCandidates } from './remark-path-candidates'
import { UNTRUSTED_SCHEMA, rehypeUndoubleClobber } from './sanitize'
import { ChartSourcesContext, FilesContext, ImagesContext, RuntimeContext } from './runtime'
import type { ChartSources, FileResolutions, ImageResolutions, MarkdownRuntime } from './runtime'
import type { MarkdownAssets, QuirkyMarkdownProps } from './types'

type Remark = NonNullable<QuirkyMarkdownProps['remarkPlugins']>
type Rehype = NonNullable<QuirkyMarkdownProps['rehypePlugins']>

const LINK_SAFETY: LinkSafetyConfig = { enabled: false }
const CONTROLS: ControlsConfig = { code: { copy: true, download: false }, table: false, mermaid: false, image: false }
const MATH_OPTIONS = { singleDollarTextMath: true, errorColor: MATH_ERROR_COLOR }
const UNTRUSTED_MATH = createMathPlugin(MATH_OPTIONS)
const UNTRUSTED_REHYPE: Rehype = [rehypeRaw, [rehypeSanitize, UNTRUSTED_SCHEMA], rehypeUndoubleClobber]
const CODE_META = defaultRemarkPlugins.codeMeta
const EMPTY_SOURCES: ChartSources = {}
const NO_STRINGS: string[] = []

interface AssetCache {
  files: Map<string, { line?: number } | null>
  images: Map<string, string | null>
  pending: Map<string, Promise<void>>
}

const caches = new WeakMap<MarkdownAssets, AssetCache>()

function cacheFor(assets: MarkdownAssets): AssetCache {
  let cache = caches.get(assets)
  if (!cache) {
    cache = { files: new Map(), images: new Map(), pending: new Map() }
    caches.set(assets, cache)
  }
  return cache
}

function settle<T>(
  cache: AssetCache,
  kind: 'file' | 'image',
  keys: string[],
  store: Map<string, T | null>,
  request: (missing: string[]) => Promise<Record<string, T | null>>
): Promise<void>[] {
  const fresh = keys.filter((key) => !store.has(key) && !cache.pending.has(`${kind}:${key}`))
  if (fresh.length > 0) {
    const batch = Promise.resolve()
      .then(() => request(fresh))
      .then((result) => {
        for (const key of fresh) store.set(key, result[key] ?? null)
      })
      .catch(() => {
        for (const key of fresh) store.set(key, null)
      })
      .finally(() => {
        for (const key of fresh) cache.pending.delete(`${kind}:${key}`)
      })
    for (const key of fresh) cache.pending.set(`${kind}:${key}`, batch)
  }
  return keys.filter((key) => !store.has(key)).map((key) => cache.pending.get(`${kind}:${key}`) as Promise<void>)
}

/** Resolves path candidates and image sources through the caller's assets, caching per assets instance. */
function useAssetResolutions(assets: MarkdownAssets | undefined, files: string[], images: string[]) {
  const [version, setVersion] = useState(0)
  useEffect(() => {
    if (!assets || (files.length === 0 && images.length === 0)) return
    const cache = cacheFor(assets)
    const waiting = [
      ...settle(cache, 'file', files, cache.files, (missing) => assets.resolveFiles(missing)),
      ...settle(cache, 'image', images, cache.images, (missing) => assets.resolveImages(missing))
    ]
    if (waiting.length === 0) {
      setVersion((value) => value + 1)
      return
    }
    let live = true
    void Promise.all(waiting).then(() => {
      if (live) setVersion((value) => value + 1)
    })
    return () => {
      live = false
    }
  }, [assets, files, images])
  return useMemo(() => {
    const resolved: { files: FileResolutions; images: ImageResolutions } = { files: {}, images: {} }
    const cache = assets ? caches.get(assets) : undefined
    if (!cache) return resolved
    for (const key of files) if (cache.files.has(key)) resolved.files[key] = cache.files.get(key) ?? null
    for (const key of images) if (cache.images.has(key)) resolved.images[key] = cache.images.get(key) ?? null
    return resolved
    // version is what changes when a request settles and fills the cache
  }, [assets, files, images, version])
}

/** Keeps the chart-source context identical while the sources themselves are unchanged. */
function useStableSources(sources: ChartSources): ChartSources {
  const key = JSON.stringify(sources)
  return useMemo(() => (key === '{}' ? EMPTY_SOURCES : sources), [key])
}

/**
 * The shared markdown renderer. `untrusted` is for agent text: markdown only, raw HTML as text except
 * a few attribute-free tags, links and remote images handed to the caller. `file` is for a user's own
 * document and takes the caller's own cleaning pipeline in `rehypePlugins`.
 */
export function QuirkyMarkdown({
  text,
  profile,
  streaming = false,
  onOpenLink,
  assets,
  remarkPlugins,
  rehypePlugins,
  components,
  renderers,
  className
}: QuirkyMarkdownProps) {
  if (profile === 'untrusted' && rehypePlugins !== undefined) throw new Error('untrusted profile takes no rehypePlugins')
  if (profile === 'file' && (rehypePlugins === undefined || rehypePlugins.length === 0)) throw new Error('file profile requires rehypePlugins')

  const runtime = useRef<MarkdownRuntime>({ onOpenLink, assets })
  runtime.current = { onOpenLink, assets }

  const untrusted = profile === 'untrusted'
  const hasAssets = assets !== undefined && untrusted

  const config = useMemo(() => {
    const remark: Remark = untrusted
      ? [CODE_META, remarkGfm, remarkBreaks, remarkMark, remarkGemoji, remarkHtmlAllowlist, ...(hasAssets ? [remarkPathCandidates] : []), ...(remarkPlugins ?? [])]
      : [CODE_META, remarkGfm, remarkMark, remarkGemoji, [remarkMath, { singleDollarTextMath: true }], ...(remarkPlugins ?? [])]
    const plugins: PluginConfig = untrusted ? { code: codePlugin, math: UNTRUSTED_MATH } : { code: codePlugin }
    return {
      remark,
      rehype: untrusted ? UNTRUSTED_REHYPE : (rehypePlugins as Rehype),
      plugins,
      components: { ...QUIRKY_COMPONENTS, ...components },
      renderers: [...(renderers ?? []), ...BUILT_IN_RENDERERS] satisfies CustomRenderer[]
    }
  }, [untrusted, hasAssets, remarkPlugins, rehypePlugins, components, renderers])

  const prepared = useMemo(() => escapeLooseDollars(text), [text])
  const resolving = hasAssets && !streaming
  const files = useMemo(() => (resolving ? collectPathCandidates(text) : NO_STRINGS), [resolving, text])
  const images = useMemo(() => (resolving ? collectLocalImageSources(text) : NO_STRINGS), [resolving, text])
  const resolved = useAssetResolutions(resolving ? assets : undefined, files, images)
  const sources = useStableSources(useMemo(() => collectChartSources(text), [text]))
  const caretInBlock = streaming && endsInOpenFence(prepared)

  return (
    <div className={className ? `qmd ${className}` : 'qmd'} data-profile={profile} data-streaming={streaming ? 'true' : undefined}>
      <RuntimeContext.Provider value={runtime}>
        <FilesContext.Provider value={resolved.files}>
          <ImagesContext.Provider value={resolved.images}>
            <ChartSourcesContext.Provider value={sources}>
              <RenderersContext.Provider value={config.renderers}>
                <Streamdown
                  mode={streaming ? 'streaming' : 'static'}
                  isAnimating={streaming}
                  parseIncompleteMarkdown
                  prefix="sd"
                  linkSafety={LINK_SAFETY}
                  controls={CONTROLS}
                  tableMaxHeight="none"
                  plugins={config.plugins}
                  remarkPlugins={config.remark}
                  rehypePlugins={config.rehype}
                  components={config.components}
                  data-qmd-body=""
                >
                  {prepared}
                </Streamdown>
              </RenderersContext.Provider>
            </ChartSourcesContext.Provider>
          </ImagesContext.Provider>
        </FilesContext.Provider>
      </RuntimeContext.Provider>
      {streaming && !caretInBlock ? <span className="qmd-caret" aria-hidden="true">{'▍'}</span> : null}
    </div>
  )
}
