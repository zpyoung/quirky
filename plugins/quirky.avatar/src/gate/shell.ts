/** One word of a command after quote removal. */
export type ShellWord = {
  /** The word's value when `dynamic` is false; otherwise its text as written, quotes removed. */
  text: string
  /**
   * True when the shell would compute part of the value and the reader can't know it.
   * A double-quoted `$(cat <<'DELIM' … DELIM)` on stdin is not dynamic: it contributes
   * the heredoc body without its trailing newlines. This also includes a brace expansion
   * the reader can't follow: a sequence, more than MAX_BRACE_WORDS words, an empty word,
   * or a form bash and zsh expand differently.
   */
  dynamic: boolean
  /** The scopes of the substitutions written directly inside this word. */
  subs: number[]
}

/**
 * `read`: the target is a path opened for reading. `heredoc`: the target is text given to the
 * command on standard input, from a heredoc body or a here-string, and never a path.
 */
export type ShellRedirect = { kind: 'write' | 'read' | 'dup' | 'heredoc'; target: ShellWord }
export type ShellSeparator = '|' | '&&' | '||' | ';' | '&'
export type ShellCommand = {
  /** 0 for the top level; otherwise the substitution or subshell the command is written in. */
  scope: number
  /** What joined the command to the one before it in its scope; null for the first. */
  sep: ShellSeparator | null
  /** True when the command is one side of a pipe, or its list is sent to the background. */
  detached: boolean
  assignments: { name: string; value: ShellWord }[]
  /** The words the shell passes, in order. A comma list in braces has been expanded, so one source word can be several entries. */
  words: ShellWord[]
  /** One entry per file the shell opens. A target with a comma list in braces is one entry per word. */
  redirects: ShellRedirect[]
  /** True when an empty `()` follows the words with nothing between, so they name a function and the next command starts its body. */
  defines?: true
}
export type ShellScript = {
  /** Every command at every depth. One scope's commands keep source order, and a scope's commands come before the command that holds it. */
  commands: ShellCommand[]
  /** `parents[scope]` is the scope it was written in; `parents[0]` is -1. */
  parents: number[]
}

export const MAX_SHELL_CHARS = 1_048_576
export const MAX_SHELL_DEPTH = 32
/** The most words one source word may become by brace expansion. Past it the word stays as written and is dynamic. */
export const MAX_BRACE_WORDS = 64

type Entry =
  | { kind: 'command'; command: ShellCommand; before: Entry[]; quotedHeredoc: boolean }
  | { kind: 'scope'; entries: Entry[] }

type WordResult = { word: ShellWord; words?: ShellWord[]; before: Entry[]; quoted: boolean; consumed: boolean }
type ActiveCommand = { command: ShellCommand; before: Entry[]; assignmentAllowed: boolean }
type PendingHeredoc = {
  redirect: ShellRedirect
  delimiter: string
  stripTabs: boolean
  quoted: boolean
  stdin: boolean
  before: Entry[]
  ownerScope: number
  ownerDepth: number
}
type RedirectOperator = { start: number; end: number; op: string }
type HomeMarker = { start: number; end: number; sourceEnd: number; braced: boolean }
type FallbackOverride = { start: number; end: number; sourceStart: number; sourceEnd: number }
type ActiveSyntax = {
  position: number
  source: number
  character: '{' | '}' | ',' | '~'
  group?: BraceGroup
}
type BraceAlternative = {
  start: number
  end: number
  expandingChildren: BraceGroup[] | null
  count: number
}
type BraceGroup = {
  open: number
  close: number
  commas: number[]
  children: BraceGroup[]
  expandingChildren: BraceGroup[] | null
  alternatives: BraceAlternative[]
  isList: boolean
  hasList: boolean
  canBeEmpty: boolean
  count: number
  rankDivisor: number
  selectedAlternative: number
}
type BracePlan = { expandingRoots: BraceGroup[]; count: number; canBeEmpty: boolean; hasList: boolean }
type BraceCandidate = { ranges: { start: number; end: number }[]; homes: HomeMarker[]; tildes: number[]; length: number; homeIndex: number; syntaxIndex: number }
type ExpansionFrame =
  | { kind: 'parameter'; braces: number; quote: string; doubleQuoted: boolean }
  | { kind: 'arithmetic'; parentheses: number; quote: string; doubleQuoted: boolean }
type ScopeKind = 'root' | 'subshell' | 'command-substitution' | 'process-substitution' | 'backtick'
type ScopeResult = { id: number; entry: Entry }

class WordBuilder {
  readonly chunks: string[] = []
  readonly homes: HomeMarker[] = []
  readonly syntax: ActiveSyntax[] = []
  readonly fallbackOverrides: FallbackOverride[] = []
  readonly subs: number[] = []
  readonly before: Entry[] = []
  length = 0
  dynamic = false
  ambiguousBraceDollar = false

  constructor(private readonly source: string, private readonly home: string) {}

  append(value: string): void {
    if (!value) return
    this.chunks.push(value)
    this.length += value.length
  }

  appendRange(start: number, end: number): void {
    if (end > start) this.append(this.source.slice(start, end))
  }

  appendHeredocRange(start: number, end: number, stripTabs: boolean, stripFirstTabs: boolean): void {
    if (end <= start) return
    if (!stripTabs) {
      this.appendRange(start, end)
      return
    }
    let cursor = start
    let segmentStart = start
    let lineStart = stripFirstTabs
    while (cursor < end) {
      if (lineStart) {
        this.appendRange(segmentStart, cursor)
        while (cursor < end && this.source.charCodeAt(cursor) === 9) cursor++
        segmentStart = cursor
        lineStart = false
      }
      if (this.source.charCodeAt(cursor) === 10) {
        cursor++
        lineStart = true
      } else {
        cursor++
      }
    }
    this.appendRange(segmentStart, end)
  }
  appendHomeRange(start: number, end: number, braced = false): void {
    const markerStart = this.length
    this.appendRange(start, end)
    this.homes.push({ start: markerStart, end: this.length, sourceEnd: end, braced })
  }

  appendKnownExpansion(start: number, end: number, value: string): void {
    const outputStart = this.length
    this.append(value)
    this.fallbackOverrides.push({ start: outputStart, end: this.length, sourceStart: start, sourceEnd: end })
  }

  fallbackText(text: string): string {
    if (this.fallbackOverrides.length === 0) return text
    const pieces: string[] = []
    let cursor = 0
    for (const marker of this.fallbackOverrides) {
      pieces.push(text.slice(cursor, marker.start), this.source.slice(marker.sourceStart, marker.sourceEnd))
      cursor = marker.end
    }
    pieces.push(text.slice(cursor))
    return pieces.join('')
  }

  markSyntax(position: number, source: number, character: ActiveSyntax['character']): void {
    this.syntax.push({ position, source, character })
  }

  rawText(): string {
    return this.chunks.join('')
  }

