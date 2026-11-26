import { createContext } from 'react'
import type { MutableRefObject } from 'react'
import type { ChatMarkdownAssets } from './types'

export type MarkdownRuntime = {
  onOpenLink(href: string): void
  assets: ChatMarkdownAssets | undefined
}

/** Holds the latest caller callbacks in a ref, so the component map handed to Streamdown never changes identity. */
export const RuntimeContext = createContext<MutableRefObject<MarkdownRuntime>>({
  current: { onOpenLink: () => {}, assets: undefined }
})

export type FileResolutions = Record<string, { line?: number } | null>
export type ImageResolutions = Record<string, string | null>
export type ChartSources = Record<string, { language: string; code: string }>

export const FilesContext = createContext<FileResolutions>({})
export const ImagesContext = createContext<ImageResolutions>({})
export const ChartSourcesContext = createContext<ChartSources>({})
export const InsideBlockquoteContext = createContext(false)
