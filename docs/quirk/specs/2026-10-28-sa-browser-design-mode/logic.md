# Browser design mode: grab, annotate, draw

## Status & amendments
Approved autonomously under the unattended LOOP.md contract, 2026-10-28. Night mode combines technical decisions here and skips separate spec review. Reader: implementers and the later operator — decide whether the three design flows satisfy browser.md without weakening guest isolation.

**Amendments:** 2026-10-28: inherit `sa-browser-pane` D18's operator freeze: record Native image gaps in decisions/BLOCKERS, without another queue addition. Authored annotation feedback preserves words such as “password”; only guest context is secret-redacted, and terminal controls are sanitized at delivery. Annotations survive hosted-tab unmount/remount in the same window. Once Copy Markup commits the PNG to the clipboard API, Cancel is disabled until its result because that write cannot be revoked.

## Purpose and conceptual model
Design tools describe the exact page a person is viewing. Grab copies bounded element context or its cropped PNG. Annotate retains comments in window memory and sends Markdown only after an explicit target choice. Draw freezes actual page pixels and copies an edited PNG. Native human browsing remains a sandboxed system webview; Watch operates the exact managed Chrome page, never a URL-matched substitute.

## Scope and non-goals
All three parts of sa-browser-design-mode are included together. Browser profiles, cookie import, hosted artifacts and general browser automation remain their existing items. Linux/Windows native integration is deferred: platform. The pinned public Electrobun SDK exposes executeJavascript but no page snapshot/capture operation; Native text picking and annotations are reachable, while Native cropped screenshots and Draw require a supported snapshot capability. Watch implements both image flows through CDP. This explicit SDK boundary is recorded in the decision log/BLOCKERS; the inherited operator freeze forbids another browser queue item. No desktop screen capture, private FFI, DOM rasterization approximation, or silent Native-to-Chrome replacement.

## Key decisions & rationale
Use injected guest picker plus host-side validation and the existing browser pane. Alternatives: a cross-origin iframe cannot inspect arbitrary pages; moving all browsing to Chrome violates the locked engine separation. Keep extraction and formatting shared between Native and Watch, but treat all guest data as untrusted. Use the existing public agent/terminal APIs rather than importing another plugin's internals. Clipboard permission failure is visible and leaves the selection/notes intact.

## Decisions locked
- Layout/interaction: three accessible toolbar actions, nonblank pages only; grab/annotate mutually exclusive; drawing disables both; Esc cancels. Normal copy in editable focus or with a text selection must win over the grab shortcut.
- Information density: highlight label includes tag, role/name and dimensions; annotation tray collapses, lists individual feedback and intent, edit/delete/copy plus Copy All/clear/Send. Controls remain keyboard reachable.
- Loading/error: arming has an explicit pending state; destroyed/navigated pages cancel; no-hover/no-image/clipboard-denied states are visible, never success toasts. Guest calls are bounded and no long-held profile lock waits for user input.
- Authentication/API: schema-declared quirky.browser design methods and generated browser CLI; no guest-supplied CDP dispatch or host RPC. Native guest evaluation is only through the trusted public UI capability; its untrusted result grants no host authority.
- Data: one picker operation per page with opaque operation ID,120s lifetime and cancellation on navigation/close; annotations memory-only,20 per page with oldest eviction,2000-character comments, change default/question alternative. Selection uses click coordinates directly, not a prerequisite hover.
- Integration: explicit send target in the same worktree; existing agent is readiness/permission checked at delivery; new agent receives initial prompt after ready via terminal public API. In-flight notes cannot be resent; remove only successful unchanged snapshot notes; failure/uncertain delivery retains them. No blind mutation retry.
- Image: grab crop max2MiB, fail closed without downscale; annotation payload has screenshot null. Draw exports original screenshot dimensions, not CSS-scaled dimensions.

## Data flow
A trusted plugin injects a self-contained picker into the bound guest. A closed-shadow full-page overlay intercepts selection instead of activating the page. Pointer movement highlights; click resolves its actual coordinate element even without hover. Short nonblocking reads collect a pending selection, and host validation bounds every field before display, clipboard formatting or agent delivery. Native returns data through its existing sandbox host-message channel, with request identity and cancellation; Watch uses the owned runtime binding. Capture hides the picker for the capture and restores it in finally. The annotation store belongs to the window, grouped by pane/page URL; reload of the application loses it as in the source.

