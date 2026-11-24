// Where an attachment's pixels can be read, which is not always the path the
// agent gets: an SSH worktree uploads into the remote `.quirky/drops`, so the
// chip's path names a remote file and only the client-local original is
// readable here.

const MAX_REMEMBERED_PREVIEW_SOURCES = 64

const previewSourceByScopedPath = new Map<string, string>()

/** A remote path is unique only within one host — two SSH connections can both
 *  hold `~/project/.quirky/drops/shot.png` and mean different files — and the
 *  JSON pair encoding keeps either side's characters from forging another key. */
function scopedKey(connectionId: string, attachmentPath: string): string {
  return JSON.stringify([connectionId, attachmentPath])
}

export type AttachmentUploadOutcome = {
  sourcePath: string
}

/** The SSH connection an upload ran over — the scope its remote paths mean
 *  something in. Structural so the upload seam can pass its owner straight in. */
export type AttachmentPreviewScope = {
  connectionId: string
}

/**
 * Pair uploaded remote paths back to the client-local files they came from,
 * under the SSH connection that produced them.
 *
 * The upload IPC returns remote paths in input order but drops the source
 * alignment, reporting per-file skips and failures separately. Removing those
 * sources from the input rebuilds the pairing. A length mismatch means the
 * reconstruction is not trustworthy, so nothing is remembered and the chips
 * fall back to their icon rather than risk showing the wrong image.
 */
export function rememberUploadedAttachmentPreviewSources(
  { connectionId }: AttachmentPreviewScope,
  sourcePaths: readonly string[],
  uploadedPaths: readonly string[],
  skipped: readonly AttachmentUploadOutcome[],
  failed: readonly AttachmentUploadOutcome[]
): void {
  const unresolved = new Set([
    ...skipped.map((entry) => entry.sourcePath),
    ...failed.map((entry) => entry.sourcePath)
  ])
  const resolvedSources = sourcePaths.filter((path) => !unresolved.has(path))
  if (resolvedSources.length !== uploadedPaths.length) {
    return
  }
  uploadedPaths.forEach((uploadedPath, index) => {
    const key = scopedKey(connectionId, uploadedPath)
    // Delete-then-set keeps re-registered paths newest so eviction sheds the oldest.
    previewSourceByScopedPath.delete(key)
    previewSourceByScopedPath.set(key, resolvedSources[index])
  })
  // Trim once per batch and never below the batch's own size: a drop of more
  // than MAX images must not evict its earliest entries before those chips mount.
  evictOldestBeyond(Math.max(MAX_REMEMBERED_PREVIEW_SOURCES, uploadedPaths.length))
}

function evictOldestBeyond(limit: number): void {
  while (previewSourceByScopedPath.size > limit) {
    const oldest = previewSourceByScopedPath.keys().next().value
    if (oldest === undefined) {
      break
    }
    previewSourceByScopedPath.delete(oldest)
  }
}

/** The path to read an attachment's pixels from: the client-local source
 *  remembered for it on `connectionId`, otherwise the attachment path itself.
 *  A null connection is a local worktree, whose own paths are readable here. */
export function attachmentPreviewSourcePath(
  connectionId: string | null,
  attachmentPath: string
): string {
  if (connectionId === null) {
    return attachmentPath
  }
  return previewSourceByScopedPath.get(scopedKey(connectionId, attachmentPath)) ?? attachmentPath
}

export function clearAttachmentPreviewSourcesForTests(): void {
  previewSourceByScopedPath.clear()
}
