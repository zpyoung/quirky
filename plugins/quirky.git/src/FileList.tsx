import type { GitFileStatus } from '@quirky/protocol'
import { statusLetter } from './scm'

type Props = {
  title: string
  files: GitFileStatus[]
  staged: boolean
  selectedKey: string | null
  onSelect: (file: GitFileStatus) => void
  onToggle: (paths: string[]) => void
}

export const fileKey = (path: string, staged: boolean) => `${staged ? 's' : 'u'}:${path}`

export function FileList({ title, files, staged, selectedKey, onSelect, onToggle }: Props) {
  const action = staged ? 'Unstage' : 'Stage'
  return (
    <section className="file-group">
      <header>
        <span>
          {title} ({files.length})
        </span>
        {files.length > 0 && (
          <button onClick={() => onToggle(files.map((f) => f.path))}>{action} all</button>
        )}
      </header>
      <ul>
        {files.map((file) => (
          <li
            key={file.path}
            className={fileKey(file.path, staged) === selectedKey ? 'selected' : ''}
          >
            <button className="file-main" onClick={() => onSelect(file)} title={file.path}>
              <span className={`file-letter letter-${statusLetter(file, staged)}`}>
                {statusLetter(file, staged)}
              </span>
              <span className="file-path">{file.path}</span>
            </button>
            <button
              className="icon-button"
              aria-label={`${action} ${file.path}`}
              title={action}
              onClick={() => onToggle([file.path])}
            >
              {staged ? '−' : '+'}
            </button>
          </li>
        ))}
      </ul>
    </section>
  )
}
