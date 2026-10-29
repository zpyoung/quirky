import { useEffect, useRef, type ReactNode } from 'react'
import { Dialog as SharedDialog } from '@quirky/ui'

type Props = { title: string; onClose: () => void; children: ReactNode }

/** The workspace's modal content over the shared graphite dialog surface. */
export function Dialog({ title, onClose, children }: Props) {
  const root = useRef<HTMLDivElement>(null)

  useEffect(() => {
    root.current?.querySelector<HTMLElement>('[autofocus]')?.focus()
  }, [])

  return (
    <div ref={root}>
      <SharedDialog open title={title} onClose={onClose} closeOnBackdrop>
        {children}
      </SharedDialog>
    </div>
  )
}
