> 🧭 EXPLORATION — not a spec. No locked decisions; nothing here is build-ready.

# Exploring: agent-drawn UI in a Quirky chat for Claude Code, Codex, pi and omp

**Date**: 2026-11-16 · **Emphasis**: research-heavy · **Intensity**: 0.5 (Exploratory) · **Involvement**: medium, lowered to low after research

## Framing

This follows up `docs/quirk/explorations/2026-11-10-agent-chat-interface.md`. That doc asked which chat features are worth building over four backends. This one asks whether and how agents should draw UI in that chat, using libraries such as [OpenUI](https://github.com/thesysdev/openui) and [json-render](https://github.com/vercel-labs/json-render) as starting points.

Scope came from the scoping questions:

- **Depth:** standard, with five parallel facets and one gap round.
- **Comparables:** spec-to-UI renderers, wire protocols, and app frameworks. Coding-agent products were left out as comparables, though the gap round still checked what each backend passes through.
- **Uses that matter:** rich tool-result cards in the transcript, questions and approvals as interactive forms, and agent-built views next to the chat. The central brain chat was left out.

**Native chat is still out of scope for Quirky.** `BRIEF.md` excludes it and `docs/loop/BLOCKERS.md` lists the ruling as blocked. This doc feeds that ruling.

## What was explored

- **Facets:**
  1. OpenUI (thesysdev)
  2. json-render (vercel-labs), read at commit 5e99a38
  3. app frameworks: AI SDK, CopilotKit, assistant-ui, Tambo, LangGraph, A2UI, Hashbrown
  4. wire protocols: MCP Apps, MCP-UI, AG-UI, OpenAI Apps SDK, A2UI, ACP
  5. reception, failure modes and security
- **Gap round:** MCP Apps pass-through in each backend, prompt-only spec emission (`harness-chat`), Vercel's new UI SDK, MCP Apps hosting without a web origin, and A2UI's action envelope.
- **Directions generated:** 9.
- _Ran with lowered involvement:_ after scoping, the user asked to go straight from this exploration into a brainstorming session, so the idea-landscape checkpoint was skipped.

## Findings

### Theme: the field agrees the model may only name what the host registered

CopilotKit, assistant-ui, Tambo, OpenUI and json-render all register components with Zod or JSON Schema, and A2UI 1.0 states "Agents place only components you registered" ([a2ui.org](https://a2ui.org)). Sandboxed HTML (MCP Apps) is the fallback for views a catalog can't express ([MCP Apps spec](https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx)).

There are three patterns:

- **(a) Host maps tool calls to its own components.** AI SDK tool parts, CopilotKit `useFrontendTool`, assistant-ui toolkits, LangGraph pushed UI messages. These are the mature options ([AI SDK](https://ai-sdk.dev/docs/ai-sdk-ui/generative-user-interfaces), [CopilotKit](https://docs.copilotkit.ai/reference/hooks/useFrontendTool), [assistant-ui](https://www.assistant-ui.com/docs/tools/tool-ui)).
- **(b) Model emits a declarative spec rendered from a catalog.** OpenUI Lang, json-render, A2UI, Hashbrown. Newer, and the click-back path is the least documented part.
- **(c) Model or server ships HTML into a sandboxed iframe.** MCP Apps and the OpenAI Apps SDK built on it ([OpenAI](https://developers.openai.com/apps-sdk/mcp-apps-in-chatgpt)).

User replies are converging on tool-call semantics: `addToolOutput` in the AI SDK, `respond()` in CopilotKit, `addResult` in assistant-ui, `tools/call` in MCP Apps, and A2UI 1.0's `action` message.

### Theme: OpenUI and json-render are strong renderers with rough edges

| | OpenUI | json-render |
|---|---|---|
| Format | Line-based DSL; every partial program renders ([spec](https://github.com/thesysdev/openui/blob/main/spec/language.md)) | Flat `{root, elements}` JSON, streamed as RFC 6902 patch lines ([streaming](https://github.com/vercel-labs/json-render/blob/5e99a38/apps/web/content/docs/streaming.mdx)) |
| Catalog | `defineComponent` with Zod; `library.prompt()` builds the system prompt | `defineCatalog` with Zod; `catalog.prompt()` builds it |
| Click-back | `@ToAssistant(msg, context)` carries `formState` to the host ([actions](https://www.openui.com/docs/openui-lang/actions)) | `emit(name)` carries no payload ([#449](https://github.com/vercel-labs/json-render/issues/449)) |
| Guardrails | Bad output nulls a prop; "nothing a model writes may crash the client" | Validation is opt-in; props aren't checked for catalogs with more than one component ([#467](https://github.com/vercel-labs/json-render/issues/467)) |
| Hosted coupling | Rendering is local. Dashboard scripts run on `api.thesys.dev` ([execute.ts](https://github.com/thesysdev/openui/blob/main/packages/server/src/tools/execute.ts)). Telemetry fires on `postinstall` | None; core depends only on Zod |
| Health | MIT, 15.3k stars, UI packages 0.x, one npm maintainer | Apache-2.0, 19.7k stars, 0.x with a breaking 0.20, mostly one author |

OpenUI's own benchmark puts json-render at 82.8% structural validity against 96.9% for OpenUI and 95.6% for A2UI ([benchmarks](https://www.openui.com/benchmarks)). Thesys ran it, so weigh it accordingly. Its "67% fewer tokens" headline is the best single case; the aggregate is about 52% ([benchmarks README](https://github.com/thesysdev/openui/blob/main/benchmarks/README.md)).

### Theme: json-render already shows the coding-agent case

`examples/harness-chat` runs Claude Code, Codex or pi and renders their work with a catalog of `Steps`, `FileChange`, `Terminal`, `TestResults`, `Metric`, `CodeBlock` and `Callout` ([agent.ts](https://github.com/vercel-labs/json-render/blob/main/examples/harness-chat/lib/agent.ts)). Two things stand out:

- **Spec emission is prompt-only.** The agents get the catalog prompt and write a JSONL spec in a fenced block after a short summary. No custom tool is involved.
- **Tool calls are drawn by the host.** Any `tool-*` part becomes an activity line from a `TOOL_META` table, and the agent's spec renders as a report at its position in the message ([page.tsx](https://github.com/vercel-labs/json-render/blob/main/examples/harness-chat/app/page.tsx)).

So the example mixes pattern (a) for activity and pattern (b) for the summary report. Its harness packages are canary builds.

### Theme: protocols split into "HTML in a box" and "data from a catalog"

- **MCP Apps** is the only published cross-host standard for server-supplied HTML. It's stable since 2026-01-26 and rendered by Claude, ChatGPT, VS Code, Goose and Cursor ([launch](https://blog.modelcontextprotocol.io/posts/2026-01-26-mcp-apps/), [overview](https://modelcontextprotocol.io/extensions/apps/overview)). Views talk to the host over JSON-RPC postMessage (`tools/call`, `ui/message`, `ui/update-model-context`) and default to `connect-src 'none'`.
- **A2UI 1.0** shipped 2026-11-11 ([Google](https://developers.googleblog.com/a2ui-10-build-delightful-fast-reliable-agentic-experiences/)). It sends declarative surfaces (`createSurface`, `updateComponents`, `updateDataModel`) and gets back an `action` with resolved `context` and, optionally, the surface's data model ([spec](https://a2ui.org/specification/v1.0-a2ui/)). Its React catalog API is still undocumented.
- **AG-UI** is an event transport, not a renderer. It says it carries A2UI, MCP-UI and Open-JSON-UI ([AG-UI](https://docs.ag-ui.com/concepts/generative-ui-specs)).
- **ACP has no UI payload.** It has Markdown text and stable form elicitation limited to string, number, boolean and enum fields ([ACP](https://agentclientprotocol.com/protocol/content), [elicitation](https://agentclientprotocol.com/announcements/elicitation-stabilized)).

### Theme: the four backends pass through very different amounts

| Backend | MCP Apps link reaches the host? | Structured tool result | Native dialogs |
|---|---|---|---|
| Codex app-server | Yes: `mcpAppUi` on `mcpToolCall`, plus `mcpServer/resource/read` ([README](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md)) | Kept in full | Approvals |
| Claude Agent SDK | Unconfirmed. `tool_use_result.structuredContent` arrives, and Claude Code gives `ui://` tools an 8M-character cap, so it knows about them ([SDK](https://code.claude.com/docs/en/agent-sdk/typescript)) | Yes | `canUseTool`, `AskUserQuestion` |
| pi | Unverified; MCP via `registerMcpServer` | `result.details` | `select`, `confirm`, `input`, `editor`; `setWidget` is text lines only ([rpc.md](https://cdn.jsdelivr.net/npm/@earendil-works/pi-coding-agent@0.81.1/docs/rpc.md)) |
| omp | Unverified | Unverified | `ask` |

The only layer common to all four is the host's own tool-call stream.

### Theme: reception favours cards, doubts agent-built views

- **Cards and buttons get praise.** Claude's inline visuals and click-to-reply widgets drew big launch threads ([r/ClaudeAI](https://www.reddit.com/r/ClaudeAI/comments/1rruo4u/)). Coding-agent users ask for richer rendering inside the harness: "Just seems like something the harness should natively do" ([r/LocalLLaMA](https://www.reddit.com/r/LocalLLaMA/comments/1x0y4lv/)).
- **Streaming is the top failure.** Partial HTML flashes, layouts jump, scripts wait for the stream to end ([Livshits](https://michaellivs.com/blog/reverse-engineering-claude-generative-ui/)). One ChatGPT response re-sent 83% of 275 KB of patches ([OpenUI](https://www.openui.com/blog/how-chatgpt-intelligent-ui-works)).
- **The model can't see UI state.** It only gets the text of what a click sends back ([OpenUI](https://www.openui.com/blog/how-chatgpt-intelligent-ui-works)).
- **Consistency and debuggability worry developers.** "No guarantee that the ui generated for the user will be the same visit to visit" ([HN](https://news.ycombinator.com/item?id=49613182)).
- **No vendor has published usage numbers** for inline visuals or ChatGPT apps. Lab studies show strong preference for generated UI over text ([Nielsen on Google's study](https://jakobnielsenphd.substack.com/p/generative-ui-google)), but none is about coding agents.
- **Security bites in desktop hosts.** "A sandbox escape in a tab costs you that tab. A sandbox escape here is a full IDE compromise" ([Backslash](https://www.backslash.security/blog/new-mcp-spec-opens-new-attack-surfaces)). MCP Inspector had a self-navigation leak past `connect-src 'none'` ([#2872](https://github.com/modelcontextprotocol/inspector/issues/2872)). ChatGPT's HTML preview sandbox was escaped via popups ([THN](https://thehackernews.com/2026/11/researchers-bypass-chatgpt-lockdown.html)).

### Theme: where Quirky starts

- **`quirky ask` is already a pattern (b) renderer.** Agents send a JSON spec. `plugins/quirky.ask/src/core/spec.ts` validates it against six question types, and `AskCards.tsx` renders it. Option previews are markdown or HTML, sanitized to about 30 tags and shown in a `srcDoc` iframe with an empty `sandbox` and a strict CSP (`plugins/quirky.ask/src/PreviewFrame.tsx`, `packages/ui/src/design-system/read-only-preview.tsx`). Any backend can reach it, because it's a shell command.
- **The transcript is plain.** `plugins/quirky.session/src/window/MessageRow.tsx` shows tool output as raw text in a `<details>` block.
- **Review already has a home.** The git plugin's notes and note bridge (`plugins/quirky.git/src/daemon/notes.ts`, `note-bridge.ts`) send batched line comments back to agents.
- **Vercel's UI SDK isn't relevant here.** [vercel-labs/ui](https://github.com/vercel-labs/ui) is a behaviours library for agents that build UIs, not a session renderer.

## Idea landscape

No winner is declared. Each direction carries why it might work.

### Direction 1: host-drawn cards from the tool stream

Quirky maps known tool calls to its own components with no model involvement: edits to a file-change card, shell commands to a terminal card, test runs to a results card, todo and plan tools to a steps card.
**Why it might work:** every backend already emits typed tool events, this is the use with the strongest support, and it costs no tokens and adds no attack surface. `harness-chat` does this for activity lines.

### Direction 2: grow `quirky ask` into Quirky's UI spec

Extend the existing validated spec with read-only blocks (tables, key-value lists, status, code, diff) and render asks inline in the transcript as well as in the Questions panel.
**Why it might work:** Quirky already owns a schema-validated, sandboxed, backend-neutral spec channel. It's the same shape as json-render, minus a dependency.

### Direction 3: fenced spec reports at the end of a turn

The agent ends a turn with a short summary plus a fenced spec, as in json-render's inline mode, and Quirky renders it as a report card.
**Why it might work:** `harness-chat` shows prompt-only fences work across Claude Code, Codex and pi without tool support.

### Direction 4: persistent views with stable ids

An agent opens a named view beside the chat (`quirky view` or an in-process tool) and updates it in place by id, the way A2UI surfaces work.
**Why it might work:** updating by id avoids the re-send waste seen in ChatGPT, and a stable surface answers the "different every visit" complaint.

### Direction 5: MCP Apps as the escape hatch

Render third-party `ui://` views in a sandboxed frame served from a second Bun origin, starting with Codex, which already exposes `mcpAppUi`.
**Why it might work:** it's the ecosystem standard, and five major hosts render it already. Quirky's preview frame is a starting point.

### Direction 6: A2UI's `action` as the click-back format

Whatever renders the UI, a click goes back as `{name, surfaceId, sourceComponentId, context, dataModel?}`, turned into a follow-up message or a tool result per backend.
**Why it might work:** click-back is the least specified part of the field, and A2UI's envelope is the one written down. Sending the data model answers "the model can't see UI state".

### Direction 7: views as files in the worktree

Agent-built views are saved as spec files in the worktree, so they're diffable, versioned in git, and re-renderable after the session ends or by another backend.
**Why it might work:** it ties to "git is the universal diff" and "Quirky owns the history" from the 11-10 doc, and it answers "how do I debug what rendered".

### Direction 8: cards that feed the review loop

A file-change card takes line comments that go into the existing batched notes, and a test card offers "re-run failing".
**Why it might work:** the note bridge already exists, so cards become controls instead of decoration.

### Direction 9 (contrarian): no agent-authored UI at all

Only host-derived cards (direction 1) and richer ask forms. Agents never author layout.
**Why it might work:** reception says agent-built views draw the most doubt and the most security exposure, and developers asked for harness-native rendering, not generated layouts.

## Tensions & trade-offs

- **Agent freedom against consistency.** Directions 3 and 4 let agents lay out UI; directions 1 and 9 keep layout in Quirky's hands. Every step toward freedom adds prompt tokens and variance.
- **A library against owning the spec.** OpenUI and json-render bring streaming and catalogs, but both are 0.x with sharp edges. Direction 2 avoids the dependency and inherits the maintenance.
- **Standard against reach.** MCP Apps is the standard, but only Codex hands the host the link today. A host-defined spec reaches all four backends.
- **Inline against beside.** Cards belong in the transcript, but views that update need a stable place, which pulls toward a side pane.
- **Security against richness.** Catalog rendering runs no agent code. HTML views do, inside a desktop app where an escape is worse than in a browser tab.

## Challenge notes

- **1 (host cards).** Steelman: zero risk and immediate value. Counter: tool names and shapes differ per backend and drift, so the mapping table needs upkeep. Disproved if most useful output arrives as free text rather than tool calls.
- **2 (grow ask).** Steelman: reuse a channel that already validates and sandboxes. Counter: ask is a blocking question flow, and read-only blocks are a different contract. Disproved if extending it makes the question flow harder to reason about.
- **3 (fenced reports).** Steelman: works today with no backend changes. Counter: catalog prompts cost tokens on every turn, and json-render's own validity was 82.8% in a vendor benchmark. Disproved if agents drop or mangle the fence often enough that users stop trusting the card.
- **4 (persistent views).** Steelman: fixes waste and drift. Counter: it's the use reception doubts most, and it needs a new surface. Disproved if few real tasks want a live view beside the chat.
- **5 (MCP Apps).** Steelman: standard and widely rendered. Counter: only one backend exposes the link, and desktop sandboxes have been escaped. Disproved if Quirky users don't install MCP servers that ship views.
- **6 (A2UI action).** Steelman: a specified envelope instead of inventing one. Counter: A2UI's React API is undocumented and 1.0 is days old. Disproved if each backend still needs its own reply shape, so the envelope adds a layer without saving work.
- **7 (views as files).** Steelman: debuggable and portable. Counter: clutters the worktree and the diff. Disproved if users never reopen a view after the turn.
- **8 (review cards).** Steelman: plugs into a loop that exists. Counter: duplicates the Changes panel. Disproved if users prefer to review in the Changes panel anyway.
- **9 (no agent UI).** Steelman: lowest risk, matches what developers asked for. Counter: gives up agent reports and dashboards, which lab studies say users prefer. Disproved if agents keep producing tables and charts in markdown that would read better as cards.

## Open questions & gaps

- Does the Claude Agent SDK forward `_meta` on MCP tool results? The reference wasn't read in full.
- How do pi and omp map MCP `structuredContent` into RPC events?
- Does WKWebView in Electrobun allow the frame-to-frame origin split MCP Apps needs, using a second localhost port or a custom scheme?
- What is `@a2ui/react`'s custom-catalog API?
- Is the json-render `Link` component safe against `javascript:` hrefs?
- There's no data on whether developers prefer cards from coding agents. All preference studies cover general queries.
- Brave `llm-context` returned `OPTION_NOT_IN_PLAN`, and some Reddit queries hit 422 or 429 errors, so community coverage is thinner than it could be.

## Sources

**Renderers:** [OpenUI repo](https://github.com/thesysdev/openui) · [OpenUI Lang spec](https://github.com/thesysdev/openui/blob/main/spec/language.md) · [OpenUI actions](https://www.openui.com/docs/openui-lang/actions) · [OpenUI benchmarks](https://www.openui.com/benchmarks) · [json-render repo](https://github.com/vercel-labs/json-render) · [harness-chat](https://github.com/vercel-labs/json-render/tree/main/examples/harness-chat) · [A2UI v1.0 spec](https://a2ui.org/specification/v1.0-a2ui/) · [A2UI 1.0 post](https://developers.googleblog.com/a2ui-10-build-delightful-fast-reliable-agentic-experiences/)

**Protocols:** [MCP Apps spec](https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx) · [SEP-1865](https://modelcontextprotocol.io/seps/1865-mcp-apps-interactive-user-interfaces-for-mcp) · [basic-host](https://github.com/modelcontextprotocol/ext-apps/tree/main/examples/basic-host) · [AG-UI](https://docs.ag-ui.com/introduction) · [ACP content](https://agentclientprotocol.com/protocol/content) · [Codex app-server README](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md) · [Claude Agent SDK reference](https://code.claude.com/docs/en/agent-sdk/typescript) · [pi RPC](https://cdn.jsdelivr.net/npm/@earendil-works/pi-coding-agent@0.81.1/docs/rpc.md)

**Frameworks:** [AI SDK generative UI](https://ai-sdk.dev/docs/ai-sdk-ui/generative-user-interfaces) · [CopilotKit](https://docs.copilotkit.ai/generative-ui) · [assistant-ui tool UI](https://www.assistant-ui.com/docs/tools/tool-ui) · [Tambo shutdown](https://tambo.co/blog/posts/tambo-is-shutting-down) · [LangGraph generative UI](https://docs.langchain.com/langsmith/generative-ui-react)

**Reception and security:** [How ChatGPT Intelligent UI works](https://www.openui.com/blog/how-chatgpt-intelligent-ui-works) · [Reverse-engineering Claude generative UI](https://michaellivs.com/blog/reverse-engineering-claude-generative-ui/) · [Backslash on MCP Apps](https://www.backslash.security/blog/new-mcp-spec-opens-new-attack-surfaces) · [MCP Inspector #2872](https://github.com/modelcontextprotocol/inspector/issues/2872) · [Nielsen on Google's study](https://jakobnielsenphd.substack.com/p/generative-ui-google)

**Quirky code:** `plugins/quirky.ask/src/core/spec.ts` · `plugins/quirky.ask/src/PreviewFrame.tsx` · `packages/ui/src/design-system/read-only-preview.tsx` · `plugins/quirky.session/src/window/MessageRow.tsx` · `plugins/quirky.git/src/daemon/note-bridge.ts`

Full agent reports: the session scratchpad's `genui/` folder (local only).

---

This is exploration only. The user asked to carry it into `quirk:brainstorming` next.