  addScope(scope: ScopeResult): void {
    this.subs.push(scope.id)
    this.before.push(scope.entry)
  }

  finish(): ShellWord {
    let text = this.rawText()
    if (!this.dynamic && this.homes.length > 0) {
      const pieces: string[] = []
      let cursor = 0
      for (const marker of this.homes) {
        pieces.push(text.slice(cursor, marker.start), this.home)
        cursor = marker.end
      }
      pieces.push(text.slice(cursor))
      text = pieces.join('')
    }
    return { text, dynamic: this.dynamic, subs: this.subs }
  }
}

class ShellReader {
  index = 0
  readonly parents: number[]
  private readonly scopeKinds: ScopeKind[]
  private readonly eligibleHeredocs: PendingHeredoc[] = []
  private eligibleHeredocIndex = 0

  constructor(
    readonly source: string,
    readonly home: string,
    parents: number[] = [-1],
    scopeKinds: ScopeKind[] = ['root']
  ) {
    this.parents = parents
    this.scopeKinds = scopeKinds
  }

  parse(): ShellScript | null {
    const entries = this.parseScope(0, 0, null, this.source.length)
    if (entries === null) return null
    const commands: ShellCommand[] = []
    this.emit(entries, commands)
    return { commands, parents: this.parents }
  }

  private emit(entries: Entry[], commands: ShellCommand[]): void {
    for (const entry of entries) {
      if (entry.kind === 'scope') {
        this.emit(entry.entries, commands)
      } else {
        this.emit(entry.before, commands)
        commands.push(entry.command)
      }
    }
  }

  private parseScope(scope: number, depth: number, close: ')' | '`' | null, limit: number): Entry[] | null {
    const entries: Entry[] = []
    const members: Entry[] = []
    let nextSeparator: ShellSeparator | null = null
    let pipelineNext = false
    let listStart = 0

    while (true) {
      this.skipInline(limit)
      if (this.index >= limit) {
        if (this.hasEligibleHeredocs() || close !== null) return null
        return entries
      }

      const character = this.source[this.index]
      if (character === '\n') {
        this.index++
        if (this.hasEligibleHeredocs()) {
          if (!this.consumeHeredocs(limit)) return null
          nextSeparator = ';'
          listStart = members.length
          pipelineNext = false
        } else if (nextSeparator !== '|' && nextSeparator !== '&&' && nextSeparator !== '||') {
          nextSeparator = members.length === 0 ? null : ';'
          listStart = members.length
          pipelineNext = false
        }
        continue
      }

      if (character === '#') {
        while (this.index < limit && this.source[this.index] !== '\n') this.index++
        continue
      }

      if (close !== null && character === close) {
        this.index++
        return entries
      }

      if (character === ')') {
        if (close === ')') {
          this.index++
          return entries
        }
        this.index++
        nextSeparator = ';'
        pipelineNext = false
        continue
      }

      if (character === '(') {
        const named = nextSeparator === null ? members[members.length - 1] : undefined
        const child = this.openScope(scope, depth, this.index, 1, ')', limit, 'subshell')
        if (child === null) return null
        if (named?.kind === 'command' && named.command.words.length > 0 &&
          child.entry.kind === 'scope' && child.entry.entries.length === 0) named.command.defines = true
        entries.push(child.entry)
        if (pipelineNext) this.markDetached(child.entry)
        members.push(child.entry)
        nextSeparator = null
        pipelineNext = false
        continue
      }

      if (character === ';') {
        this.index++
        if (this.index < limit && (this.source[this.index] === ';' || this.source[this.index] === '&')) this.index++
        nextSeparator = ';'
        listStart = members.length
        pipelineNext = false
        continue
      }

      if (character === '|') {
        if (members.length === 0) return null
        const previous = members[members.length - 1]
        if (this.index + 1 < limit && this.source[this.index + 1] === '|') {
          this.index += 2
          nextSeparator = '||'
          pipelineNext = false
        } else {
          this.markDetached(previous)
          this.index += this.index + 1 < limit && this.source[this.index + 1] === '&' ? 2 : 1
          nextSeparator = '|'
          pipelineNext = true
        }
        continue
      }

      if (character === '&' && !(this.index + 1 < limit && this.source[this.index + 1] === '>')) {
        if (this.index + 1 < limit && this.source[this.index + 1] === '&') {
          if (members.length === 0) return null
          this.index += 2
          nextSeparator = '&&'
          pipelineNext = false
        } else {
          if (members.length === 0) return null
          this.index++
          for (let i = listStart; i < members.length; i++) this.markDetached(members[i])
          listStart = members.length
          nextSeparator = '&'
          pipelineNext = false
        }
        continue
      }

      const result = this.parseSimple(scope, depth, limit, close, nextSeparator, pipelineNext)
      if (result === null || result.entry === null) return null
      for (const item of result.heredocs) this.eligibleHeredocs.push(item)
      entries.push(result.entry)
      members.push(result.entry)
      nextSeparator = null
      pipelineNext = false
    }
  }

  private markDetached(entry: Entry): void {
    if (entry.kind === 'command') {
      entry.command.detached = true
      return
    }
    for (const child of entry.entries) this.markDetached(child)
  }

  private hasEligibleHeredocs(): boolean {
    return this.eligibleHeredocIndex < this.eligibleHeredocs.length
  }

