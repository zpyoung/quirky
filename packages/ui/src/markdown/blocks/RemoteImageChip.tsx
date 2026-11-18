import { useContext } from 'react'
import { ControlIcon } from '../../design-system/tool-icons'
import { RuntimeContext } from '../runtime'

const ICON_SIZE = 12

function absolute(url: string): string {
  return url.startsWith('//') ? `https:${url}` : url
}

function shortLabel(url: string): string {
  try {
    const parsed = new URL(url)
    return `${parsed.host}${parsed.pathname === '/' ? '' : parsed.pathname}`
  } catch {
    return url
  }
}

/** A remote image never loads; it shows as a chip whose click goes to the caller's Open link prompt. */
export function RemoteImageChip({ src, alt }: { src: string; alt?: string }) {
  const runtime = useContext(RuntimeContext)
  const url = absolute(src)
  return (
    <button
      type="button"
      className="qmd-chip qmd-chip--remote"
      data-remote-image=""
      title={alt ? `${alt} (${url})` : url}
      onClick={() => runtime.current.onOpenLink(url)}
    >
      <ControlIcon name="globe" size={ICON_SIZE} />
      <span>image: {shortLabel(url)}</span>
    </button>
  )
}
