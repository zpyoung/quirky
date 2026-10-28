# Detached Markdown diff local images

## Status & amendments
Status: Approved autonomously under the authoritative build-first LOOP. One combined logic/technical specification, self-reviewed against editor.md Markdown preview and source-control.md single-file diffs.

**Amendments:** 2026-10-28 — initial source-authorized detached resource contract. Supersedes parent m7-editor-source-control-completion D11's deliberate image omission only when the new source-bound contract is used. Text-only renderPreview remains text-only.

2026-10-28 — resource renders require explicit `id:<id>` worktrees (no ambient/name/path selectors). The generated CLI entry is `editor markdown-preview-resource`. Backend scope includes exporting the canonical renderer bound validator so pre-acquisition checks reuse one policy rather than duplicate it.

## Goal and conceptual model
A Git diff preview renders the modified Markdown text, including safe local images resolved relative to that diff's source path. Editor owns authorization, rendering and opaque file resources; Git owns diff text and hosted tab identity. Editor Changes uses the same detached contract for its shared modified draft. A lease belongs to one render effect, not a path, buffer, tab entity or split group.

## Scope and non-goals
In scope: public editor API/schema-generated CLI, authorized local images in detached Git and Changes previews, exact release, cancellation, errors, sanitization and behavior coverage. Existing buffer-bound previews remain unchanged.

Non-goals: replacing parsers, changing rich editing, loading remote image URLs, historical image blobs from Git, remote-host filesystem emulation, opening buffers to get image authority, new tab identity, source-control editing/save changes, native dialogs or unrelated viewer leases. Existing feature-document defects unrelated to detached image authorization remain with their current owners.

## Key decisions & rationale
- Recommended: separate editor `markdownPreview` render/release method with per-render lease. This preserves text-only rendering and reuses the canonical image resolver and safe renderer. Rejected: widen text-only renderPreview implicitly (blurs its authority); open hidden editor buffers (mutates state and shares wrong lifetime); duplicate Git image/parser logic (second authority and private coupling).
- Preserve existing modified-only notice, loading/error presentation and Source control. Remove the obsolete claim that all local images are omitted.
- Source authority is explicit registered worktree plus safe relative Markdown path, resolved by the editor's canonical worktree path resolver. Detached historical/staged sources may no longer exist on disk: authorize their source location with create-path resolution without creating anything. Existing symlink escape checks apply to source and images. Images are current worktree files, not historical Git blobs.
- Only canonical image resolver-supported local regular image files are resource candidates. Traversal escapes, unsafe schemes, absolute/protocol-relative URLs, malformed encodings, unsupported files and missing images never become image URLs. Missing/denied individual images retain safe alt text. Unsafe source or invalid request fails the whole preview without resources.
- Each acquisition has an unpredictable client UUID leaseId before async work begins. Register synchronously before awaits; duplicate active ids fail. Release is idempotent and exact. Cancellation/disposal fences every late resource creation, revokes it, and rejects a cancelled render. Capacity is bounded at64 active leases and64 images per lease without evicting another mount.

## Acceptance scenarios
### C1: Modified Markdown and local image
Before: docs/Guide.md exists, docs/images/chart.png exists, and HEAD has different text. Preview modified text `# New\n\n![Chart](images/chart.png)`. After: sanitized New heading and an opaque editor file-resource image render; no HEAD text, disk Markdown change, new buffer or new tab. Returning to Source preserves hosted tab id and draft. Editor Changes has the same behavior using its current shared draft.

### C2: Exact split lifetimes
Before: two mounted diffs of docs/Guide.md render the same image under different UUID leases. After releasing A, A's resource is unavailable, B's URL still serves its image. A second release reports released:false; an unknown id does not invalidate B. Source-bound editor preview resources remain live.

### C3: Async close, replacement and failure
Before: image creation is awaiting completion. Close/toggle Source/replace path or text, then let creation finish. After: cancelled resources are revoked, late HTML never replaces current UI, no surviving stale lease. Service disposal has the same fence. A render/sanitizer/resource error releases partial resources and leaves Source available. Each new effect uses a fresh id; old cleanup cannot revoke its successor.