  private parseSimple(
    scope: number,
    depth: number,
    limit: number,
    close: ')' | '`' | null,
    separator: ShellSeparator | null,
    pipelineNext: boolean
  ): { entry: Extract<Entry, { kind: 'command' }> | null; heredocs: PendingHeredoc[] } | null {
    const heredocs: PendingHeredoc[] = []
    const active: ActiveCommand = {
      command: {
        scope,
        sep: separator,
        detached: false,
        assignments: [],
        words: [],
        redirects: []
      },
      before: [],
      assignmentAllowed: true
    }

    while (true) {
      this.skipInline(limit)
      if (this.index >= limit) break
      const character = this.source[this.index]
      if (character === '\n' || character === ')' || character === ';' || character === '|' || character === '#') break
      if (character === '&' && !(this.index + 1 < limit && this.source[this.index + 1] === '>')) break
      if (character === '`' && close === '`') break

      const redirect = this.findRedirectOperator(limit)
      if (redirect !== null) {
        this.index = redirect.end
        const targetStart = this.skipRedirectSpace(limit)
        if (targetStart === null) return null
        const target = this.readWord(
          scope,
          depth,
          close,
          limit,
          redirect.op === '<<' || redirect.op === '<<-' ? 'delimiter' : 'word',
          true,
          redirect.op !== '<<<'
        )
        if (target === null || !target.consumed) return null
        const command = active
        this.appendEntries(command.before, target.before)
        const op = redirect.op
        if (op === '<<' || op === '<<-') {
          if (target.word.dynamic) return null
          const descriptor = this.source.slice(redirect.start, redirect.end - op.length)
          const item: ShellRedirect = { kind: 'heredoc', target: target.word }
          command.command.redirects.push(item)
          heredocs.push({
            redirect: item,
            delimiter: target.word.text,
            stripTabs: op === '<<-',
            quoted: target.quoted,
            stdin: descriptor === '' || /^0+$/.test(descriptor),
            before: command.before,
            ownerScope: scope,
            ownerDepth: depth
          })
        } else {
          for (const targetWord of target.words ?? [target.word]) {
            let kind: ShellRedirect['kind']
            if (op === '<') kind = 'read'
            else if (op === '<<<') kind = 'heredoc'
            else if (op === '<&') kind = 'dup'
            else if (op === '<>') kind = 'write'
            else if (op === '>&' && !targetWord.dynamic && this.isDescriptorTarget(targetWord.text)) kind = 'dup'
            else kind = 'write'
            command.command.redirects.push({ kind, target: targetWord })
          }
        }
        continue
      }

      if (active.assignmentAllowed) {
        const assignment = this.findAssignmentPrefix(limit)
        if (assignment !== null) {
          this.index = assignment.valueStart
          const value = this.readWord(scope, depth, close, limit, 'word', false, false)
          if (value === null) return null
          if (assignment.append) value.word.dynamic = true
          const command = active
          this.appendEntries(command.before, value.before)
          command.command.assignments.push({ name: assignment.name, value: value.word })
          continue
        }
      }

      const word = this.readWord(scope, depth, close, limit)
      if (word === null) return null
      if (!word.consumed) break
      const command = active
      this.appendEntries(command.before, word.before)
      for (const expandedWord of word.words ?? [word.word]) command.command.words.push(expandedWord)
      command.assignmentAllowed = false
    }

    if (active.command.words.length === 0 && active.command.assignments.length === 0 && active.command.redirects.length === 0) {
      return { entry: null, heredocs }
    }
    if (pipelineNext) active.command.detached = true
    return {
      entry: {
        kind: 'command',
        command: active.command,
        before: active.before,
        quotedHeredoc: heredocs.length === 1 && heredocs[0]?.quoted === true && heredocs[0]?.stdin === true
      },
      heredocs
    }
  }

  private findRedirectOperator(limit: number): RedirectOperator | null {
    const start = this.index
    let opStart = start
    while (opStart < limit && this.isDigit(this.source.charCodeAt(opStart))) opStart++
    if (opStart >= limit || (this.source[opStart] !== '<' && this.source[opStart] !== '>')) opStart = start
    const first = this.source[opStart]
    const second = opStart + 1 < limit ? this.source[opStart + 1] : ''
    if (first === '&' && second === '>') {
      let end = opStart + 2
      if (end < limit && this.source[end] === '>') end++
      return { start, end, op: this.source.slice(opStart, end) }
    }
    if ((first === '<' || first === '>') && second === '(') return null
    if (first !== '<' && first !== '>') return null

    let end = opStart + 1
    if (first === '<') {
      if (second === '<') {
        end++
        if (end < limit && this.source[end] === '-') end++
        else if (end < limit && this.source[end] === '<') end++
      } else if (second === '>' || second === '&') {
        end++
      }
    } else if (second === '>' || second === '|' || second === '&') {
      end++
    }
    return { start, end, op: this.source.slice(opStart, end) }
  }

  private skipRedirectSpace(limit: number): number | null {
    while (this.index < limit) {
      const character = this.source[this.index]
      if (character === ' ' || character === '\t') {
        this.index++
      } else if (character === '\\' && this.index + 1 < limit && this.source[this.index + 1] === '\n') {
        this.index += 2
      } else {
        break
      }
    }
    if (this.index >= limit || this.source[this.index] === '\n') return null
    return this.index
  }

  private findAssignmentPrefix(limit: number): { name: string; valueStart: number; append: boolean } | null {
    const start = this.index
    if (start >= limit || !this.isNameStart(this.source.charCodeAt(start))) return null
    let cursor = start + 1
    while (cursor < limit && this.isNameContinue(this.source.charCodeAt(cursor))) cursor++
    const nameEnd = cursor
    if (cursor < limit && this.source[cursor] === '=') {
      return { name: this.source.slice(start, nameEnd), valueStart: cursor + 1, append: false }
    }
    if (cursor + 1 < limit && this.source[cursor] === '+' && this.source[cursor + 1] === '=') {
      return { name: this.source.slice(start, nameEnd), valueStart: cursor + 2, append: true }
    }
    return null
  }

