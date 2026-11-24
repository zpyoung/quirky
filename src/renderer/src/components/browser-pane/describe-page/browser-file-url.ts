import { getRuntimePathBasename } from '../../../../../shared/cross-platform-path'

export type LocalBrowserHtmlFile = {
  fileName: string
  filePath: string
}

/** Windows drive and UNC paths spell with backslashes, whichever slash the caller had. */
function canonicalFilePath(filePath: string): string {
  return /^[A-Za-z]:[\\/]/.test(filePath) || /^[\\/]{2}/.test(filePath)
    ? filePath.replaceAll('/', '\\')
    : filePath
}

export function browserFileUrlToAbsolutePath(url: string): string | null {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'file:') {
      return null
    }
    const hostPrefix =
      parsed.hostname && parsed.hostname !== 'localhost' ? `//${parsed.hostname}` : ''
    const absolutePath = `${hostPrefix}${decodeURIComponent(parsed.pathname)}`
    return canonicalFilePath(
      /^\/[A-Za-z]:\//.test(absolutePath) ? absolutePath.slice(1) : absolutePath
    )
  } catch {
    return null
  }
}

export function getLocalBrowserHtmlFile(url: string): LocalBrowserHtmlFile | null {
  const filePath = browserFileUrlToAbsolutePath(url)
  if (!filePath || !/\.html?$/i.test(filePath)) {
    return null
  }
  const fileName = getRuntimePathBasename(filePath)
  return fileName ? { fileName, filePath } : null
}