## Behavior and acceptance scenarios
Every API flow has a CLI/daemon regression; visible scenarios additionally exercise the real built web Watch surface. Native-only claims are pending nightly scenarios, never inferred from web screenshots.

### G1 — Grab and rearm
Before: local fixture contains a button with a counter and paragraph. Arm Grab; hover shows white outline/dark label. Click the paragraph without prior hover. After: clipboard starts `Attached browser context from <sanitizedUrl>`, contains the paragraph selector/text/styles/HTML; toast Copied, picker armed again. Counter remains unchanged. Repeat on button then another element to demonstrate rearm. C on hover produces text; S produces cropped PNG or the explicit no-screenshot error. C/S with no hover says No element hovered. Right click selects without clipboard mutation and offers Copy / Copy Screenshot. Escape ends selection. Mod+C outside editable focus/selection arms Grab; ordinary selected text copy is not intercepted.

### G2 — Bounded hostile payload
Before: fixture includes script, event handlers, password inputs, secret-bearing attributes, query/fragment credentials, oversized text/classes/HTML and React debug source. After: copied context has no script/event/form-value secrets; only allowlisted attributes and sanitized http/https/file/about:blank URLs. Budgets: text200, nearby text10x200, HTML4096, ancestor path10, nearby elements6x160, selector700, path900, classes500 (attribute class200), selected text500, React/source500, comments2000. Overlong strings end ` (truncated)` within their field limit. Secret markers access_token/auth_token/api_key/apikey/client_secret/oauth_state/x-amz-/session_id/sessionid/csrf/secret/password/passwd are redacted case-insensitively. Malformed page/target rejected; hostile guest values never authorize filesystem/clipboard/agent writes. Rectangles and screenshot dimensions must be finite and bounded.

### G3 — Lifetime and capture
Before: picker operation A is armed. Start B, navigate, close the pane, switch mode or unmount. After: A cannot deliver into B; resources/listeners/timers disappear, page close does not retarget an identical-URL page. Pick times out at120s. CDP PNG crop uses viewport coordinates and actual screenshot scale; overlay absent in image; oversized PNG returns no image, not success. Native unavailable capture explains SDK limitation before any privileged action.

### A1 — Annotation editor and tray
Before: no annotations. Annotate paragraph, type a Change and Add (also Mod+Enter); picker rearms. Add a second Question without prior hover. After:2 pins/count, tray lists both. Edit one, delete one, copy one, Copy All, collapse/expand, clear. Empty/whitespace feedback is not added. Add21 valid annotations: keep newest20; each payload screenshot is null. Navigation retains correct original URL context and does not assign old notes to the new page. Application restart clears memory.

### A2 — Markdown
Before: annotations include backticks, multiline labels and two URLs. After: one-page output begins `## Design Feedback: <sanitized pathname>` with URL/browser tab id/viewport and numbered labelled elements; intent, selector/location/source/React/bounds/classes/selected-or-text, nearby text/elements, nondefault styles/full path, fenced HTML and Feedback follow. Empty sections/default styles omitted; labels use React plus tag and accessible name or60-character text; inline fields collapse whitespace and cap2048; fences exceed longest embedded backtick run. Multi-page output begins `## Design Feedback across pages`, groups URLs and gives per-item page/viewport. No screenshot, priority line or invented instruction preamble.

### A3 — Explicit guarded delivery
Before: ready agent, blocked agent, agent in another worktree and available launch agent. Send opens `Send notes to`, showing state/age/title and disabled reason, then New agent. Choose ready session: one prompt delivered through public guarded APIs and Notes sent; remove only sent unchanged notes. Choose new agent: real hosted agent tab receives prompt after ready. During delivery a second send excludes held IDs; editing a note preserves its changed revision after successful send. Fail/partial/unconfirmed retains all affected notes. Another worktree session rejected even through direct API; no automatic delivery from Grab or Draw.

### D1 — Screenshot markup
Before: visible Watch fixture with text and shapes. Draw freezes real screenshot; page no longer receives drawing input. Tools Pen, Highlighter, Arrow, Rectangle, Ellipse, Text, Eraser, color, thickness and text font size operate on the frozen original-resolution canvas. Draw each tool, erase a shape, Undo/Redo, Clear all/Undo; starting a new action after undo clears redo. Copy Markup composites screenshot plus drawing as PNG and confirms only after actual clipboard write. Cancel/Esc drops edits without changing clipboard. Drawing remains accurate when host CSS viewport is smaller than screenshot and with pointer capture outside canvas.