  private readWord(
    scope: number,
    depth: number,
    close: ')' | '`' | null,
    limit: number,
    mode: 'word' | 'delimiter' = 'word',
    commentAtStart = true,
    braceExpansion = true
  ): WordResult | null {
    const builder = new WordBuilder(this.source, this.home)
    let cursor = this.index
    let segmentStart = cursor
    let quote = ''
    let consumed = false
    let quoted = false

    while (cursor < limit) {
      const character = this.source[cursor]
      if (quote === "'") {
        if (character === "'") {
          builder.appendRange(segmentStart, cursor)
          cursor++
          segmentStart = cursor
          quote = ''
        } else {
          cursor++
        }
        consumed = true
        continue
      }

      if (quote === '"') {
        if (character === '"') {
          builder.appendRange(segmentStart, cursor)
          cursor++
          segmentStart = cursor
          quote = ''
          consumed = true
          continue
        }
        if (character === '\\' && cursor + 1 < limit) {
          const next = this.source[cursor + 1]
          if (next === '\n') {
            builder.appendRange(segmentStart, cursor)
            cursor += 2
            segmentStart = cursor
            consumed = true
            continue
          }
          if (next === '$' || next === '`' || next === '"' || next === '\\') {
            builder.appendRange(segmentStart, cursor)
            builder.append(next)
            cursor += 2
            segmentStart = cursor
            consumed = true
            continue
          }
        }
        if (character === '$' && mode !== 'delimiter') {
          builder.appendRange(segmentStart, cursor)
          this.index = cursor
          const handled = this.readDollar(builder, scope, depth, limit, mode, false, true)
          if (handled === null) return null
          if (handled) {
            cursor = this.index
            segmentStart = cursor
            consumed = true
            continue
          }
          cursor++
          segmentStart = cursor - 1
          consumed = true
          continue
        }
        if (character === '`' && mode !== 'delimiter') {
          builder.appendRange(segmentStart, cursor)
          const nested = this.openBacktickScope(scope, depth, cursor, limit)
          if (nested === null) return null
          builder.dynamic = true
          builder.appendRange(cursor, this.index)
          builder.addScope(nested)
          cursor = this.index
          segmentStart = cursor
          consumed = true
          continue
        }

        cursor++
        consumed = true
        continue
      }

      if (close !== null && character === close) break
      if (
        this.isWordBreak(character) &&
        !(character === '<' && cursor + 1 < limit && this.source[cursor + 1] === '(') &&
        !(character === '>' && cursor + 1 < limit && this.source[cursor + 1] === '(')
      ) break
      if (character === '#' && !consumed && commentAtStart) break

      if (character === '\\') {
        if (cursor + 1 >= limit) return null
        builder.appendRange(segmentStart, cursor)
        const next = this.source[cursor + 1]
        if (next !== '\n') builder.append(next)
        cursor += 2
        segmentStart = cursor
        consumed = consumed || next !== '\n'
        if (next !== '\n') quoted = true
        continue
      }

      if (character === "'") {
        builder.appendRange(segmentStart, cursor)
        quote = "'"
        cursor++
        segmentStart = cursor
        consumed = true
        quoted = true
        continue
      }

      if (character === '"') {
        builder.appendRange(segmentStart, cursor)
        quote = '"'
        cursor++
        segmentStart = cursor
        consumed = true
        quoted = true
        continue
      }

      if (character === '$') {
        builder.appendRange(segmentStart, cursor)
        const delimiterAnsiQuote = mode === 'delimiter' && cursor + 1 < limit && this.source[cursor + 1] === "'"
        this.index = cursor
        const handled = this.readDollar(builder, scope, depth, limit, mode)
        if (handled === null) return null
        if (handled) {
          if (delimiterAnsiQuote) quoted = true
          cursor = this.index
          segmentStart = cursor
          consumed = true
          continue
        }
        if (cursor + 1 < limit && (this.source[cursor + 1] === ',' || this.source[cursor + 1] === '}')) {
          builder.ambiguousBraceDollar = true
        }
        cursor++
        segmentStart = cursor - 1
        consumed = true
        continue
      }

      if (character === '`') {
        builder.appendRange(segmentStart, cursor)
        const nested = this.openBacktickScope(scope, depth, cursor, limit)
        if (nested === null) return null
        builder.dynamic = true
        builder.appendRange(cursor, this.index)
        builder.addScope(nested)
        cursor = this.index
        segmentStart = cursor
        consumed = true
        continue
      }

      if (
        character === '{' || character === '}' || character === ',' ||
        (character === '~' && mode !== 'delimiter')
      ) {
        builder.markSyntax(builder.length + cursor - segmentStart, cursor, character)
      }

      if (
        (character === '<' || character === '>') &&
        cursor + 1 < limit &&
        this.source[cursor + 1] === '('
      ) {
        builder.appendRange(segmentStart, cursor)
        const nested = this.openScope(scope, depth, cursor, 2, ')', limit, 'process-substitution')
        if (nested === null) return null
        builder.dynamic = true
        builder.appendRange(cursor, this.index)
        builder.addScope(nested)
        cursor = this.index
        segmentStart = cursor
        consumed = true
        continue
      }

      cursor++
      consumed = true
    }

    if (quote !== '') return null
    builder.appendRange(segmentStart, cursor)
    const raw = builder.rawText()
    const words = this.expandWord(builder, raw, braceExpansion && mode !== 'delimiter')
    this.index = cursor
    return { word: words[0]!, words, before: builder.before, quoted, consumed }
  }

  private expandWord(builder: WordBuilder, raw: string, expandBraces: boolean): ShellWord[] {
    if (builder.dynamic) return [this.dynamicWord(builder, raw)]
    if (!expandBraces) {
      const word = this.resolveWord(raw, builder.homes, this.tildePositions(builder.syntax), builder.subs)
      return word.dynamic ? [this.dynamicWord(builder, raw)] : [word]
    }

    const plan = this.planBraces(raw, builder)
    if (plan === null || (plan.hasList && (plan.count > MAX_BRACE_WORDS || plan.canBeEmpty))) {
      return [this.dynamicWord(builder, raw)]
    }
    if (!plan.hasList) {
      const word = this.resolveWord(raw, builder.homes, this.tildePositions(builder.syntax), builder.subs)
      return word.dynamic ? [this.dynamicWord(builder, raw)] : [word]
    }

    const words: ShellWord[] = []
    for (let rank = 0; rank < plan.count; rank++) {
      this.selectBraceSequence(plan.expandingRoots, rank)
      const candidate: BraceCandidate = {
        ranges: [],
        homes: [],
        tildes: [],
        length: 0,
        homeIndex: 0,
        syntaxIndex: 0
      }
      this.renderBraceSequence(raw, builder.homes, builder.syntax, candidate, plan.expandingRoots, 0, raw.length)
      const word = this.resolveWord(
        this.joinBraceCandidate(raw, candidate),
        candidate.homes,
        candidate.tildes,
        builder.subs
      )
      if (word.dynamic) return [this.dynamicWord(builder, raw)]
      words.push(word)
    }
    return words
  }

  private dynamicWord(builder: WordBuilder, raw: string): ShellWord {
    return { text: builder.fallbackText(raw), dynamic: true, subs: builder.subs.slice() }
  }

  private tildePositions(syntax: ActiveSyntax[]): number[] {
    const positions: number[] = []
    for (const item of syntax) if (item.character === '~') positions.push(item.position)
    return positions
  }

  private resolveWord(text: string, homes: HomeMarker[], tildes: number[], subs: number[]): ShellWord {
    let tildeHome = false
    for (const position of tildes) {
      if (position !== 0) continue
      const next = text[1]
      if (next === undefined || next === '/' || this.isWordBreak(next)) {
        tildeHome = true
      } else if (next === '+' || next === '-' || this.isNameStart(text.charCodeAt(1))) {
        return { text, dynamic: true, subs: subs.slice() }
      }
      break
    }

    if (homes.length === 0 && !tildeHome) return { text, dynamic: false, subs: subs.slice() }
    const pieces: string[] = []
    let homeIndex = 0
    let cursor = 0
    let tildePending = tildeHome
    while (homeIndex < homes.length || tildePending) {
      const marker = homes[homeIndex]
      const start = tildePending ? 0 : marker?.start ?? text.length
      if (marker !== undefined && marker.start < start) {
        pieces.push(text.slice(cursor, marker.start), this.home)
        cursor = marker.end
        homeIndex++
      } else if (tildePending) {
        pieces.push(text.slice(cursor, 0), this.home)
        cursor = 1
        tildePending = false
      } else if (marker !== undefined) {
        pieces.push(text.slice(cursor, marker.start), this.home)
        cursor = marker.end
        homeIndex++
      }
    }
    pieces.push(text.slice(cursor))
    return { text: pieces.join(''), dynamic: false, subs: subs.slice() }
  }

