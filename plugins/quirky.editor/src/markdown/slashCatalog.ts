import type { MarkdownFormat } from './operations'

export type SlashItem = { id: string; group: string; label: string; aliases: string[]; format: MarkdownFormat }

export const SLASH_CATALOG: SlashItem[] = [
  ...[1, 2, 3, 4, 5].map((level) => ({
    id: `heading${level}`,
    group: 'Headings',
    label: `Heading ${level}`,
    aliases: [`h${level}`, ...(level === 1 ? ['title'] : [])],
    format: `heading${level}` as MarkdownFormat
  })),
  ...[1, 2, 3, 4, 5].map((level) => ({
    id: `toggleHeading${level}`,
    group: 'Toggle headings',
    label: `Toggle H${level}`,
    aliases: [`toggle-h${level}`, 'toggle heading', 'details heading', 'collapse heading'],
    format: 'collapsibleHeading' as MarkdownFormat
  })),
  { id: 'quote', group: 'Basic blocks', label: 'Quote', aliases: ['quote', 'blockquote'], format: 'quote' },
  { id: 'ordered', group: 'Basic blocks', label: 'Numbered List', aliases: ['ordered', 'ol', 'numbered'], format: 'orderedList' },
  { id: 'bullet', group: 'Basic blocks', label: 'Bullet List', aliases: ['bullet', 'ul', 'list'], format: 'bulletList' },
  { id: 'check', group: 'Basic blocks', label: 'Check List', aliases: ['todo', 'task', 'checkbox'], format: 'taskList' },
  { id: 'paragraph', group: 'Basic blocks', label: 'Paragraph', aliases: ['paragraph', 'plain'], format: 'body' },
  { id: 'toggle', group: 'Basic blocks', label: 'Toggle Text', aliases: ['toggle', 'details', 'collapse', 'toggle-text'], format: 'details' },
  { id: 'code', group: 'Basic blocks', label: 'Code Block', aliases: ['code', 'snippet'], format: 'codeBlock' },
  { id: 'divider', group: 'Basic blocks', label: 'Divider', aliases: ['divider', 'rule', 'hr'], format: 'divider' },
  { id: 'table', group: 'Advanced', label: 'Table', aliases: ['grid', 'columns', 'rows'], format: 'table' },
  { id: 'mermaid', group: 'Advanced', label: 'Mermaid Diagram', aliases: ['diagram', 'flowchart', 'chart', 'graph'], format: 'mermaid' },
  { id: 'inlineMath', group: 'Advanced', label: 'Inline Math', aliases: ['math', 'latex', 'equation', 'formula'], format: 'inlineMath' },
  { id: 'blockMath', group: 'Advanced', label: 'Math Block', aliases: ['math block', 'latex block', 'equation block'], format: 'blockMath' },
  { id: 'image', group: 'Media', label: 'Image', aliases: ['image', 'img'], format: 'image' },
  { id: 'emoji', group: 'Others', label: 'Emoji', aliases: ['smile', 'reaction', 'icon'], format: 'emoji' }
]

export function filterSlashCatalog(query: string): SlashItem[] {
  if (query.length > 2048) return []
  const needle = query.toLowerCase()
  return SLASH_CATALOG.filter((item) => `${item.label} ${item.aliases.join(' ')}`.toLowerCase().includes(needle))
}
