# Vibrant markdown in quirky chat

## Status & amendments

**Status:** Draft

**Amendments:** none yet.

## Conceptual model

Agent replies in the native chat should be easier to scan and nicer to read: colour where it means something, real code blocks, callouts, diagrams, math and data drawn as visuals. Today agent prose runs through a small renderer that draws plain `<pre>` code, flat headings and a grey blockquote, and drops task lists, images, alerts, math and Mermaid.

One **shared markdown renderer** replaces the three that exist today: chat prose, the quirky.view markdown node and the editor's markdown preview. It is built on Streamdown and draws every block with quirky's own `--ui-*` tokens, so a reply looks the same wherever it appears.

Each caller picks a **trust profile**:

- **Untrusted** (chat prose, agent-drawn views). Markdown only. Raw HTML shows as text, except `details`, `summary`, `kbd`, `sub`, `sup`, `mark` and `br`, which are kept with no attributes. Links go through quirky's Open link prompt. Images render only from inside the worktree, and anything remote becomes a link chip. File paths that exist in the worktree become chips that open the file.
- **Your file** (editor preview). Everything in Untrusted, plus the file's own raw HTML after cleaning, and relative images from the file's folder.

The renderer knows nothing about chat. A caller hands it the text, a trust profile, a worktree root (for path chips and images) and whether the text is still streaming.

User message bubbles are not part of this and stay as they are.

## What renders

- **Text.** A three-step heading scale: h1 and h2 in an accent tint, h3 at body size and weight, h4 to h6 as small muted labels. Inline code gets a tint, and existing file paths render as chips. Also footnotes, `kbd` key caps, `==highlight==`, sub and superscript, and `:emoji:` shortcodes.
- **Code.**
  - A slim header shows the language, or the filename when the fence names one, plus a Copy button.
  - Syntax colour comes from new `--ui-syntax-*` tokens built on the hue palette.
  - Line numbers appear once a block passes about 8 lines and are never copied.
  - Blocks collapse past about 20 lines behind a Show all bar.
  - `diff` fences tint added and removed lines using new `--ui-diff-*` tokens.
- **Callouts.** The five GitHub alerts (NOTE, TIP, IMPORTANT, WARNING, CAUTION), each drawn as a left bar, soft tint and icon label in its own hue.
- **Structure.** Read-only task lists. Tables have a tinted header and faint zebra rows, and scroll sideways when wide. Collapsible `details` sections.
- **Visuals.**
  - Mermaid diagrams, with a Source toggle.
  - Math.
  - `csv` and `tsv` fences as tables.
  - `json` fences as a foldable tree.
  - `chart` fences as bar or line charts.

## Data flow

The text a caller passes in goes through the renderer in this order:

1. While streaming, the open tail is repaired so half-written syntax reads as closed.
2. The text is split into blocks. Finished blocks keep their rendered output and only the open block is redrawn.
3. The trust profile's cleaning runs before any rich block is drawn, so diagrams, math and highlighted code are produced from already-cleaned input.
4. Each block is drawn with quirky's components and tokens.

Code colour, diagrams and math are drawn once their block is finished.

## Key decisions

- **Streamdown, held to quirky's rules.** The user chose Streamdown over growing our own unified pipeline or standardising on react-markdown. Its defaults are looser than quirky allows, so the following are requirements, not tuning:
  - Raw HTML is off in the Untrusted profile, apart from the allowed tags.
  - Quirky's Open link prompt replaces Streamdown's link modal.
  - Image and link origins are locked down, so a reply can't leak data by loading a remote image.
  - Nothing visible comes from Streamdown's Tailwind defaults. Every colour, size and radius comes from `--ui-*` tokens.
- **Colour carries meaning.** At this balanced intensity, hues mark syntax, alert type, diff direction and pass/fail. The status colours `--ui-working`, `--ui-needs-you` and `--ui-failing` are never used for decoration, so they keep meaning "look here".
- **Syntax colours belong to quirky.** They are derived from the `--ui-hue-*` palette in both themes, not taken from a stock theme, and there is no theme picker.
- **Dollar signs are strict.** `$$...$$` and `\(...\)` are always math. A single `$...$` pair is math only when there's no space just inside either dollar and no digit right after the closing one. Nothing inside code is ever math.
- **Light theme is first class.** Every new colour has a light value that passes WCAG 4.5:1 against the background it actually sits on.
- **Done when** all three of these hold:
  - A seeded showcase transcript that uses every block shows no regressions on `ui:scoreboard` in dark and light.
  - A recorded streaming run shows no jumps and no flashes of raw syntax.
  - The PR carries before and after captures.

## Behaviour & scenarios