  private planBraces(text: string, builder: WordBuilder): BracePlan | null {
    const syntax = builder.syntax
    const unmatchedOpens: ActiveSyntax[] = []
    const groups: BraceGroup[] = []
    let sawOpening = false
    for (const item of syntax) {
      if (item.character === '{') {
        sawOpening = true
        unmatchedOpens.push(item)
      } else if (item.character === '}' && unmatchedOpens.length > 0) {
        const opening = unmatchedOpens.pop()!
        const group: BraceGroup = {
          open: opening.position,
          close: item.position,
          commas: [],
          children: [],
          expandingChildren: null,
          alternatives: [],
          isList: false,
          hasList: false,
          canBeEmpty: false,
          count: 1,
          rankDivisor: 1,
          selectedAlternative: 0
        }
        opening.group = group
        item.group = group
        groups.push(group)
      } else if (item.character === '}' && sawOpening) {
        return null
      }
    }

    const roots: BraceGroup[] = []
    const parents: BraceGroup[] = []
    for (const item of syntax) {
      if (item.character === '{' && item.group !== undefined) {
        if (parents.length >= MAX_SHELL_DEPTH) return null
        const parent = parents[parents.length - 1]
        if (parent === undefined) roots.push(item.group)
        else parent.children.push(item.group)
        parents.push(item.group)
      } else if (item.character === ',' && parents.length > 0) {
        parents[parents.length - 1]!.commas.push(item.position)
      } else if (item.character === '}' && item.group !== undefined) {
        parents.pop()
      }
    }
    for (const group of groups) group.isList = group.commas.length > 0

    let syntaxIndex = 0
    let plainDepth = 0
    const openGroups: BraceGroup[] = []
    let overrideIndex = 0
    for (let position = 0; position < text.length; position++) {
      const item = syntax[syntaxIndex]?.position === position ? syntax[syntaxIndex] : undefined
      if (item?.character === '{' && item.group !== undefined) {
        openGroups.push(item.group)
        if (!item.group.isList) plainDepth++
      }

      while (
        overrideIndex < builder.fallbackOverrides.length &&
        builder.fallbackOverrides[overrideIndex]!.end <= position
      ) overrideIndex++
      const override = builder.fallbackOverrides[overrideIndex]
      const opaqueHere = override !== undefined && override.start <= position && position < override.end
      if (
        plainDepth > 0 &&
        text.charCodeAt(position) === 46 &&
        position + 1 < text.length &&
        text.charCodeAt(position + 1) === 46
      ) {
        let nextOverrideIndex = overrideIndex
        while (
          nextOverrideIndex < builder.fallbackOverrides.length &&
          builder.fallbackOverrides[nextOverrideIndex]!.end <= position + 1
        ) nextOverrideIndex++
        const nextOverride = builder.fallbackOverrides[nextOverrideIndex]
        const opaqueNext = nextOverride !== undefined &&
          nextOverride.start <= position + 1 && position + 1 < nextOverride.end
        if (!opaqueHere && !opaqueNext) return null
      }

      if (item?.character === '}' && item.group !== undefined) {
        const group = openGroups.pop()!
        if (!group.isList) plainDepth--
      }
      if (item !== undefined) syntaxIndex++
    }

    let hasList = false
    for (const group of groups) {
      if (!group.isList) continue
      hasList = true
    }
    if (hasList && unmatchedOpens.length > 1) return null
    if (hasList) {
      if (builder.ambiguousBraceDollar) return null
      let activeIndex = 0
      for (const home of builder.homes) {
        if (home.braced) continue
        while (activeIndex < syntax.length && syntax[activeIndex]!.source < home.sourceEnd) activeIndex++
        const following = syntax[activeIndex]
        if (
          following !== undefined &&
          following.source === home.sourceEnd &&
          (following.character === '{' || following.character === '}' || following.character === ',')
        ) return null
      }
    }

    for (const group of groups) {
      if (group.isList) {
        let childStart = 0
        let alternativeStart = group.open + 1
        let count = 0
        let canBeEmpty = false
        for (let alternativeIndex = 0; alternativeIndex <= group.commas.length; alternativeIndex++) {
          const boundary = alternativeIndex < group.commas.length
            ? group.commas[alternativeIndex]!
            : group.close
          let childEnd = childStart
          while (childEnd < group.children.length && group.children[childEnd]!.open < boundary) childEnd++
          const stats = this.countBraceSequence(group.children, childStart, childEnd, alternativeStart, boundary)
          const expandingChildren = this.expandingBraceChildren(group.children, childStart, childEnd)
          group.alternatives.push({
            start: alternativeStart,
            end: boundary,
            expandingChildren,
            count: stats.count
          })
          count = Math.min(MAX_BRACE_WORDS + 1, count + stats.count)
          canBeEmpty ||= stats.canBeEmpty
          childStart = childEnd
          alternativeStart = boundary + 1
        }
        group.count = count
        group.canBeEmpty = canBeEmpty
      } else {
        const stats = this.countBraceSequence(group.children, 0, group.children.length, group.open + 1, group.close)
        group.count = stats.count
        group.canBeEmpty = false
      }
      group.expandingChildren = this.expandingBraceChildren(group.children, 0, group.children.length)
      group.hasList = group.isList || group.expandingChildren !== null
    }

    const stats = this.countBraceSequence(roots, 0, roots.length, 0, text.length)
    return {
      expandingRoots: this.expandingBraceChildren(roots, 0, roots.length) ?? [],
      count: stats.count,
      canBeEmpty: stats.canBeEmpty,
      hasList
    }
  }

  private countBraceSequence(
    children: BraceGroup[],
    first: number,
    last: number,
    start: number,
    end: number
  ): { count: number; canBeEmpty: boolean } {
    let count = 1
    let canBeEmpty = true
    let cursor = start
    for (let index = first; index < last; index++) {
      const child = children[index]!
      count = Math.min(MAX_BRACE_WORDS + 1, count * child.count)
      if (child.open !== cursor || !child.canBeEmpty) canBeEmpty = false
      cursor = child.close + 1
    }
    if (cursor !== end) canBeEmpty = false

    let divisor = 1
    for (let index = last - 1; index >= first; index--) {
      const child = children[index]!
      child.rankDivisor = divisor
      divisor = Math.min(MAX_BRACE_WORDS + 1, divisor * child.count)
    }
    return { count, canBeEmpty }
  }

  private expandingBraceChildren(children: BraceGroup[], first: number, last: number): BraceGroup[] | null {
    let expanding: BraceGroup[] | null = null
    for (let index = first; index < last; index++) {
      const child = children[index]!
      if (!child.hasList) continue
      if (expanding === null) expanding = []
      expanding.push(child)
    }
    return expanding
  }

  private selectBraceSequence(children: BraceGroup[], rank: number): void {
    for (const group of children) {
      const childRank = Math.floor(rank / group.rankDivisor) % group.count
      this.selectBraceGroup(group, childRank)
    }
  }

  private selectBraceGroup(group: BraceGroup, rank: number): void {
    if (!group.isList) {
      this.selectBraceSequence(group.expandingChildren ?? [], rank)
      return
    }
    let alternativeIndex = 0
    let alternativeRank = rank
    for (; alternativeIndex < group.alternatives.length; alternativeIndex++) {
      const alternative = group.alternatives[alternativeIndex]!
      if (alternativeRank < alternative.count) break
      alternativeRank -= alternative.count
    }
    group.selectedAlternative = alternativeIndex
    const alternative = group.alternatives[alternativeIndex]!
    this.selectBraceSequence(alternative.expandingChildren ?? [], alternativeRank)
  }

