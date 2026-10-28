export function LoopGlyph({ label }: { label: string }) {
  return (
    <span className="loop-glyph" role="img" title={label} aria-label={label} style={{ display: 'inline-flex', flexShrink: 0 }}>
      <svg
        width="14"
        height="14"
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        focusable="false"
        aria-hidden="true"
      >
        <path d="M4 5h6a3 3 0 0 1 3 3v.5" />
        <path d="m10.8 7.2 2.2 2.2 2.2-2.2" />
        <path d="M12 11H6a3 3 0 0 1-3-3v-.5" />
        <path d="m5.2 8.8-2.2-2.2L.8 8.8" />
      </svg>
    </span>
  )
}
