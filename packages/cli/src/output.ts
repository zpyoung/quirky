export type Writer = { stdout(text: string): void; stderr(text: string): void }

/** Left-aligned columns separated by two spaces, with an upper-case header row. */
export function formatTable(headers: string[], rows: string[][]): string {
  const widths = headers.map((header, column) =>
    Math.max(header.length, ...rows.map((row) => (row[column] ?? '').length))
  )
  const render = (cells: string[]) =>
    cells
      .map((cell, column) => cell.padEnd(widths[column]))
      .join('  ')
      .trimEnd()
  return [render(headers), ...rows.map(render)].join('\n')
}

export function formatRecord(pairs: [string, string | number | null | undefined][]): string {
  return pairs.map(([key, value]) => `${key}: ${value ?? '-'}`).join('\n')
}

/** Prints command results as human text, or as one compact JSON document with `--json`. */
export class Printer {
  constructor(
    private readonly writer: Writer,
    readonly json: boolean
  ) {}

  result(data: unknown, human: () => string): void {
    this.line(this.json ? JSON.stringify(data) : human())
  }

  /** One JSON line regardless of mode; used by `ask`, whose output is always machine-readable. */
  jsonLine(data: unknown): void {
    this.writer.stdout(`${JSON.stringify(data)}\n`)
  }

  line(text: string): void {
    this.writer.stdout(text.endsWith('\n') ? text : `${text}\n`)
  }
}