  private renderBraceSequence(
    text: string,
    homes: HomeMarker[],
    syntax: ActiveSyntax[],
    candidate: BraceCandidate,
    children: BraceGroup[],
    start: number,
    end: number
  ): void {
    let cursor = start
    for (const group of children) {
      this.appendBraceRange(text, homes, syntax, candidate, cursor, group.open)
      this.renderBraceGroup(text, homes, syntax, candidate, group)
      cursor = group.close + 1
    }
    this.appendBraceRange(text, homes, syntax, candidate, cursor, end)
  }

  private renderBraceGroup(
    text: string,
    homes: HomeMarker[],
    syntax: ActiveSyntax[],
    candidate: BraceCandidate,
    group: BraceGroup
  ): void {
    if (group.isList) {
      const alternative = group.alternatives[group.selectedAlternative]!
      this.renderBraceSequence(
        text,
        homes,
        syntax,
        candidate,
        alternative.expandingChildren ?? [],
        alternative.start,
        alternative.end
      )
      return
    }
    this.appendBraceRange(text, homes, syntax, candidate, group.open, group.open + 1)
    this.renderBraceSequence(
      text,
      homes,
      syntax,
      candidate,
      group.expandingChildren ?? [],
      group.open + 1,
      group.close
    )
    this.appendBraceRange(text, homes, syntax, candidate, group.close, group.close + 1)
  }

  private appendBraceRange(
    text: string,
    homes: HomeMarker[],
    syntax: ActiveSyntax[],
    candidate: BraceCandidate,
    start: number,
    end: number
  ): void {
    if (end <= start) return
    const outputStart = candidate.length
    while (candidate.homeIndex < homes.length && homes[candidate.homeIndex]!.start < start) {
      candidate.homeIndex++
    }
    while (candidate.homeIndex < homes.length && homes[candidate.homeIndex]!.start < end) {
      const marker = homes[candidate.homeIndex]!
      if (marker.start >= start) {
        candidate.homes.push({
          start: outputStart + marker.start - start,
          end: outputStart + marker.end - start,
          sourceEnd: marker.sourceEnd,
          braced: marker.braced
        })
      }
      candidate.homeIndex++
    }
    while (candidate.syntaxIndex < syntax.length && syntax[candidate.syntaxIndex]!.position < start) {
      candidate.syntaxIndex++
    }
    while (candidate.syntaxIndex < syntax.length && syntax[candidate.syntaxIndex]!.position < end) {
      const item = syntax[candidate.syntaxIndex]!
      if (item.character === '~') candidate.tildes.push(outputStart + item.position - start)
      candidate.syntaxIndex++
    }

    const previous = candidate.ranges[candidate.ranges.length - 1]
    if (previous !== undefined && previous.end === start) previous.end = end
    else candidate.ranges.push({ start, end })
    candidate.length += end - start
  }

  private joinBraceCandidate(text: string, candidate: BraceCandidate): string {
    if (candidate.ranges.length === 1) {
      const range = candidate.ranges[0]!
      if (range.start === 0 && range.end === text.length) return text
    }
    const pieces: string[] = []
    for (const range of candidate.ranges) pieces.push(text.slice(range.start, range.end))
    return pieces.join('')
  }

  private readDollar(
    builder: WordBuilder,
    scope: number,
    depth: number,
    limit: number,
    mode: 'word' | 'delimiter' | 'heredoc',
    stripTabs = false,
    doubleQuoted = false
  ): boolean | null {
    const start = this.index
    if (start + 1 >= limit) return false
    const next = this.source[start + 1]
    if (mode === 'delimiter' && next === '"') return null

    if (next === '(' && start + 2 < limit && this.source[start + 2] === '(') {
      builder.dynamic = true
      if (!this.scanExtended(builder, scope, depth, limit, 'arithmetic', doubleQuoted)) return null
      this.appendExpansionRange(builder, start, this.index, mode, stripTabs)
      return true
    }

    if (next === '(') {
      const nested = this.openScope(scope, depth, start, 2, ')', limit, 'command-substitution')
      if (nested === null) return null
      const knownValue = doubleQuoted ? this.knownCatHeredocValue(nested) : null
      if (knownValue === null) {
        builder.dynamic = true
        this.appendExpansionRange(builder, start, this.index, mode, stripTabs)
      } else {
        builder.appendKnownExpansion(start, this.index, knownValue)
      }
      builder.addScope(nested)
      return true
    }

    if (next === '{') {
      if (start + 7 <= limit && this.source.startsWith('${HOME}', start)) {
        if (mode === 'delimiter') builder.appendRange(start, start + 7)
        else builder.appendHomeRange(start, start + 7, true)
        this.index = start + 7
        return true
      }
      builder.dynamic = true
      if (!this.scanExtended(builder, scope, depth, limit, 'parameter', doubleQuoted)) return null
      this.appendExpansionRange(builder, start, this.index, mode, stripTabs)
      return true
    }

    if (next === "'" && mode !== 'heredoc' && !doubleQuoted) {
      let cursor = start + 2
      let escaped = false
      while (cursor < limit) {
        const character = this.source[cursor]
        if (character === '\\') {
          escaped = true
          cursor += 2
          continue
        }
        if (character === "'") break
        cursor++
      }
      if (cursor >= limit) return null
      if (escaped) {
        builder.dynamic = true
        builder.appendRange(start, cursor + 1)
      } else {
        builder.appendRange(start + 2, cursor)
      }
      this.index = cursor + 1
      return true
    }

    if (this.isNameStart(this.source.charCodeAt(start + 1))) {
      const end = this.identifierEnd(start + 1, limit)
      if (this.source.slice(start + 1, end) === 'HOME') {
        if (mode === 'delimiter') builder.appendRange(start, end)
        else builder.appendHomeRange(start, end)
      } else {
        builder.dynamic = true
        this.appendExpansionRange(builder, start, end, mode, stripTabs)
      }
      this.index = end
      return true
    }

    if (this.isDigit(this.source.charCodeAt(start + 1)) || '!#$*@?-'.includes(next)) {
      builder.dynamic = true
      this.appendExpansionRange(builder, start, start + 2, mode, stripTabs)
      this.index = start + 2
      return true
    }

    return false
  }

