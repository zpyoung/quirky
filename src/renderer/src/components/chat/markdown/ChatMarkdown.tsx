import { useEffect, useMemo, useRef, useState } from 'react'
import { createMathPlugin } from '@streamdown/math'
import rehypeRaw from 'rehype-raw'
import rehypeSanitize from 'rehype-sanitize'
import remarkBreaks from 'remark-breaks'
import remarkGemoji from 'remark-gemoji'
import remarkGfm from 'remark-gfm'
import { Streamdown, defaultRemarkPlugins } from 'streamdown'
import type {
  ControlsConfig,
  CustomRenderer,
  LinkSafetyConfig,
  PluginConfig,
  StreamdownProps
} from 'streamdown'
import { codePlugin } from './blocks/CodeBlock'
import {
  BUILT_IN_RENDERERS,
  CHAT_COMPONENTS,
  OpenFenceContext,
  RenderersContext,
  StreamingContext
} from './components'
import { collectChartSources, collectLocalImageSources, openFenceAtEnd } from './fences'
import { MATH_ERROR_COLOR } from './math-errors'
import { remarkHtmlAllowlist } from './remark-html-allowlist'
import { remarkLooseDollars } from './remark-loose-dollars'
import { remarkMark } from './remark-mark'
import { collectPathCandidates, remarkPathCandidates } from './remark-path-candidates'
import { UNTRUSTED_SCHEMA, rehypeUndoubleClobber } from './sanitize'
import { ChartSourcesContext, FilesContext, ImagesContext, RuntimeContext } from './runtime'
import type { ChartSources, FileResolutions, ImageResolutions, MarkdownRuntime } from './runtime'
import type { ChatMarkdownAssets, ChatMarkdownProps } from './types'
import './chat-markdown.css'

type Remark = NonNullable<ChatMarkdownProps['remarkPlugins']>
type Rehype = NonNullable<StreamdownProps['rehypePlugins']>

const LINK_SAFETY: LinkSafetyConfig = { enabled: false }
const CONTROLS: ControlsConfig = {
  code: { copy: true, download: false },
  table: false,
  mermaid: false,
  image: false
}
const MATH_OPTIONS = { singleDollarTextMath: true, errorColor: MATH_ERROR_COLOR }
const MATH = createMathPlugin(MATH_OPTIONS)
const REHYPE: Rehype = [rehypeRaw, [rehypeSanitize, UNTRUSTED_SCHEMA], rehypeUndoubleClobber]
const CODE_META = defaultRemarkPlugins.codeMeta
const EMPTY_SOURCES: ChartSources = {}
const PLUGINS: PluginConfig = { code: codePlugin, math: MATH }
const NO_STRINGS: string[] = []

type AssetCache = {
  files: Map<string, { line?: number } | null>
  images: Map<string, string | null>
  pending: Map<string, Promise<void>>
}

const caches = new WeakMap<ChatMarkdownAssets, AssetCache>()

function cacheFor(assets: ChatMarkdownAssets): AssetCache {
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
        for (const key of fresh) {
          store.set(key, result[key] ?? null)
        }
      })
      .catch(() => {
        for (const key of fresh) {
          store.set(key, null)
        }
      })
      .finally(() => {
        for (const key of fresh) {
          cache.pending.delete(`${kind}:${key}`)
        }
      })
    for (const key of fresh) {
      cache.pending.set(`${kind}:${key}`, batch)
    }
  }
  return keys.flatMap((key) => {
    const batch = store.has(key) ? undefined : cache.pending.get(`${kind}:${key}`)
    return batch ? [batch] : []
  })
}

