import { resolveWorkspaceImagePath } from './workspace-image-path'
import type { WorkspaceImage } from './view-runtime'

const IMAGE_MIME = /^image\/[a-z0-9.+-]+$/i

/**
 * Throws when any component of `relativePath` under `workspaceRoot` is a symlink, because the
 * app-wide allowlist only checks the canonical path against every registered project, so a link
 * could otherwise reach a sibling project. The root itself may be reached through a link.
 */
async function assertNoSymlinkInPath(workspaceRoot: string, relativePath: string): Promise<void> {
  const segments = relativePath.split('/')
  let directory = workspaceRoot.replace(/\/+$/, '')
  for (const segment of segments) {
    const entries = await window.api.fs.readDir({ dirPath: directory })
    const entry = entries.find((candidate) => candidate.name === segment)
    if (!entry) {
      throw new Error('the file does not exist')
    }
    if (entry.isSymlink) {
      throw new Error('the path goes through a symbolic link')
    }
    directory = `${directory}/${segment}`
  }
}

/** Reads a workspace image from this machine's disk as a data URL. */
export async function readLocalWorkspaceImage(
  workspaceRoot: string | null,
  relativePath: string
): Promise<WorkspaceImage> {
  const resolved = resolveWorkspaceImagePath(workspaceRoot, relativePath)
  if (!resolved.ok || workspaceRoot === null) {
    throw new Error(resolved.ok ? 'there is no workspace to read it from' : resolved.reason)
  }
  await assertNoSymlinkInPath(workspaceRoot, resolved.relativePath)
  const file = await window.api.fs.readFile({ filePath: resolved.absolutePath })
  if (file.isImage !== true || file.mimeType === undefined || !IMAGE_MIME.test(file.mimeType)) {
    throw new Error('the file is not an image')
  }
  return { dataUrl: `data:${file.mimeType};base64,${file.content}` }
}