  private knownCatHeredocValue(scope: ScopeResult): string | null {
    if (scope.entry.kind !== 'scope' || scope.entry.entries.length !== 1) return null
    const entry = scope.entry.entries[0]
    if (entry === undefined || entry.kind !== 'command' || entry.before.length !== 0 || !entry.quotedHeredoc) return null

    const command = entry.command
    if (command.assignments.length !== 0 || command.words.length !== 1 || command.redirects.length !== 1) {
      return null
    }
    const word = command.words[0]
    const redirect = command.redirects[0]
    if (
      word === undefined ||
      word.text !== 'cat' ||
      word.dynamic ||
      redirect === undefined ||
      redirect.kind !== 'heredoc' ||
      redirect.target.dynamic
    ) {
      return null
    }

    const value = redirect.target.text
    let end = value.length
    while (end > 0 && value.charCodeAt(end - 1) === 10) end--
    return end === value.length ? value : value.slice(0, end)
  }

  private appendExpansionRange(
    builder: WordBuilder,
    start: number,
    end: number,
    mode: 'word' | 'delimiter' | 'heredoc',
    stripTabs: boolean
  ): void {
    if (mode === 'heredoc') builder.appendHeredocRange(start, end, stripTabs, false)
    else builder.appendRange(start, end)
  }

  private scanExtended(
    builder: WordBuilder,
    scope: number,
    depth: number,
    limit: number,
    initial: 'parameter' | 'arithmetic',
    doubleQuoted: boolean
  ): boolean {
    if (depth >= MAX_SHELL_DEPTH) return false
    const frames: ExpansionFrame[] = []
    if (initial === 'parameter') {
      if (this.source[this.index + 2] === '(') return false
      this.index += 2
      frames.push({ kind: 'parameter', braces: 1, quote: '', doubleQuoted })
    } else {
      this.index += 3
      frames.push({ kind: 'arithmetic', parentheses: 0, quote: '', doubleQuoted })
    }

    while (frames.length > 0) {
      if (this.index >= limit) return false
      const frame = frames[frames.length - 1]
      const character = this.source[this.index]

      if (character === '\\' && frame.quote !== "'") {
        this.index += this.index + 1 < limit ? 2 : 1
        continue
      }

      if (frame.quote !== '') {
        if (character === frame.quote) {
          frame.quote = ''
          this.index++
          continue
        }
        if (frame.quote === "'") {
          this.index++
          continue
        }
      } else if (character === '"' || (character === "'" && !frame.doubleQuoted)) {
        frame.quote = character
        this.index++
        continue
      }

      if (frame.quote !== "'") {
        if (character === '$' && this.index + 2 < limit && this.source[this.index + 1] === '(' && this.source[this.index + 2] === '(') {
          if (depth + frames.length >= MAX_SHELL_DEPTH) return false
          this.index += 3
          frames.push({
            kind: 'arithmetic',
            parentheses: 0,
            quote: '',
            doubleQuoted: frame.doubleQuoted || frame.quote === '"'
          })
          continue
        }
        if (character === '$' && this.index + 1 < limit && this.source[this.index + 1] === '(') {
          const nested = this.openScope(scope, depth + frames.length, this.index, 2, ')', limit, 'command-substitution')
          if (nested === null) return false
          builder.addScope(nested)
          continue
        }
        if (character === '$' && this.index + 1 < limit && this.source[this.index + 1] === '{') {
          if (depth + frames.length >= MAX_SHELL_DEPTH) return false
          if (this.source[this.index + 2] === '(') return false
          this.index += 2
          frames.push({
            kind: 'parameter',
            braces: 1,
            quote: '',
            doubleQuoted: frame.doubleQuoted || frame.quote === '"'
          })
          continue
        }
        if (character === '`') {
          const nested = this.openBacktickScope(scope, depth + frames.length, this.index, limit)
          if (nested === null) return false
          builder.addScope(nested)
          continue
        }
        if (
          frame.kind === 'parameter' &&
          frame.quote === '' &&
          !frame.doubleQuoted &&
          (character === '<' || character === '>') &&
          this.index + 1 < limit &&
          this.source[this.index + 1] === '('
        ) {
          const nested = this.openScope(scope, depth + frames.length, this.index, 2, ')', limit, 'process-substitution')
          if (nested === null) return false
          builder.addScope(nested)
          continue
        }
      }

      if (frame.kind === 'parameter') {
        if (frame.quote === '' && character === '}') {
          frame.braces--
          this.index++
          if (frame.braces === 0) frames.pop()
          continue
        }
        this.index++
        continue
      }

      if (frame.quote === '') {
        if (character === '(') {
          frame.parentheses++
          this.index++
          continue
        }
        if (character === ')') {
          if (frame.parentheses > 0) {
            frame.parentheses--
            this.index++
            continue
          }
          if (this.index + 1 >= limit || this.source[this.index + 1] !== ')') return false
          this.index += 2
          frames.pop()
          continue
        }
      }
      this.index++
    }
    return true
  }
  private openScope(
    parent: number,
    depth: number,
    start: number,
    openingLength: number,
    close: ')' | '`',
    limit: number,
    kind: Exclude<ScopeKind, 'root' | 'backtick'>
  ): ScopeResult | null {
    if (depth >= MAX_SHELL_DEPTH) return null
    const id = this.parents.length
    this.parents.push(parent)
    this.scopeKinds.push(kind)
    this.index = start + openingLength
    const entries = this.parseScope(id, depth + 1, close, limit)
    if (entries === null) return null
    return { id, entry: { kind: 'scope', entries } }
  }

  private openBacktickScope(parent: number, depth: number, start: number, limit: number): ScopeResult | null {
    if (depth >= MAX_SHELL_DEPTH) return null
    const bodyStart = start + 1
    let cursor = bodyStart
    let segmentStart = bodyStart
    const chunks: string[] = []

    while (cursor < limit) {
      const character = this.source[cursor]
      const next = cursor + 1 < limit ? this.source[cursor + 1] : ''
      if (character === '\\' && (next === '`' || next === '$' || next === '\\')) {
        chunks.push(this.source.slice(segmentStart, cursor), next)
        cursor += 2
        segmentStart = cursor
        continue
      }
      if (character === '`') {
        if (chunks.length === 0) chunks.push(this.source.slice(bodyStart, cursor))
        else if (segmentStart < cursor) chunks.push(this.source.slice(segmentStart, cursor))
        const id = this.parents.length
        this.parents.push(parent)
        this.scopeKinds.push('backtick')
        const reader = new ShellReader(chunks.join(''), this.home, this.parents, this.scopeKinds)
        const entries = reader.parseScope(id, depth + 1, null, reader.source.length)
        if (entries === null) return null
        this.index = cursor + 1
        return { id, entry: { kind: 'scope', entries } }
      }
      cursor++
    }
    return null
  }

  private isInsideCommandSubstitution(scope: number): boolean {
    for (let current = scope; current > 0; current = this.parents[current]) {
      if (this.scopeKinds[current] === 'command-substitution') return true
    }
    return false
  }

  private hasUnmatchedClosingParen(start: number, end: number): boolean {
    let openings = 0
    for (let cursor = start; cursor < end; cursor++) {
      if (this.source[cursor] === '(') openings++
      else if (this.source[cursor] === ')') {
        if (openings === 0) return true
        openings--
      }
    }
    return false
  }

