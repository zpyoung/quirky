# Vibrant markdown in quirky chat: tech spec

**Status:** Reviewed (tech-spec reviewer, fixes applied), for SDD run vmd1. Logic spec: [logic.md](logic.md).

## Architecture

The shared renderer lives in `packages/ui`, because `scripts/ui-lint.ts` only lints `packages/ui/src`, the window CSS chain starts there, and every plugin view runs in the same window document ([logic: Conceptual model](logic.md#conceptual-model)).

- **Renderer:** `packages/ui/src/markdown/`, exported as `@quirky/ui/markdown`. It wraps `streamdown` 2.8.x with the `@streamdown/code` (Shiki), `@streamdown/math` (KaTeX) plugins. Mermaid is a quirky custom renderer, not `@streamdown/mermaid`, because the Source toggle and error note ([SC-4](logic.md#behaviour--scenarios)) need our own component.
- **Styling:** `packages/ui/src/design-system/markdown.css`, imported from `packages/ui/src/design-system/styles.css`. It targets the root class `.qmd` and Streamdown's `[data-streamdown="…"]` hooks (`code-block`, `code-block-header`, `code-block-body`, `code-block-copy-button`, `inline-code`, `table-wrapper`, `table`, `table-header-cell`, `table-cell`, `blockquote`, `link`, `list-item`, `ordered-list`, `unordered-list`, `horizontal-rule`, `image-wrapper`, `subscript`, `superscript`, `strong`). There is no Tailwind in the repo. Pass `prefix="sd"` so Streamdown's utility classes become `sd:*` and can never match a quirky class. Do not import `streamdown/styles.css`.
- **Tokens:** new `--ui-syntax-*`, `--ui-diff-*`, `--ui-code-*` and `--ui-alert-*` tokens in `packages/ui/src/design-system/tokens.css`, in the dark block (lines 1-75) and the light block (lines 77-111).
- **Callers:**
  - chat prose: `plugins/quirky.session/src/window/chat/Prose.tsx`
  - the view markdown node: `plugins/quirky.view/src/render/Markdown.tsx` and `src/markdown.ts`
  - the interactive editor preview: `MarkdownPreview` in `plugins/quirky.editor/src/markdown/MarkdownSurface.tsx:485-557`
- **Chat asset resolution:** a new daemon method `quirky.session/markdownAssets` resolves path-chip candidates and worktree images for a session, because the chat webview has no filesystem access and `createFileResource` exists only on the daemon `PluginContext` (`packages/protocol/src/plugins.ts:85`) ([SC-6, SC-7](logic.md#behaviour--scenarios)).

## Code references

Create:

- `packages/ui/src/markdown/index.ts`: public exports. These are `QuirkyMarkdown`, `MarkdownProfile`, `MarkdownAssets`, `PATH_CANDIDATE` and `parseChartSpec`.
- `packages/ui/src/markdown/QuirkyMarkdown.tsx`: the component. It wraps `Streamdown` and maps a profile to Streamdown props.
- `packages/ui/src/markdown/math-dollars.ts` and `remark-loose-dollars.ts`: position-preserving loose-dollar handling (`remarkLooseDollars`, first remark plugin in both profiles).
- `packages/ui/src/markdown/blocks/Alert.tsx`: the `blockquote` component. It detects the alert marker at render time, so it works under any sanitize schema, the editor's included.
- `packages/ui/src/markdown/remark-path-candidates.ts`: splits text nodes outside code and links, turning `PATH_CANDIDATE` matches into `inlineCode` nodes with `data.hProperties['data-path-candidate']`. It is only added when `assets` is given.
- `packages/ui/src/markdown/remark-html-allowlist.ts`: in the untrusted profile, keeps allowed raw tags with no attributes and turns every other `html` node into a `text` node.
- `packages/ui/src/markdown/remark-mark.ts`: `==text==` becomes `<mark>`.
- `packages/ui/src/markdown/blocks/CodeBlock.tsx`: header, Copy, line numbers, collapse and diff tint.
- `packages/ui/src/markdown/blocks/MermaidBlock.tsx`: lazy `import('mermaid')`, `securityLevel: 'strict'`, the SVG through DOMPurify, a Source toggle and an error note.
- `packages/ui/src/markdown/blocks/DataBlocks.tsx`: the `csv`/`tsv` table, the `json` tree and the `chart` renderer.
- `packages/ui/src/markdown/blocks/PathChip.tsx` and `RemoteImageChip.tsx`.
- `packages/ui/src/markdown/blocks/RenderError.tsx`: the dashed error note shared by Mermaid, math and data fences.
- `packages/ui/src/design-system/markdown.css`.
- `plugins/quirky.session/src/markdownAssets.ts`: the daemon handler for `quirky.session/markdownAssets`.
- Tests:
  - `packages/ui/test/markdown-renderer.test.tsx`
  - `packages/ui/test/markdown-dollars.test.ts`
  - `packages/ui/test/markdown-tokens-contrast.test.ts`
  - `plugins/quirky.session/test/markdown-assets.test.ts`

Modify:

- `packages/ui/package.json`:
  - add `"./markdown": "./src/markdown/index.ts"` to `exports`;
  - add the dependencies `streamdown@^2.8.0`, `@streamdown/code@^2.0.1`, `@streamdown/math@^1.0.4`, `shiki@^4.6.0` (for `createCssVariablesTheme`), `mermaid@^11.12.0`, `dompurify@^3.3.0`, `remark-gfm@^4.0.1`, `remark-breaks@^4.0.0`, `remark-math@^6.0.0`, `rehype-raw@^7.0.0`, `rehype-sanitize@^6.0.0` and `unist-util-visit@^5.0.0`, `remark-gemoji` for emoji shortcodes, and the dev dependencies `@types/mdast` and `@types/hast`;
  - update `bun.lock` with `bun install`.
- `packages/ui/src/design-system/styles.css`: add `@import './markdown.css';` beside the existing `editor-markdown.css` import.
- `packages/ui/src/design-system/tokens.css`: the new tokens, in both theme blocks.
- `plugins/quirky.session/src/window/chat/Prose.tsx`:
  - `Prose` renders `QuirkyMarkdown` with the untrusted profile.
  - `renderUserMarkdown` stays on the existing unified pipeline, since user bubbles are out of scope.
  - `renderMarkdown` stays exported for `transcript-markdown.test.ts`, or that test moves to the new renderer.
- `plugins/quirky.session/src/window/chat/Turn.tsx:65`: pass `session` to `Prose`.
- `plugins/quirky.session/src/window/chat/ChatView.tsx:141-244`: stick-to-bottom on resize, hold position when not following, and the Jump to latest pill.
- `plugins/quirky.session/main.ts:24-50`: register `markdownAssets`.
- `plugins/quirky.session/quirky-plugin.json` `contributes.method`: declare `markdownAssets` (`readOnly: true`).
- `plugins/quirky.view/src/render/Markdown.tsx` and `src/markdown.ts`: render through `QuirkyMarkdown`, untrusted profile, no assets.
- `plugins/quirky.editor/src/markdown/MarkdownSurface.tsx`: `MarkdownPreview` renders through `QuirkyMarkdown` with the file profile. Its existing `a` and `img` overrides become `components`, and its `MermaidDiagram` becomes a `renderers` entry for `mermaid`. `MARKDOWN_PREVIEW_REHYPE_PLUGINS` is passed as `rehypePlugins` and `remarkPreviewSearchMatch` as `remarkPlugins`. It stops passing `remarkMath`, because the file profile adds it.
- `scripts/ui-review/capture.ts:1836-1851`: seed the structured-session capture with the showcase transcript.

## Contracts & interfaces

**`QuirkyMarkdown`** ([logic: Conceptual model](logic.md#conceptual-model), [What renders](logic.md#what-renders)).

CONTRACT:
```
type MarkdownProfile = 'untrusted' | 'file'
interface MarkdownAssets {
  resolveFiles(candidates: string[]): Promise<Record<string, { line?: number } | null>>   // null = does not exist
  resolveImages(srcs: string[]): Promise<Record<string, string | null>>               // src as written -> displayable url
  openFile(path: string, line?: number): void
}
interface QuirkyMarkdownProps {
  text: string
  profile: MarkdownProfile
  streaming?: boolean                    // default false
  onOpenLink(href: string): void         // caller confirms, then opens
  assets?: MarkdownAssets                // absent: no chips, local images render as their alt text
  remarkPlugins?: PluggableList          // appended after the built-in ones
  rehypePlugins?: PluggableList          // 'file' profile: required, and must sanitize
  components?: Partial<Components>       // caller overrides win, e.g. the editor's img and heading ids
  renderers?: CustomRenderer[]           // caller fence renderers win over built-ins, e.g. the editor's MermaidDiagram
  className?: string
}
function QuirkyMarkdown(props: QuirkyMarkdownProps): JSX.Element
```

Postconditions and invariants:

- **Root.** The root element has class `qmd` and `data-profile={profile}`. Streamdown's `prefix` also prefixes a caller's `className`, so a caller `className` goes on an outer wrapper `div`, not through Streamdown.
- **Streamdown setup.**
  - Props: `mode: streaming ? 'streaming' : 'static'`, `isAnimating: streaming`, `parseIncompleteMarkdown: true`, `prefix: 'sd'`.
  - `animated` is off and `linkSafety` is `{ enabled: false }`.
  - Controls: `code: { copy: true, download: false }`, with table, mermaid and image controls off.
  - Line numbers are handled by our CodeBlock.
- **Untrusted profile.**
  - Remark: `remark-gfm` (footnotes, tables, tasks), `remark-breaks` (agent hard breaks must survive, per `transcript-markdown.test.ts:31-35`), `remark-mark`, `remark-gemoji`, `remark-html-allowlist`, `remark-path-candidates` (only with `assets`), then Streamdown's `plugins.math` remark step, which Streamdown appends after `remarkPlugins`.
  - Rehype: `rehype-raw`, then `rehype-sanitize` with a schema allowing only the logic spec's tags plus the hast that our plugins emit. That means `code[data-path-candidate]`, `code.className` of `language-*`, `math-inline` or `math-display`, footnote ids with the default `user-content-` clobber prefix, and task-list `input[type=checkbox][disabled][checked]`.
  - KaTeX runs after sanitize, because Streamdown appends `plugins.math.rehypePlugin` after the caller's `rehypePlugins`. Its options are `trust: false` and `throwOnError: false`.
  - A caller's `rehypePlugins` in this profile is rejected with a thrown `Error('untrusted profile takes no rehypePlugins')`.
- **File profile.**
  - The caller's `rehypePlugins` replace the raw and sanitize step. The renderer throws `Error('file profile requires rehypePlugins')` when none are given.
  - `remark-html-allowlist` and `remark-path-candidates` are not applied, and `assets` is ignored.
  - Streamdown's `plugins.math` is not set. The renderer adds `remark-math` to the remark chain itself, because the editor's `MARKDOWN_PREVIEW_REHYPE_PLUGINS` already ends with `rehypeKatex`, and running KaTeX twice must be avoided.
- **Dollars.** `remarkLooseDollars` is the first remark plugin in both profiles (see Math). Text is never rewritten before parsing, so positions stay exact. remark-math emits the `math-inline` and `math-display` code nodes, and both class names are allowed by the untrusted schema and by the editor's schema.
- **Open fences.** Remend's open-fence handling is unverified. The renderer must make an open fence render as a code block with its header (SC-1). The test proves this, and if remend doesn't do it, close the fence in the pre-pass while `streaming`.
- **Links.**
  - The `a` component renders only `http:` and `https:` hrefs as links. Every other scheme renders the link text as plain text.
  - A click (and an auxclick) calls `preventDefault()` and then `onOpenLink(href)`.
  - No `target` attribute is set, and Streamdown's link modal never renders.
- **Images.**
  - The `img` component never puts a remote URL in `src`.
  - An `http(s):` or protocol-relative `src` renders `RemoteImageChip`: a button with the URL, whose click calls `onOpenLink`.
  - A relative or worktree `src` is resolved through `assets.resolveImages`. While it's pending or null, the alt text renders. Once resolved, it renders `<figure>` holding the `<img>` and a `<figcaption>` with the `src` as written (SC-7a).
- **Path chips.**
  - Candidates are inline code whose whole content matches `PATH_CANDIDATE`, plus text tokens that `remark-path-candidates` split out. Fenced code and link text are never candidates.
  - The renderer batches every candidate in the message into one `resolveFiles` call and caches results per `assets` instance.
  - A resolved candidate renders `PathChip`. An unresolved one renders exactly as it would without chips.
  - Clicking a chip calls `assets.openFile(path, line)`.
- **Caret.** While `streaming`, the renderer appends a `<span aria-hidden="true" class="qmd-caret">▍</span>`. It goes inside the open code block when the last block is an incomplete fence, and after the last block otherwise. `chat-view.test.ts` reads the `▍` glyph from `textContent`.
- **Stable props.** The `remarkPlugins`, `rehypePlugins`, `components`, `plugins` and `controls` values passed to Streamdown are referentially stable across `text` and `streaming` changes. Build them once per `profile` / `assets` / caller-prop identity with `useMemo`, because Streamdown's per-block memo compares them by reference.
- **Memoization.** Finished blocks don't re-render while `text` grows. This relies on Streamdown's block memoization, with `parseMarkdownIntoBlocksFn` left at its default. A test asserts that a finished block's DOM node identity survives a text append.

**`CodeBlock`** ([What renders: Code](logic.md#what-renders), SC-2, SC-11, SC-12). It is registered as the `code` block component, or wraps Streamdown's `CodeBlock`. The implementer chooses, but must meet these:

- **Header.** It shows the fence language, or a `title=` meta value when present (```` ```ts title=Prose.tsx ````), plus a Copy button.
- **Copy.** It writes the raw code without line numbers and shows "Copied" for about 1.2 s.
- **Line numbers** render only when the block has more than 8 lines.
- **Collapse.**
  - A finished block with more than 20 lines renders collapsed: about 20 lines visible, a fade, and a button reading `Show all <N> lines`. When expanded, the button reads `Show less`.
  - An incomplete (streaming) block is never collapsed.
- **Highlighting.**
  - While the fence is incomplete (`useIsCodeFenceIncomplete()` or the `isIncomplete` prop), the code renders as plain text with no Shiki call.
  - On completion, highlighted tokens replace the plain text with the same line box, so the block doesn't change height.
  - Unknown languages keep the header and Copy, with no colour.
- **Diff fences.** `diff` fences render each line with `data-diff="add" | "del" | "ctx"`, from its leading character, and are styled by `--ui-diff-*`.
- **Shiki theme.** `createCodePlugin({ themes: [cssVarsTheme, cssVarsTheme] })`, where `cssVarsTheme` is Shiki's `createCssVariablesTheme({ name: 'quirky', variablePrefix: '--shiki-' })`. `markdown.css` maps each `--shiki-token-*` to a `--ui-syntax-*` token. Themes switch through CSS alone.

**`MermaidBlock`** (SC-4). It is a `CustomRenderer` for `mermaid`.

- **While incomplete,** it renders the source as plain code.
- **When complete,** it lazy-imports `mermaid`, initialises it with `{ startOnLoad: false, securityLevel: 'strict', theme: 'base', themeVariables }` taken from computed `--ui-*` values, renders, and sanitises the SVG with DOMPurify `USE_PROFILES: { svg: true, svgFilters: true }`. The header holds a `Source`/`Diagram` toggle and Copy.
- **On error,** it renders `RenderError` with the text `Couldn't draw this diagram: <mermaid message>. Showing the source.` and the source below it.

**Data fences** ([What renders: Visuals](logic.md#what-renders), SC-13). These are `CustomRenderer`s for `csv`, `tsv`, `json` and `chart`. While a fence is incomplete it renders as plain code.

- **`csv`/`tsv`:** RFC-4180 quoting, with the first row as the header. The result renders as the same zebra table markup as GFM tables.
- **`json`:** `JSON.parse`. The top level renders open and nested objects and arrays are folded with `<details>`. Folded summaries read `{ N keys }` and `[ N items ]`.
- **`chart`:** parsed by `parseChartSpec`. It draws SVG bars or a line using only `--ui-*` colours, with a `Source` toggle.
- **On a parse failure,** the block renders as an ordinary code block with a `RenderError` above it, reading `Couldn't read this <lang> block: <message>`.

**Math** (SC-10). `remarkLooseDollars` runs first in both profiles, never inserts or removes characters, and so keeps every mdast position mapped to the original source. The editor's search-match plugin depends on that. It works on parsed code boundaries, so code at any nesting is untouched. It does three things:

- Rewrites `\(x\)` to ` $x$ ` and `\[x\]` to `$$x$$`. Both rewrites keep the same length.
- Leaves `$$…$$` unchanged.
- Treats a single `$…$` pair as math only when there's no whitespace right after the opening `$`, no whitespace right before the closing `$`, and no digit right after the closing `$`. It masks every other single `$` with a same-length placeholder, re-parses, and then restores the `$` as literal text.

`createMathPlugin({ singleDollarTextMath: true, errorColor })` then parses what's left. A KaTeX error renders `RenderError` with `Couldn't typeset: <katex message>` and the source.

**Alerts** ([What renders: Callouts](logic.md#what-renders)). The `blockquote` component (`blocks/Alert.tsx`) matches a blockquote whose first paragraph starts with `[!NOTE]`, `[!TIP]`, `[!IMPORTANT]`, `[!WARNING]` or `[!CAUTION]` (case-insensitive). It hides the marker and renders `div[data-alert=<lower-case type>][role=note]` with a leading label element (icon plus capitalised type). Every other blockquote renders as a plain blockquote. A nested marker is not an alert. Detection happens on the rendered React children, never in hast, so no sanitize schema needs `data-alert`.

**`quirky.session/markdownAssets`** (SC-6, SC-7).

CONTRACT:
```
params: { session: string; files?: string[]; images?: string[] }      // each list <= 200 entries, each entry <= 1024 chars
result: { files: Record<string, { path: string; line?: number } | null>;
          images: Record<string, string | null> }                       // url from context.createFileResource
errors: 'invalid-params' (bad shapes, limits) | 'not-found' (unknown session)
```

- **Root.**
  - Candidates resolve against the session's `cwd` (`Session.cwd`, `packages/protocol/src/model.ts:277-283`).
  - Containment is bounded by the session's worktree root, taken from `quirky.worktree/resolve` with `id:<worktreeId>`, and `path` in the result is worktree-relative, so it works with `quirky.editor/open`.
  - A floating session (no worktree) answers `null` for files, and its images are bounded by `cwd`.
- **Files.**
  - It strips a trailing `:<line>` or `:<line>:<col>` into `line`.
  - It rejects absolute paths that are outside the root, and any `..` that escapes it after `realpath`.
  - It returns `null` for anything that isn't a regular file.
  - `path` in the result is root-relative.
- **Images.**
  - Same containment rules, and the MIME type must be `image/png`, `image/jpeg`, `image/gif`, `image/webp` or `image/svg+xml`.
  - It creates `createFileResource({ path, contentType, disposition: 'inline' })` and reuses one resource per canonical path and mtime for the life of the daemon process.
- **Read-only.** It never throws for a missing file.

**Chat wiring** (`Prose.tsx`, [logic: Conceptual model](logic.md#conceptual-model), SC-5, SC-6).

- `assets.resolveFiles` and `assets.resolveImages` call `context.call('quirky.session/markdownAssets', …)`.
- `assets.openFile` calls `context.call('quirky.editor/open', { worktree: session.worktreeId, path, line, focus: true })`, as at `plugins/quirky.terminal/src/window/pane/TerminalPaneView.tsx:403-436`. A failure toasts `Could not open file in editor`.
- `onOpenLink` keeps the existing confirm and `quirky.terminal/openExternal` flow (`Prose.tsx:121-126`).

**Scrolling** (`ChatView.tsx`, [logic: Behaviour & scenarios](logic.md#behaviour--scenarios) SC-3).

- A `ResizeObserver` on the transcript column re-applies `scrollTop = scrollHeight` while `following.current` is true. Today this only happens in the `[turns]` effect at :210-213.
- **Not following.** Before each observed resize, record the topmost visible turn element's offset from the scroller top. After the resize, adjust `scrollTop` so that offset is unchanged, because WKWebView has no `overflow-anchor`.
- **Pill.** While `following.current` is false, render a button `Jump to latest` pinned to the bottom of the scroller. A click scrolls to the bottom smoothly and sets following. It hides once `atBottom` is true again. It is labelled for `byLabel('Jump to latest')`.

## Data models / schemas

SCHEMA: `chart` fence body, parsed by `parseChartSpec(source: string): ChartSpec | { error: string }` in `packages/ui/src/markdown/blocks/DataBlocks.tsx`

```
{ "type": "bar" | "line",
  "title"?: string, "unit"?: string,
  "data"?: [{ "label": string, "value": number }]   // bar
         | [{ "x": number | string, "y": number }], // line
  "from"?: string,                 // name of a csv/tsv fence in the same message, given as ```csv title=<name>
  "x"?: string, "y"?: string }     // column names, required with "from"
```

- Exactly one of `data` and `from` must be present.
- Bar values must be zero or more. A negative value is a parse error: `bar values must be zero or more`.
- A `from` that names no fence in the message is a parse error: `no csv block named <name>`.
- `QuirkyMarkdown` pre-scans `text` for csv and tsv fences with a `title=` meta value and provides them to the chart renderer through React context.

REGEX: `PATH_CANDIDATE` (exported from `packages/ui/src/markdown/index.ts`). A relative path with at least one `/` and a file extension, optionally followed by `:line` or `:line:col`, not part of a URL or an email:

```
/(?<![\w@/.:-])((?:\.{1,2}\/)?[\w.-]+(?:\/[\w.-]+)+\.[A-Za-z0-9]{1,8})(?::(\d+)(?::(\d+))?)?(?![\w/])/g
```

CONFIG: new tokens, in both `tokens.css` theme blocks. Values come from the signed-off mock (`mock/mock.html`, `.qk` and `.qk.light`), then are tuned until `markdown-tokens-contrast.test.ts` passes.

```
--ui-syntax-keyword --ui-syntax-function --ui-syntax-string --ui-syntax-number
--ui-syntax-comment --ui-syntax-type --ui-syntax-constant --ui-syntax-punctuation
--ui-code-bg --ui-code-header-bg
--ui-diff-add-bg --ui-diff-add-text --ui-diff-del-bg --ui-diff-del-text
--ui-alert-note --ui-alert-tip --ui-alert-important --ui-alert-warning --ui-alert-caution
--ui-heading-accent --ui-inline-code-bg --ui-inline-code-text --ui-table-zebra --ui-mark-bg
```

The alert tokens alias hue tokens, never status tokens, because the logic spec keeps status colours for status:

- note: `var(--ui-accent)`
- tip: `var(--ui-hue-mint)`
- important: `var(--ui-hue-violet)`
- warning: `var(--ui-hue-sand)`
- caution: `var(--ui-hue-coral)`

The showcase transcript lives at `packages/ui/test/fixtures/markdown-showcase.md`. It is the mock's *Chat transcript, default* reply written as markdown, with every block in [What renders](logic.md#what-renders). It is shared by the renderer tests and the ui-review capture.

## DO-NOT-CHANGE fences

- `renderUserMarkdown` in `Prose.tsx` and its mention handling (`Prose.tsx:51-68`, `:107`). User bubbles are out of scope ([logic: Scope](logic.md#scope--non-goals)).
- `plugins/quirky.editor/src/markdown/preview.tsx` (`renderSafeMarkdownHtml`) and its callers (`service.ts`, `detachedPreview.ts`). This is the server-side HTML string path, used for detached previews and the reader. Streamdown is a client component, and moving this path would change the detached-preview security contract.
- `plugins/quirky.editor/src/markdown/previewPipeline.ts`. Its exports are reused as the file profile's `rehypePlugins` unchanged. `notebook-mermaid-scoreboard.test.ts:16-23` owns this file, as well as `MermaidDiagram.tsx`.
- `plugins/quirky.view/src/core/catalog.ts:331-337` (`checkMarkdown`). View specs keep refusing images and non-http(s) links at validation.
- The tool-call cards in `plugins/quirky.session/src/window/chat/cards/*` and `MessageRow.tsx` (logic non-goals).
- `ui-lint` rules (`scripts/ui-lint.ts`). New CSS and TSX must pass them as written. Never add an exemption.

## Always / Ask / Never

Back-link: [logic: Key decisions](logic.md#key-decisions).

**Always**
- Use `var(--ui-*)` for every colour, size and radius. Raw colours go only in `tokens.css`.
- Sanitize before KaTeX and Shiki output exists.
- Keep `maskLooseDollars` and `PATH_CANDIDATE` pure and unit-tested.
- Run each test file in its own `bun test <file>` process.

**Ask (surface to the orchestrator as NEEDS_CONTEXT)**
- When Streamdown cannot honour a contract here without patching it, for example memoization or an unreachable component hook.
- When a scope file outside your task needs editing.

**Never**
- Import Tailwind or `streamdown/styles.css`.
- Let a remote URL reach an `img` `src` in either profile, or let raw HTML attributes through in the untrusted profile.
- Use status tokens (`--ui-working`, `--ui-needs-you`, `--ui-failing`) in markdown styling.
- Commit. The orchestrator commits.

## Cross-cutting

Back-link: [logic: Key decisions](logic.md#key-decisions).

- **Security.** The threat is prompt-injected agent text: markup, tracking images and `javascript:` links. SC-5, SC-7 and SC-8 are the acceptance bar, alongside the existing assertions at `chat-view.test.ts:~455-495` and `plugins/quirky.view/test/render.test.ts:377-389`.
- **Bundle.** Shiki languages, Mermaid and KaTeX load lazily. `packages/ui/build.ts` splits plugin bundles, so a dynamic `import()` becomes its own chunk. KaTeX CSS is already global (`packages/ui/src/index.html:8-10`).
- **No CSP** applies to the main window (`packages/ui/src/index.html`), so KaTeX fonts and Mermaid inline SVG styles load.
- **Rollback** is a revert of the merge. No data migration is involved.

## Testing strategy

Back-link: [logic: Key decisions, Done when](logic.md#key-decisions) and [logic: Screens](logic.md#screens).

| Test file | What it must cover |
|---|---|
| `packages/ui/test/markdown-renderer.test.tsx` (happy-dom) | Every block in the showcase fixture renders, as expected element and data-attribute assertions; SC-1 partial bold and open fence; SC-2 no Shiki output while incomplete; SC-5 link click calls `onOpenLink`; SC-7 remote image is a chip and no `img[src^=http]`; SC-8 raw `<img>` shown as text and `<details>` kept with no attributes; SC-11 copy text has no numbers; SC-12 collapse label; SC-13 data fences and the parse-error note; SC-4 error notes for bad Mermaid and math (Mermaid mocked); memoized block identity survives an append; caret placement |
| `packages/ui/test/markdown-dollars.test.ts` | Positions preserved; SC-10 table: `$5 and $10`, `` `echo $HOME` ``, `$O(n)$`, `$$…$$`, `\(…\)`, dollars inside fences |
| `packages/ui/test/markdown-tokens-contrast.test.ts` | Parses both theme blocks of `tokens.css`. Every `--ui-syntax-*`, `--ui-diff-*-text`, alert and heading token passes 4.5:1 against `--ui-code-bg`, its diff background or `--ui-surface`, as the token is actually used (SC-14) |
| `plugins/quirky.session/test/markdown-assets.test.ts` | Containment (absolute, `..`, symlink escape), the line suffix, the null for a missing file, the MIME filter, the limits |
| `plugins/quirky.session/test/chat-view.test.ts` (update) | Existing link-confirm, unsafe-link and caret tests stay green. Add: path chip opens the editor at the line; Jump to latest appears when scrolled up and returns to bottom |
| `plugins/quirky.session/test/transcript-markdown.test.ts` | Stays green: user markdown untouched, agent hard breaks kept |
| `plugins/quirky.view/test/render.test.ts` | The `markdown` describe (:363-480) stays green, link dialog included. Add: a GitHub alert and a code block render in a view |
| `plugins/quirky.editor/test/notebook-mermaid-states.test.tsx`, `markdown-reader.test.ts`, `detached-preview.test.ts` | Stay green. Add an editor preview test that raw `<p align="center">` survives cleaning in the file profile (SC-9) |

The acceptance bar is that every listed file passes alone, along with `bunx tsc --noEmit -p tsconfig.json`, `bun run ui:lint` and `bun run ui:scoreboard:check`. The full suite runs on the PR with the `full-suite` label.

## Non-goals

- The editor's server-side HTML preview (`renderSafeMarkdownHtml`, detached previews, printing). Only the interactive `MarkdownPreview` moves.
- The mobile web shell (`apps/mobile`). It doesn't import `@quirky/ui/markdown`.
- The view `code`, `file-diff` and `callout` nodes keep their components.
- A Streamdown fork or patch.
