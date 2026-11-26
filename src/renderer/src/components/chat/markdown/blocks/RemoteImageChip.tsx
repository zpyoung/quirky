import { translate } from '@/i18n/i18n'
import { useContext } from 'react'
import { Globe } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { RuntimeContext } from '../runtime'

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
    <Badge asChild variant="promptPill">
      <button
        type="button"
        className="qmd-chip"
        data-remote-image=""
        title={alt ? `${alt} (${url})` : url}
        onClick={() => runtime.current.onOpenLink(url)}
      >
        <Globe aria-hidden="true" />
        <span>
          {translate('components.chat.markdown.remoteImage', 'image: {{label}}', {
            label: shortLabel(url)
          })}
        </span>
      </button>
    </Badge>
  )
}
