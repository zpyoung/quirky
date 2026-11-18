import type { ReactNode } from 'react'

/**
 * The dashed note a rich block shows when it cannot draw; the source or the plain code block follows it.
 * `inline` draws it from spans, for math that sits inside a paragraph.
 */
export function RenderError({ message, children, inline = false }: { message: string; children?: ReactNode; inline?: boolean }) {
  const Box = inline ? 'span' : 'div'
  return (
    <Box className="qmd-error" role="note" data-qmd-error="">
      <Box className="qmd-error-message">{message}</Box>
      {children}
    </Box>
  )
}
