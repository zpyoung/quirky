import type { RuntimeFileOperationArgs } from '@/runtime/runtime-file-client-types'
import { readRuntimeFilePreview } from '@/runtime/runtime-file-read-client'
import { readRuntimeDirectory } from '@/runtime/runtime-file-mutation-client'
import { assertNoSymlinkInPath } from '../panels/view-render/workspace-image-read'
import { resolveWorkspaceImagePath } from '../panels/view-render/workspace-image-path'
import type { WorkspaceImage } from '../panels/view-render/view-runtime'

const IMAGE_MIME = /^image\/[a-z0-9.+-]+$/i

/**
 * Reads a visual's workspace image from the machine that owns the chat's workspace, so a chat on a
 * paired server or an SSH host shows its own files and not this machine's. Without a resolved
 * owner there is nothing to read from, and the panel falls back to its local-only reader.
 */
export function workspaceImageReaderFor(
  context: RuntimeFileOperationArgs | null
): ((relativePath: string) => Promise<WorkspaceImage>) | undefined {
  if (context === null) {
    return undefined
  }
  return async (relativePath) => {
    const resolved = resolveWorkspaceImagePath(context.worktreePath ?? null, relativePath)
    if (!resolved.ok) {
      throw new Error(resolved.reason)
    }
    await assertNoSymlinkInPath(context.worktreePath ?? '', resolved.relativePath, (dirPath) =>
      readRuntimeDirectory(context, dirPath)
    )
    const file = await readRuntimeFilePreview(context, resolved.absolutePath)
    if (file.isImage !== true || file.mimeType === undefined || !IMAGE_MIME.test(file.mimeType)) {
      throw new Error('the file is not an image')
    }
    return { dataUrl: `data:${file.mimeType};base64,${file.content}` }
  }
}
