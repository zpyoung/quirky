import { codeSpan, feedbackBlock } from '@quirky/ui/annotation-markdown'
import type { Comment } from './contract'

const MAX_URL_LENGTH = 7500
const MAX_REPOSITORY_LENGTH = 200
const REPOSITORY_PATTERN = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/
const BUILTIN_REPOSITORY = 'https://github.com/zpyoung/quirky'
const TRUNCATION_MARKER = '… (truncated)'
const COMPACT_FIELD_LENGTH = 120
const COMPACT_METADATA_LENGTH = 40
const MINIMAL_LENGTH = 16
const FALLBACK_STAGES: readonly { field: number | null; metadata: number | null }[] = [
  { field: null, metadata: null },
  { field: COMPACT_FIELD_LENGTH, metadata: null },
  { field: COMPACT_FIELD_LENGTH, metadata: COMPACT_METADATA_LENGTH },
  { field: MINIMAL_LENGTH, metadata: MINIMAL_LENGTH }
]

export type IssueDraft = {
  repository: string
  url: string
  /** Whole comments in the draft; a single oversized comment counts as included once truncated. */
  included: number
  /** Comments for this repository that did not fit and need another draft. */
  remaining: number
}

/** The repository for the host's own UI: `quirky` and any `quirky.*` plugin id. Null for every other owner. */
export function builtinRepository(owner: string): string | null {
  return owner === 'quirky' || owner.startsWith('quirky.') ? BUILTIN_REPOSITORY : null
}

function validRepository(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > MAX_REPOSITORY_LENGTH) return null
  const match = REPOSITORY_PATTERN.exec(value)
  if (match === null) return null
  const [, owner, repo] = match
  if (owner === '.' || owner === '..' || repo === '.' || repo === '..') return null
  return value
}

function wellFormed(value: string): string {
  return value.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '�')
}

function clip(value: string, max: number | null): string {
  return max === null ? value : Array.from(value).slice(0, max).join('')
}

/** Only comment text, intent, owner, element path, component, source and build; never on-screen data. */
function renderComment(comment: Comment, number: number, text: string, fieldLimit: number | null): string {
  const capture = comment.capture
  const { version, commit, channel } = capture.build
  const lines = [`### ${number}.`, `**Intent:** ${codeSpan(comment.intent)}`]
  if (capture.owner) lines.push(`**Plugin:** ${codeSpan(capture.owner)}`)
  if (capture.elementPath) lines.push(`**Location:** ${codeSpan(clip(capture.elementPath, fieldLimit))}`)
  if (capture.component) lines.push(`**React:** ${codeSpan(clip(capture.component, fieldLimit))}`)
  if (capture.source) lines.push(`**Source:** ${codeSpan(clip(capture.source, fieldLimit))}`)
  if (capture.sourceCaller) lines.push(`**Used by:** ${codeSpan(clip(capture.sourceCaller, fieldLimit))}`)
  lines.push(`**App:** ${codeSpan(`Quirky ${version} (${commit}, ${channel})`)}`)
  lines.push(...feedbackBlock(text))
  return lines.join('\n')
}

function titleFor(comments: Comment[]): string {
  const owners = new Set(comments.map((comment) => comment.capture.owner))
  const [only] = owners
  return owners.size === 1 && only !== undefined ? `UI feedback: ${only}` : `UI feedback: ${comments.length} comments`
}

function urlFor(repository: string, comments: Comment[], blocks: string[]): string {
  const title = encodeURIComponent(wellFormed(titleFor(comments)))
  const body = encodeURIComponent(wellFormed(blocks.join('\n\n')))
  return `${repository}/issues/new?title=${title}&body=${body}`
}

function withBoundedMetadata(comment: Comment, max: number | null): Comment {
  if (max === null) return comment
  const { owner, build } = comment.capture
  return {
    ...comment,
    capture: {
      ...comment.capture,
      owner: clip(owner, max),
      build: { version: clip(build.version, max), commit: clip(build.commit, max), channel: clip(build.channel, max) }
    }
  }
}

/**
 * Fits the first comment alone by cutting its text at a code point boundary and marking the cut.
 * When even an empty text overflows, owner, build and location fields shrink in stages until it fits.
 */
function truncatedDraft(repository: string, comment: Comment): string {
  const points = Array.from(wellFormed(comment.comment))
  const urlAt = (stage: (typeof FALLBACK_STAGES)[number], kept: number) => {
    const bounded = withBoundedMetadata(comment, stage.metadata)
    return urlFor(repository, [bounded], [renderComment(bounded, 1, `${points.slice(0, kept).join('')}${TRUNCATION_MARKER}`, stage.field)])
  }
  for (const stage of FALLBACK_STAGES) {
    if (urlAt(stage, 0).length > MAX_URL_LENGTH) continue
    let low = 0
    let high = points.length
    while (low < high) {
      const middle = Math.ceil((low + high) / 2)
      if (urlAt(stage, middle).length <= MAX_URL_LENGTH) low = middle
      else high = middle - 1
    }
    return urlAt(stage, low)
  }
  return urlAt(FALLBACK_STAGES[FALLBACK_STAGES.length - 1]!, 0)
}

function draftFor(repository: string, comments: Comment[]): IssueDraft {
  const blocks: string[] = []
  let fitted = ''
  let included = 0
  for (const [index, comment] of comments.entries()) {
    blocks.push(renderComment(comment, index + 1, comment.comment, null))
    const url = urlFor(repository, comments.slice(0, index + 1), blocks)
    if (url.length > MAX_URL_LENGTH) break
    fitted = url
    included = index + 1
  }
  if (included === 0) return { repository, url: truncatedDraft(repository, comments[0]!), included: 1, remaining: comments.length - 1 }
  return { repository, url: fitted, included, remaining: comments.length - included }
}

/**
 * Groups comments by GitHub repository and builds one pre-filled new-issue URL per repository.
 * A draft holds whole comments in order while the URL stays within 7,500 characters, so `remaining`
 * counts those left for a follow-up; a first comment too large on its own is truncated and marked.
 * Comments whose owner has no valid `https://github.com/<owner>/<repo>` repository are returned in `unrouted`.
 */
export function buildIssueDrafts(
  comments: Comment[],
  repositoryOf: (owner: string) => string | null
): { drafts: IssueDraft[]; unrouted: Comment[] } {
  const resolved = new Map<string, string | null>()
  const groups = new Map<string, Comment[]>()
  const unrouted: Comment[] = []
  for (const comment of comments) {
    const owner = comment.capture.owner
    if (!resolved.has(owner)) {
      let repository: string | null = null
      try { repository = validRepository(repositoryOf(owner)) } catch { repository = null }
      resolved.set(owner, repository)
    }
    const repository = resolved.get(owner) ?? null
    if (repository === null) unrouted.push(comment)
    else groups.set(repository, [...(groups.get(repository) ?? []), comment])
  }
  return { drafts: [...groups].map(([repository, group]) => draftFor(repository, group)), unrouted }
}
