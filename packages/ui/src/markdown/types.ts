import type { Components, CustomRenderer, StreamdownProps } from 'streamdown'

export type MarkdownProfile = 'untrusted' | 'file'

/** What a caller supplies so file paths and worktree images can resolve. Absent means no chips and no local images. */
export interface MarkdownAssets {
  /** Maps each candidate path as written to `{ line? }`, or null when the file does not exist. */
  resolveFiles(candidates: string[]): Promise<Record<string, { line?: number } | null>>
  /** Maps each image `src` as written to a displayable url, or null when it cannot be shown. */
  resolveImages(srcs: string[]): Promise<Record<string, string | null>>
  openFile(path: string, line?: number): void
}

export interface QuirkyMarkdownProps {
  text: string
  profile: MarkdownProfile
  streaming?: boolean
  /** The caller confirms with the user, then opens. The renderer never navigates. */
  onOpenLink(href: string): void
  assets?: MarkdownAssets
  remarkPlugins?: NonNullable<StreamdownProps['remarkPlugins']>
  rehypePlugins?: NonNullable<StreamdownProps['rehypePlugins']>
  components?: Partial<Components>
  renderers?: CustomRenderer[]
  className?: string
}

/** What a fence renderer receives, the same shape Streamdown hands a custom renderer. */
export interface FenceProps {
  code: string
  isIncomplete: boolean
  language: string
  meta?: string | undefined
}