1. **SC-1 Streaming text repairs itself**
   - **Given** an agent reply is streaming
   - **When** the text so far ends inside unfinished syntax
   - **Then** it renders as if the syntax were closed: unfinished bold shows bold, an open code fence is already a code block with its header, and a half-written link shows as plain text until its address arrives. No raw asterisks or backticks ever flash.
   - **Screen states:**

     | Text so far ends with | Shown |
     |---|---|
     | `**the root cau` | ✓ "the root cau" in bold |
     | an open ts fence with 3 lines | ✓ code block, header "ts", 3 plain lines, caret on line 3 |
     | `[original chat PR](https://gith` | ✓ "original chat PR" as plain text; ✗ not yet a link |

2. **SC-2 An open code block stays plain until it closes**
   - **Given** a code block is still streaming
   - **When** its closing fence arrives
   - **Then** colour fades in over the existing text. The block doesn't change size or move, and blocks above it don't redraw. Line numbers appear once it passes about 8 lines. A streaming block is never collapsed, even past 20 lines. It collapses when it finishes, if it's long enough.

3. **SC-3 Scrolling up while a reply streams**
   - **Given** a reply is streaming and the user has scrolled up from the bottom
   - **When** new text arrives, or a block above gains colour, expands or collapses
   - **Then** the user's reading position stays put and a Jump to latest pill appears. Clicking the pill, or scrolling back to the bottom, resumes following new text.
   - **Screen states:**

     | Where the user is | View | Pill |
     |---|---|---|
     | (a) at the bottom | ✓ follows new text | ✗ hidden |
     | (b) scrolled up | ✓ holds position | ✓ "Jump to latest" |

4. **SC-4 A rich block fails to render**
   - **Given** a finished reply holds a Mermaid diagram or math with a syntax error
   - **When** it renders
   - **Then** that block shows a short red-dashed note naming the problem, with the source underneath, and the rest of the message renders normally. While the block is still streaming, failures are silent and it shows as source.
   - **Screen states:**

     | Block | Shown |
     |---|---|
     | Mermaid with `-->>` on line 2 | ✓ "Couldn't draw this diagram: line 2, unexpected "-->>". Showing the source." plus source |
     | Math `\sume_{i=1}^n` | ✓ "Couldn't typeset: undefined control sequence \sume" plus source |
     | Fence language "zig-ish" | ✓ header "zig-ish" and Copy, no colour |

5. **SC-5 Clicking a link**
   - **Given** a reply contains an http or https link
   - **When** the user clicks it
   - **Then** quirky's Open link prompt shows the full address, and the link opens in the browser only after the user confirms. Other address schemes render as plain text.

6. **SC-6 File paths become chips**
   - **Given** a reply mentions `chat/turns.ts:119` in prose or inline code
   - **When** it renders
   - **Then** (a) if the file exists in the worktree, it shows as a chip with a file icon that opens the file at line 119 in the editor; (b) if it doesn't exist, it stays as inline code. Paths inside fenced code blocks are never chips.

7. **SC-7 Images**
   - **Given** a reply contains markdown images
   - **When** it renders
   - **Then** (a) an image inside the worktree shows inline with its path as a caption; (b) a remote image never loads and shows as a link chip that opens through the Open link prompt.

8. **SC-8 Raw HTML in an agent reply**
   - **Given** an agent reply or an agent-drawn view contains `<img src="https://x.io/p.gif">` and `<details><summary>Why</summary>…</details>`
   - **When** it renders
   - **Then** the `img` tag shows as literal text and nothing is fetched, and the `details` block becomes a working disclosure with its attributes removed.

9. **SC-9 Raw HTML in a file you opened**
   - **Given** a README in the editor preview contains `<p align="center"><img src="docs/logo.svg" width="80"></p>`
   - **When** the preview renders
   - **Then** the centred logo shows, after cleaning removes anything scripted. Everything else looks the same as in chat.

10. **SC-10 Dollar signs**
    - **Given** a reply says "costs $5 and $10", "run `echo $HOME`", "complexity $O(n)$" and contains a `$$T = \sum c_i$$` block
    - **When** it renders
    - **Then** "$5 and $10" and `$HOME` stay text; ✓ "O(n)" renders as inline math; ✓ the `$$` block renders as display math.

11. **SC-11 Copying code**
    - **Given** a 10-line code block with line numbers
    - **When** the user clicks Copy
    - **Then** the clipboard holds the 10 lines without numbers and the button briefly reads "Copied".

12. **SC-12 Long code block**
    - **Given** a finished 23-line code block
    - **When** it renders
    - **Then** it shows about the first 20 lines with a fade and a "Show all 23 lines" bar. Clicking the bar expands the block, and the bar then reads "Show less".

