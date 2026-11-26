import { translate } from '@/i18n/i18n'
import { positionKeyed } from '../../position-keyed'
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
      aria-label={translate('components.chat.viewRender.viewFailed', 'View failed: {{title}}', {
        title
      })}
    >
      <header className="native-chat-view-row native-chat-view-between">
        <strong className="native-chat-view-clip">{title}</strong>
        <span className="native-chat-view-muted">
          {translate('components.chat.viewRender.couldntShow', "couldn't show")}
        </span>
      </header>
      <ul className="native-chat-view-error-list">
        {positionKeyed(errors).map(({ key, item: message }) => (
          <li key={key}>{message}</li>
        ))}
      </ul>
      <details>
        <summary className="native-chat-view-muted">
          {translate('components.chat.viewRender.showSource', 'Show source')}
        </summary>
        <pre className="native-chat-view-code native-chat-view-source">{source}</pre>
      </details>
    </section>
  )
}
