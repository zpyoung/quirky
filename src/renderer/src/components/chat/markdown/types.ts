import type { Components, CustomRenderer, StreamdownProps } from 'streamdown'

/** What a caller supplies so file paths and workspace images can resolve. Absent means no chips and no local images. */
export type ChatMarkdownAssets = {
  /** Maps each candidate path as written to `{ line? }`, or null when the file does not exist in the workspace. */
  resolveFiles(candidates: string[]): Promise<Record<string, { line?: number } | null>>
  /** Maps each image `src` as written to a displayable url, or null when it cannot be shown. Paths resolve inside the workspace only. */
  resolveImages(srcs: string[]): Promise<Record<string, string | null>>
  /** Opens a resolved path in the editor; `path` is the candidate as written, relative to the workspace root. */
  openFile(path: string, line?: number): void
}

export type ChatMarkdownProps = {
  text: string
  streaming?: boolean
  /** The caller decides how an http(s) link opens. The renderer never navigates. */
  onOpenLink(href: string): void
  assets?: ChatMarkdownAssets
  remarkPlugins?: NonNullable<StreamdownProps['remarkPlugins']>
  components?: Partial<Components>
  renderers?: CustomRenderer[]
  className?: string
}

/** What a fence renderer receives, the same shape Streamdown hands a custom renderer. */
export type FenceProps = {
  code: string
  isIncomplete: boolean
  language: string
  meta?: string | undefined
}