13. **SC-13 Data fences**
    - **Given** a reply contains a `csv` fence, a `json` fence and a `chart` fence that refers to the csv data
    - **When** it renders
    - **Then** the csv shows as a zebra table, the json as a tree with the top level open and nested objects folded, and the chart as a bar or line chart with a Source toggle. A data fence that fails to parse shows as an ordinary code block with a note naming the problem.
    - **Details:** what a `chart` fence holds (chart type, which columns, where the data comes from) is a technical decision left to the tech spec.

14. **SC-14 Light theme**
    - **Given** the app is in light theme
    - **When** any reply renders
    - **Then** every block uses its light-theme colours, and all text, syntax and diff colours pass 4.5:1 against their actual background.

## Screens

The signed-off mock is [mock/mock.html](mock/mock.html), with its inventory in [mock/screens.md](mock/screens.md). It's the visual target. The build recreates it in quirky's components and never lifts code from it.

- **Chat transcript, default:** matches the mock. All blocks render as shown, and the user bubble is unchanged.
- **Chat transcript, streaming:** matches the mock. The repaired bold and the open fence are shown plain, with the header and caret.
- **Chat transcript, scrolled up:** matches the mock. The position is held and the Jump to latest pill is visible.
- **Chat transcript, render error:** matches the mock. Diagram and math errors show a note with the source, and an unknown language gets a header with no colour.
- **Chat transcript, light:** matches the mock in light tokens and passes contrast.
- **Agent-drawn view, default:** matches the mock. It uses the same look as chat, and raw HTML is escaped.
- **Editor preview, default:** matches the mock. The file's raw HTML is rendered after cleaning.

Open questions from mock gaps, meaning mocked elements with no existing quirky component:

- Path chip, alerts, the diff fence, the collapsed long block and its Show all bar, the diagram source toggle, the collapsible section, the csv table, the json tree, the remote-image chip, the Jump to latest pill, and the diagram and math error notes all need new components. The tech spec decides which come from Streamdown overrides and which are quirky components.

## Scope & non-goals

**In scope:**

- Agent prose in the native chat, the quirky.view markdown node and the editor's markdown preview, all moved onto the one renderer.
- New `--ui-syntax-*` and `--ui-diff-*` tokens for both themes.
- The showcase fixture and its scoreboard entries.

**Not in scope:**

- User message bubbles. They're unchanged and keep their @mentions.
- Tool-call cards (`FileChange`, `Steps`, `TestResults`). They keep their current look and may adopt the diff tokens later.
- Editing from rendered output. Code blocks get no run, apply or edit buttons, and task-list boxes are read-only.
- Remote images loading inline, and a user-choosable syntax theme.
- The legacy `MessageRow` plain-text fallback.
- The mobile app.

## Decisions Locked

**Setup and scope**
- Gray areas: the standard set, without adhd.
- Agent prose only. User bubbles are unchanged.
- One renderer reaches chat, the quirky.view markdown node and the editor preview. The editor keeps its cleaned raw HTML.

**Colour and intensity**
- Balanced intensity: syntax colour, accent-tinted headings and links, coloured alerts, tinted inline code.
- Syntax palette: new `--ui-syntax-*` tokens derived from `--ui-hue-*`, tuned per theme.
- Inline code is tinted, and file paths that exist in the worktree become clickable chips.
- Headings use a size and weight scale, with h1 and h2 tinted and h4 to h6 as muted labels.

**Code blocks**
- A slim header bar shows the language or filename, plus Copy.
- Blocks collapse past about 20 lines behind Show all. A streaming block stays expanded.
- Line numbers show only for blocks over about 8 lines and are never copied.
- Diff fences get tinted added and removed lines from `--ui-diff-*` tokens.

**Streaming**
- Partial syntax renders as if closed.
- Code stays plain while its fence is open and gets colour when it closes.
- The view follows only when the user is at the bottom. Otherwise it holds position and shows a Jump to latest pill.
- The accent caret is the activity cue.

**Rich blocks**
- GitHub alerts, task lists, Mermaid and math all render. The user asked for very broad support.
- Footnotes, collapsible sections, inline extras (kbd, mark, sub and sup, emoji) and data fences (csv/tsv, json, chart) also render.
- Alerts use a left bar, soft tint and icon label, with one hue per type.
- Worktree images render inline, and remote images become link chips.
- Tables get a tinted header, faint zebra rows and sideways scrolling.
- Math follows the strict dollar rule.

**Approach, review and success**
- Approach: Vercel Streamdown, picked by the user over the recommended own-pipeline option, with quirky's security and styling rules as requirements.
- UX review: signed off as Looks right at mock v1. All three screens were visited and no pins were left.
- Done when the showcase fixture shows no scoreboard regressions in dark and light, the recorded streaming run shows no jumps, and the PR has before/after captures.

