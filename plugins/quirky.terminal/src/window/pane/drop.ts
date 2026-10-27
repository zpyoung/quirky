type DroppedFile = { path?: unknown }

/** The slice of a `DataTransfer` the drop handler reads. */
export type DropData = { files?: ArrayLike<object> | null; getData(type: string): string }

function fromFileUrl(url: string): string | null {
  if (!/^file:\/\//i.test(url)) return null
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'file:' ? decodeURIComponent(parsed.pathname) : null
  } catch {
    return null
  }
}

/**
 * The absolute file paths in a drop: dropped files that carry a path, and `file://` URLs from the
 * URI list or plain text. Duplicates and paths with control characters are left out.
 */
export function pathsFromDrop(data: DropData): string[] {
  const found: string[] = []
  for (const file of Array.from(data.files ?? []) as DroppedFile[]) {
    if (typeof file.path === 'string' && file.path) found.push(file.path)
  }
  for (const type of ['text/uri-list', 'text/plain']) {
    for (const line of data.getData(type).split(/\r?\n/)) {
      const path = fromFileUrl(line.trim())
      if (path) found.push(path)
    }
  }
  return [...new Set(found)].filter((path) => path.startsWith('/') && !/[\u0000-\u001f\u007f]/.test(path))
}
