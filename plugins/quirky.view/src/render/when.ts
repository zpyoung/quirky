import type { ReactNode } from 'react'

/** `build()` when `condition` holds, else nothing; optional content inside JSX. */
export const when = (condition: boolean, build: () => ReactNode): ReactNode => (condition ? build() : null)