/** Resolves path candidates and image sources through the caller's assets, caching per assets instance. */
function useAssetResolutions(
  assets: ChatMarkdownAssets | undefined,
  files: string[],
  images: string[]
) {
  const [version, setVersion] = useState(0)
  useEffect(() => {
    if (!assets || (files.length === 0 && images.length === 0)) {
      return
    }
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
      if (live) {
        setVersion((value) => value + 1)
      }
    })
    return () => {
      live = false
    }
  }, [assets, files, images])
  return useMemo(() => {
    const resolved: { files: FileResolutions; images: ImageResolutions } = { files: {}, images: {} }
    const cache = assets ? caches.get(assets) : undefined
    if (!cache) {
      return resolved
    }
    for (const key of files) {
      if (cache.files.has(key)) {
        resolved.files[key] = cache.files.get(key) ?? null
      }
    }
    for (const key of images) {
      if (cache.images.has(key)) {
        resolved.images[key] = cache.images.get(key) ?? null
      }
    }
    return resolved
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- version changes when a request settles and fills the cache
  }, [assets, files, images, version])
}

/** Keeps the chart-source context identical while the sources themselves are unchanged. */
function useStableSources(sources: ChartSources): ChartSources {
  const key = JSON.stringify(sources)
  // oxlint-disable-next-line react-hooks/exhaustive-deps -- the serialized key stands for the sources' content
  return useMemo(() => (key === '{}' ? EMPTY_SOURCES : sources), [key])
}

/**
 * The chat transcript's markdown renderer for agent text: markdown only, raw HTML as text except a few
 * attribute-free tags, links and remote images handed to the caller, file paths and workspace images
 * resolved through `assets`.
 */
export function ChatMarkdown({
  text,
  streaming = false,
  onOpenLink,
  assets,
  remarkPlugins,
  components,
  renderers,
  className
}: ChatMarkdownProps) {
  const runtime = useRef<MarkdownRuntime>({ onOpenLink, assets })
  runtime.current = { onOpenLink, assets }

  const hasAssets = assets !== undefined

  const config = useMemo(
    () => ({
      remark: [
        remarkLooseDollars,
        CODE_META,
        remarkGfm,
        remarkBreaks,
        remarkMark,
        remarkGemoji,
        remarkHtmlAllowlist,
        ...(hasAssets ? [remarkPathCandidates] : []),
        ...(remarkPlugins ?? [])
      ] satisfies Remark,
      components: { ...CHAT_COMPONENTS, ...components },
      renderers: [...(renderers ?? []), ...BUILT_IN_RENDERERS] satisfies CustomRenderer[]
    }),
    [hasAssets, remarkPlugins, components, renderers]
  )

  const resolving = hasAssets && !streaming
  const files = useMemo(
    () => (resolving ? collectPathCandidates(text) : NO_STRINGS),
    [resolving, text]
  )
  const images = useMemo(
    () => (resolving ? collectLocalImageSources(text) : NO_STRINGS),
    [resolving, text]
  )
  const resolved = useAssetResolutions(resolving ? assets : undefined, files, images)
  const sources = useStableSources(useMemo(() => collectChartSources(text), [text]))
  const openFence = useMemo(() => (streaming ? openFenceAtEnd(text) : null), [streaming, text])
  const caretInBlock = openFence !== null

  return (
    <div
      className={className ? `qmd ${className}` : 'qmd'}
      data-streaming={streaming ? 'true' : undefined}
    >
      <RuntimeContext.Provider value={runtime}>
        <StreamingContext.Provider value={streaming}>
          <OpenFenceContext.Provider value={openFence}>
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
                      plugins={PLUGINS}
                      remarkPlugins={config.remark}
                      rehypePlugins={REHYPE}
                      components={config.components}
                      data-qmd-body=""
                    >
                      {text}
                    </Streamdown>
                  </RenderersContext.Provider>
                </ChartSourcesContext.Provider>
              </ImagesContext.Provider>
            </FilesContext.Provider>
          </OpenFenceContext.Provider>
        </StreamingContext.Provider>
      </RuntimeContext.Provider>
      {streaming && !caretInBlock ? (
        <span className="qmd-caret" aria-hidden="true">
          ▍
        </span>
      ) : null}
    </div>
  )
}