  private consumeHeredocs(limit: number): boolean {
    while (this.hasEligibleHeredocs()) {
      const item = this.eligibleHeredocs[this.eligibleHeredocIndex++]
      const body = this.findHeredocBody(item.delimiter, item.stripTabs, item.quoted, limit)
      if (body === null) return false
      if (this.isInsideCommandSubstitution(item.ownerScope) && this.hasUnmatchedClosingParen(body.start, body.end)) return false
      if (item.quoted) {
        const builder = new WordBuilder(this.source, this.home)
        builder.appendHeredocRange(body.start, body.end, item.stripTabs, true)
        item.redirect.target = builder.finish()
      } else {
        const target = this.readHeredocExpansions(body.start, body.end, item.stripTabs, item.ownerScope, item.ownerDepth)
        if (target === null) return false
        item.redirect.target = target.word
        this.appendEntries(item.before, target.before)
      }
      this.index = body.after
    }
    this.eligibleHeredocs.length = 0
    this.eligibleHeredocIndex = 0
    return true
  }

  private findHeredocBody(
    delimiter: string,
    stripTabs: boolean,
    quoted: boolean,
    limit: number
  ): { start: number; end: number; after: number } | null {
    const start = this.index
    let cursor = start
    while (cursor <= limit) {
      const logicalStart = cursor
      let logicalLength = 0
      let matches = true
      while (true) {
        const lineStart = cursor
        let lineEnd = cursor
        while (lineEnd < limit && this.source[lineEnd] !== '\n') lineEnd++

        let compareStart = lineStart
        if (stripTabs && logicalLength === 0) while (compareStart < lineEnd && this.source.charCodeAt(compareStart) === 9) compareStart++

        let continuation = false
        if (!quoted && lineEnd < limit) {
          let slashStart = lineEnd
          while (slashStart > lineStart && this.source[slashStart - 1] === '\\') slashStart--
          continuation = ((lineEnd - slashStart) & 1) === 1
        }
        const compareEnd = continuation ? lineEnd - 1 : lineEnd
        for (let index = compareStart; index < compareEnd; index++) {
          if (matches && (logicalLength >= delimiter.length || this.source[index] !== delimiter[logicalLength])) {
            matches = false
          }
          logicalLength++
        }

        if (!continuation) {
          if (matches && logicalLength === delimiter.length) {
            return { start, end: logicalStart, after: lineEnd < limit ? lineEnd + 1 : lineEnd }
          }
          if (lineEnd >= limit) return null
          cursor = lineEnd + 1
          break
        }
        cursor = lineEnd + 1
      }
    }
    return null
  }

  private readHeredocExpansions(
    start: number,
    end: number,
    stripTabs: boolean,
    scope: number,
    depth: number
  ): WordResult | null {
    const builder = new WordBuilder(this.source, this.home)
    let cursor = start
    let segmentStart = start
    let segmentAtLineStart = true
    let lineStart = true

    while (cursor < end) {
      if (stripTabs && lineStart) {
        while (cursor < end && this.source.charCodeAt(cursor) === 9) cursor++
        lineStart = false
      }
      const character = this.source[cursor]
      if (character === '\n') {
        cursor++
        lineStart = true
        continue
      }
      if (character === '\\' && cursor + 1 < end) {
        const next = this.source[cursor + 1]
        if (next === '\n') {
          builder.appendHeredocRange(segmentStart, cursor, stripTabs, segmentAtLineStart)
          cursor += 2
          segmentStart = cursor
          segmentAtLineStart = true
          lineStart = true
          continue
        }
        if (next === '$' || next === '`' || next === '\\') {
          cursor += 2
          lineStart = false
          continue
        }
      }
      if (character === '$') {
        builder.appendHeredocRange(segmentStart, cursor, stripTabs, segmentAtLineStart)
        this.index = cursor
        const handled = this.readDollar(builder, scope, depth, end, 'heredoc', stripTabs)
        if (handled === null) return null
        if (handled) {
          cursor = this.index
          segmentStart = cursor
          segmentAtLineStart = cursor > start && this.source[cursor - 1] === '\n'
          lineStart = segmentAtLineStart
          continue
        }
        segmentStart = cursor
        cursor++
        segmentAtLineStart = false
        lineStart = false
        continue
      }
      if (character === '`') {
        builder.appendHeredocRange(segmentStart, cursor, stripTabs, segmentAtLineStart)
        this.index = cursor
        const nested = this.openBacktickScope(scope, depth, cursor, end)
        if (nested === null) return null
        builder.dynamic = true
        builder.appendHeredocRange(cursor, this.index, stripTabs, false)
        builder.addScope(nested)
        cursor = this.index
        segmentStart = cursor
        segmentAtLineStart = cursor > start && this.source[cursor - 1] === '\n'
        lineStart = segmentAtLineStart
        continue
      }
      cursor++
      lineStart = false
    }

    builder.appendHeredocRange(segmentStart, end, stripTabs, segmentAtLineStart)
    this.index = end
    return { word: builder.finish(), before: builder.before, quoted: false, consumed: end > start }
  }

  private appendEntries(target: Entry[], source: Entry[]): void {
    for (const entry of source) target.push(entry)
  }

  private skipInline(limit: number = this.source.length): void {
    while (this.index < limit) {
      const character = this.source[this.index]
      if (character === ' ' || character === '\t') {
        this.index++
      } else if (character === '\\' && this.index + 1 < limit && this.source[this.index + 1] === '\n') {
        this.index += 2
      } else {
        return
      }
    }
  }
  private isDescriptorTarget(text: string): boolean {
    if (text === '-') return true
    if (text.length === 0) return false
    for (let i = 0; i < text.length; i++) if (!this.isDigit(text.charCodeAt(i))) return false
    return true
  }

  private isWordBreak(character: string): boolean {
    return character === ' ' || character === '\t' || character === '\n' ||
      character === ';' || character === '&' || character === '|' || character === '<' || character === '>' ||
      character === '(' || character === ')'
  }

  private identifierEnd(start: number, limit: number): number {
    let cursor = start
    while (cursor < limit && this.isNameContinue(this.source.charCodeAt(cursor))) cursor++
    return cursor
  }

  private isNameStart(code: number): boolean {
    return code === 95 || code >= 65 && code <= 90 || code >= 97 && code <= 122
  }

  private isNameContinue(code: number): boolean {
    return this.isNameStart(code) || this.isDigit(code)
  }

  private isDigit(code: number): boolean {
    return code >= 48 && code <= 57
  }
}

/**
 * Reads a shell command into its simple commands. Returns null when the text can't be read:
 * see section 2, scenario 10. Never throws, and runs in time linear in the source's length.
 */
export function parseShell(source: string, env: { home: string }): ShellScript | null {
  try {
    if (source.length > MAX_SHELL_CHARS || source.includes('\0')) return null
    return new ShellReader(source, env.home).parse()
  } catch {
    return null
  }
}