## Defect regressions
The source browser.md:460 reports unconfirmed Grab selections and a second annotation after coordinate-only clicks. Regression exercises actual coordinate click without preceding hover, second selection and second annotation. It must assert real payload/clipboard or tray effects, not merely toolbar activation. Guest-defined prior globals/Zone.js must not strand cancellation; new arm safely tears down only owned old picker. Same-URL pages/worktrees and late operations never cross targets. PNG failures never claim Copied.

## Industry insights
No external research swarms under LOOP.md night mode. Grounding: read-only browser.md sections3, extraction/payload/safety/text/delivery and edge cases; locked docs/architecture.md Browser; sa-browser-agent and sa-browser-pane decisions. Native SDK BrowserView.ts exposes no-completion JavaScript execution, no supported snapshot. Existing native-browser.ts supplies sandbox host-message reporting; agent delivery/readiness already has public APIs.

## Deferred ideas
Native image capture only, for the supported-SDK boundary above; no unrelated additions. Both Native cropped screenshots and frozen Draw are recorded together in BLOCKERS without growing the queue under the inherited operator freeze. Platform-specific integration outside macOS remains deferred: platform.

## Glossary
Guest: untrusted page. Picker: injected closed-shadow selection overlay. Payload: bounded/redacted element context. Annotation: payload plus user feedback and intent. Watch: exact managed Chrome screencast. Native: sandboxed system webview. Held snapshot: annotations excluded from concurrent send until result is known.

## Technical decisions and implementation partition
Executor omp-task/OpenAI; cross-family reviewer Gemini through pi-watch because actual Opus/Sonnet preflight unavailable. Shared contracts committed first in src/design-contract.ts and public NativeBrowserHandle.evaluate(script):Promise<unknown>. It executes only inside owned sandboxed guest, bounded result/time, rejects navigation/disposal/stale identity, and does not expose privileged host execution. No native screenshot method advertised.

Runtime component owns src/design/**, src/service.ts, src/runtime/catalog.ts and test/design*.test.ts. It supplies bounded guestProgram(action,opId), clampPayload, formatGrabPayloadAsText, formatBrowserAnnotationsAsMarkdown, DesignService and DESIGN_METHODS registration. Methods designArm/read/hover/cancel/capture target pane/page Watch binding; native UI uses same guest program through evaluate. designFormat accepts untrusted payload/annotations and returns safe text/Markdown. designTargets/designSend use same-worktree public APIs and return actual delivery outcome.

UI component owns quirky-plugin.json, cli.ts, src/ui.tsx, src/window/BrowserPaneWindow.tsx, src/design-window/**, README.md and test/design-ui*.test.tsx. It owns all schemas/commands and Native/Watch picker integration, clipboard text/PNG, annotation memory/edit/tray/send/holds. It integrates MarkupOverlay from the third component. Every shipped method is manifested and has CLI command group entry. It must not import unfinished preference UI or alter unrelated pane controls.

Native+Markup component owns packages/ui/src/native-browser.ts, packages/ui/test/native-browser*.test.ts, plugins/quirky.browser/src/markup/** and test/markup*.test.ts. Add evaluate to existing model adapters; other capability mocks use createNativeBrowserCapability and remain consistent. MarkupOverlay contract: `{ screenshot: DesignScreenshot; onClose():void; onCopied():void; onError(message:string):void }`; clipboard itself is written by overlay only after compositing, returning no synthetic success. Native capture remains unavailable and native handoff records actual pending scenarios.

Parent owns shared types, specs/decisions/BLOCKERS/native scenario files, integration and any explicitly replanned repairs. Three disjoint concurrent components, one wave, width cap3; no mid-flight checks/commits; source snapshot audit at barrier, then exact owned checks and aggregate `bun scripts/suite.ts plugins/quirky.browser packages/ui packages/protocol apps/desktop`, `bun test scripts`, `bun run typecheck`, `bun run build`. Actual fresh-home daemon/Chrome/API/CLI and web UI smoke. Every process uses isolated HOME/QUIRKY_HOME and awaited owned cleanup; never real native Default storage. Merge dependency again before final tests; await canonical deps readiness in this turn, merge roadmap once before landing through canonical queue.
