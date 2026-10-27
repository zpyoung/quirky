import type { ReactNode } from 'react'

function Svg({ children }: { children: ReactNode }) {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {children}
    </svg>
  )
}

export const PinIcon = () => (
  <Svg>
    <path d="M4 1.5h4M5 1.5v3L3 7h6L7 4.5v-3M6 7v3.5" />
  </Svg>
)

export const ExpandIcon = () => (
  <Svg>
    <path d="M7 1.5h3.5V5M5 10.5H1.5V7M10.5 1.5 7 5M1.5 10.5 5 7" />
  </Svg>
)

export const CollapseIcon = () => (
  <Svg>
    <path d="M10.5 5H7V1.5M1.5 7H5v3.5M7 5l3.5-3.5M5 7l-3.5 3.5" />
  </Svg>
)

export const GripIcon = () => (
  <Svg>
    <path d="M4 2.5v0M8 2.5v0M4 6v0M8 6v0M4 9.5v0M8 9.5v0" strokeWidth="2" />
  </Svg>
)

export const CloseIcon = () => (
  <Svg>
    <path d="m3 3 6 6M9 3 3 9" />
  </Svg>
)
