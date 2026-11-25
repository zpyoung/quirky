import { resolveWorkspaceImagePath } from './workspace-image-path'
import type { WorkspaceImage } from './view-runtime'

const IMAGE_MIME = /^image\/[a-z0-9.+-]+$/i

/** Reads a workspace image from this machine's disk as a data URL. */
export async function readLocalWorkspaceImage(
  workspaceRoot: string | null,
  relativePath: string
): Promise<WorkspaceImage> {
  const resolved = resolveWorkspaceImagePath(workspaceRoot, relativePath)
  if (!resolved.ok) {
    throw new Error(resolved.reason)
  }
  const file = await window.api.fs.readFile({ filePath: resolved.absolutePath })
  if (file.isImage !== true || file.mimeType === undefined || !IMAGE_MIME.test(file.mimeType)) {
    throw new Error('the file is not an image')
  }
  return { dataUrl: `data:${file.mimeType};base64,${file.content}` }
}
