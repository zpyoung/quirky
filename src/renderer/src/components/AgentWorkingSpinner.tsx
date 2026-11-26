import React from 'react'
import { cn } from '@/lib/utils'

// Why: the halo animates via CSS (.agent-working-pulse in main.css) and its
// reduced-motion fallback is a static halo there. Callers size it via className
// (size-2 etc.).
export function AgentWorkingSpinner({ className }: { className?: string }): React.JSX.Element {
  return (
    <span
      data-agent-spinner=""
      className={cn('agent-working-pulse block size-2 rounded-full bg-agent-working', className)}
    />
  )
}
