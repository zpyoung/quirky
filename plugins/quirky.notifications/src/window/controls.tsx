/** A two-state control that reads as a switch to assistive technology. */
export function Switch({ checked, label, disabled, onChange }: { checked: boolean; label: string; disabled: boolean; onChange: (checked: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      className={`notif-switch${checked ? ' on' : ''}`}
      onClick={() => onChange(!checked)}
    >
      <span aria-hidden="true" className="notif-thumb" />
    </button>
  )
}