### C4: Source and image authorization
Before: registered roots A/B contain distinct same-name images. Rendering from A resolves only A's relative source context. Encoded parent escapes, outside symlinks, malformed URLs, file/javascript/data/http schemes, absolute and protocol-relative sources, non-image files, missing images and invalid source extensions never expose raw filesystem URLs or unauthorized bytes. Missing historical Markdown is supported only through authorized location resolution; no file is created. Bound violations and duplicate active lease ids fail before returning usable HTML; active resource cap does not evict other previews.

### C5: Existing boundaries
Before: a source-bound Markdown preview is active with its canonical buffer image resources, and a text-only renderPreview request contains a local image. After: detached release leaves source preview live; text-only renderer still omits local images and rejects path/worktree/buffer context. Existing sanitize,8MiB,line and block bounds apply. No private editor imports in Git. Public Git hosted key and same-tab Source switching are unchanged.

## Decisions locked
Visual: unchanged layout/density, modified-only notice, loading and concrete error state, safe alt fallback. API: explicit authority, strict schema, exact idempotent release, duplicate conflict, bounded resources, existing error kinds. Data: ephemeral leases only, no persistence or editor drafts. Integration: public calls only, registered worktree authority, no raw caller URLs. Interaction: Source toggle/replacement/unmount release exact effect; late responses cannot set HTML. All gray areas resolved autonomously from the queue/feature docs and current canonical owners; no external research or human questions under LOOP.

## Industry insights
No research swarm under build-first LOOP. Sources: external editor.md:362–367,source-control.md:219–224; parent D11/D20; existing editor viewer exact-lease fencing and daemon opaque regular-file resources with no-store/CSP/identity protections.

## Deferred ideas
None. Other editor/source-control/remote/native flows retain existing owners. End-phase tests/review/dogfood are not new follow-up items.

## Glossary
Detached preview: rendering supplied modified text without opening/changing a buffer. Source: registered worktree and relative Markdown location, not a caller-supplied absolute URL. Lease: one render effect's private resource lifetime. Opaque resource: editor-created daemon file capability, never a raw filesystem path.

## Technical decisions and contracts
`CONTRACT:` Public `quirky.editor/markdownPreview`:
- Render params `{action:'render',leaseId:string,worktree:string,path:string,text:string}`. leaseId is1–128 `[A-Za-z0-9_-]` chars, clients use crypto.randomUUID(). worktree must be the explicit registered id selector `id:<id>`, path is a non-empty relative .md/.markdown/.mdx source without NUL/backslash/absolute/scheme escapes. Return `{leaseId,html,worktreeId,path}`; path is normalized lexical worktree-relative source identity, not a symlink target identity. No buffer argument or buffer mutation. Generated CLI command: `quirky editor markdown-preview-resource`.
- Release params `{action:'release',leaseId:string}`. Return `{leaseId,released:boolean}`. No path-wide/buffer-wide release. Releasing unknown/already-released ids returns false.
- Errors use existing invalid-params/not-found/conflict kinds; active duplicate/cancelled/disposed/capacity conflict. Failed render revokes all owned resources. Service disposal revokes every lease and fences late acquisitions.
- Existing `markdown` method/text-only renderPreview and buffer resource behavior stay compatible; generic resolver may accept a minimal source shape and optional lifetime fence, with default preserving old callers.
- Contracts/types/schema commit precedes two disjoint implementers: editor backend/resolver/API acceptance; Git FileDiff plus editor Changes consumer/lifecycle tests. Main owns docs, schema/types and integration. Backend may modify markdown service/files and add detached preview module/tests; frontend owns only FileDiff,ChangesSurface and owning tests. No overlapping sources or tests.
- Backend/API acceptance tests use existing isolated daemon fixtures and actual opaque resource GET/release outcomes. Async fences get isolated deterministic lifecycle coverage. Consumers get same-tab/local-image and late-response/unmount/split behavior coverage, not source-text or mock-forwarding tests.
- Build-first: author acceptance tests, do not run suites/review/dogfood campaigns; only typecheck landing gate. Developer-required narrow runtime/API and owned component browser smoke are recorded with explicit scope, not exhaustive acceptance. All processes use fresh temporary QUIRKY_HOME and awaited teardown.