## Industry Insights

- **Streaming repair.** Streamdown's `remend` closes unfinished bold, italics, inline code, links and math before parsing ([Streamdown docs](https://streamdown.ai/docs/termination)). Sources disagree on whether it also closes open code fences ([Vercel changelog](https://vercel.com/changelog/new-npm-package-for-automatic-recovery-of-broken-streaming-markdown)), so check this in the build.
- **Block memoization** turns whole-message re-parsing into work on the open tail only. One project saw paragraph renders per delta fall from 465 to 30 ([t3code PR](https://github.com/pingdotgg/t3code/pull/27417)). Footnotes and late reference links invalidate block caches.
- **Highlight on close.** Highlighting only finished lines, or only closed fences, cut Shiki time sharply in streaming tests ([side-fleet PR](https://github.com/foodaka/side-fleet/pull/89)).
- **Scroll anchoring.** WKWebView, which Electrobun uses, has no native scroll anchoring, so reading position has to be saved and restored by hand ([suzent PR](https://github.com/cyzus/suzent/pull/631)). Rebuilding an open code block on each chunk made transcripts jump ([ClaudeCodeExtension PR](https://github.com/dliedke/ClaudeCodeExtension/pull/228)).
- **Streamdown risks:**
  - Tailwind is effectively required, and no no-Tailwind path is documented ([README](https://github.com/vercel/streamdown), [#543](https://github.com/vercel/streamdown/issues/543)).
  - Raw HTML is on by default, and harden allows every origin. An open issue describes image exfiltration through prompt injection ([security docs](https://streamdown.ai/docs/security), [#640](https://github.com/vercel/streamdown/issues/640)).
  - Custom `rehypePlugins` replace the default chain, so sanitize has to be re-added.
  - Changing plugins or allowed tags is ignored until the text changes ([#755](https://github.com/vercel/streamdown/issues/755)).
  - Its bundle is about twice react-markdown's, and it had a 1 s worst frame on a long stream in one benchmark ([LogRocket](https://blog.logrocket.com/react-markdown-alternatives-benchmarking-3-streaming-renderers/)).
- **Sanitize before KaTeX and Shiki,** or their output gets stripped ([rehype-katex README](https://github.com/remarkjs/remark-math/tree/main/packages/rehype-katex)).
- **Dollar ambiguity.** Single-dollar math misreads prices ([katie PR](https://github.com/mfackrell/katie/pull/762)). Streamdown leaves inline math off by default ([v2.5 changelog](https://vercel.com/changelog/streamdown-2-5)).
- **Contrast.** Dark-only palettes fell to 1.1–2.6:1 in light mode ([LibreChat-Mobile #561](https://github.com/garfiec/Librechat-Mobile/issues/561)). WCAG 1.4.3 requires 4.5:1.
- **Path chips** should appear only for files that exist, because shortened or guessed paths produced broken links ([ren #353](https://github.com/renai-labs/ren/issues/353), [t3code #30764](https://github.com/pingdotgg/t3code/pull/30764)).
- **Code-block chrome** in current tools: a header with filename, language and Copy, plus optional line numbers ([AI Elements CodeBlock](https://elements.ai-sdk.dev/components/code-block)). Diff lines use Shiki's `[!code ++]` / `[!code --]` notation ([Shiki transformers](https://shiki.style/packages/transformers)).

## Deferred Ideas

- `[tech-spec]` How Streamdown is styled without Tailwind: an `@source` build step, `data-streamdown` selector overrides, or full component overrides.
- `[tech-spec]` Where the shared renderer lives (a package under `packages/` or in `packages/ui`) and how the three callers migrate.
- `[tech-spec]` Whether the quirky.view `code`, `file-diff` and `callout` nodes reuse the new block components.
- `[tech-spec]` What a `chart` fence holds.
- `[tech-spec]` Bundle budget, and lazy-loading Shiki languages, Mermaid and KaTeX.
- The tool-call cards adopting the `--ui-diff-*` tokens.

## Glossary

- **Trust profile:** the rule set a caller picks. *Untrusted* is for chat and views, *your file* is for the editor preview.
- **Path chip:** an inline file path shown as a clickable chip, because the file exists in the worktree.
- **Rich block:** any block drawn as a visual instead of text, such as an alert, Mermaid diagram, math, data fence or collapsible section.
- **Data fence:** a `csv`, `tsv`, `json` or `chart` code fence drawn as a table, tree or chart.
- **Showcase transcript:** the seeded fixture conversation that uses every block, scored in dark and light.
