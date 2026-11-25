/** A spec that failed validation: its title, why, and the source the agent sent behind a disclosure. */
export function ViewSpecError({
  title,
  errors,
  source
}: {
  title: string
  errors: readonly string[]
  source: string
}) {
  return (
    <section
      className="native-chat-view-error-card"
      role="alert"
      aria-label={`View failed: ${title}`}
    >
      <header className="native-chat-view-row native-chat-view-between">
        <strong className="native-chat-view-clip">{title}</strong>
        <span className="native-chat-view-muted">couldn&apos;t show</span>
      </header>
      <ul className="native-chat-view-error-list">
        {errors.map((message, index) => (
          <li key={index}>{message}</li>
        ))}
      </ul>
      <details>
        <summary className="native-chat-view-muted">Show source</summary>
        <pre className="native-chat-view-code native-chat-view-source">{source}</pre>
      </details>
    </section>
  )
}
