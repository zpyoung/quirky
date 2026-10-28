# GitHub hosting deferred parity

## Purpose and conceptual model

Finish the two flows explicitly deferred by m4-hosting-api-github D38: issue types for issues in user-owned Projects, and same-tick batched GraphQL work-item search with reusable pagination cursors. A Project owner and its issue repository owner are different identities. Issue types belong to the content repository's organization, irrespective of whether the Project belongs to a user or organization.

## Scope and non-goals

Retain the built-in quirky.hosting public API and generated hosting CLI. Cut over the existing Tasks issue-type consumer by removing its temporary Project-owner restriction. No new pages, settings, provider transport, token store, merge behavior, generic batching service or arbitrary upstream API. Empty-query recent-issues and PR list transport retain their existing semantics. The separate workItemPage numbered REST contract remains unchanged; it promises no cursor-prefix walk and is not migrated to GraphQL.

## Data flow

Project item membership and the trusted host are validated before looking up the content repository's issue and organization issue types. Discovery without a selector returns the existing issueTypes result without mutation. A selected enabled type is applied once, confirmed, invalidated and published through the existing changed event. Tasks uses the same public projectEdit method and normal optimistic rollback/readback.

GraphQL issue searches and issue/PR counts entering the same event-loop turn and execution scope share a bounded aliased query. Each caller receives only its alias's validated response or classified failure. Cached page boundaries let later pages start from the nearest usable cursor instead of rewalking page one. Host, account, environment, repository identity and mutation generation remain part of the scope; no new persistent state is needed.

## Key decisions & rationale

Prefer a hosting-local batch/cursor module over a global scheduler: only this existing flow needs the optimization, and the runner already owns auth, admission, retries and reported-cost accounting. Keeping individual queries fails the explicit deferred contract; batching across accounts risks credential bleed. Preserve existing public signatures rather than add consumer-visible batch flags.

Use the repository owner's authenticated GraphQL type to distinguish an organization from a user; do not attempt organization(login:) for a known personal repository and mislabel the resulting error as empty discovery. A personal repository has no organization issue types: discovery is successfully empty only after that fact is established; a requested type returns not_found. A provider error or malformed/missing connection is not an empty catalog.

## Decisions Locked

- API/CLI: existing method names, JSON envelopes, selectors, flags and safe data.reason errors remain stable. updateIssueType without a selector is discovery; an ID or case-insensitive name selects an enabled type.
- Authentication: Projects uses ambient gh on a trusted project host and obtains content identity from authenticated item metadata. Content repositories need not be local remotes. Ordinary work-item search stays bound-account scoped and configured-remote restricted.
- Pagination: query <=8192 UTF-8 bytes; offset+limit <=1000. Batch <=10 aliases and <=12000 GraphQL document characters, additionally constrained by the existing runner's8192-byte document ceiling. Variables retain the runner's existing request-body bound; do not invent a lower combined-document/variable limit.
- Caches: search pages/counts live <=120 seconds, <=512 entries/16 MiB; cursor state <=1024 entries/1 MiB and <=120 seconds. Exact duplicates coalesce. noCache bypasses settled search/cursor data. Mutations and disposal clear relevant data, and late prior-generation responses cannot repopulate it.
- Failure isolation: an alias-specific GraphQL error does not invalidate unrelated successful aliases. Transport/global GraphQL failures retain existing per-caller REST fallback and safe partial failures. Malformed pagination or repeated/nonadvancing cursors cannot return duplicated/missing rows as complete success.
- Resource accounting: use the existing four-slot gh runner and reported rateLimit.cost accounting once per actual batch, with no second debit or replay of mutations.
- Platforms: macOS only verified; Linux/Windows process behavior remains the predecessor's deferred platform work.

## Behavior and acceptance scenarios

Every API flow uses a real temporary-home daemon and isolated gh executable. Tests must observe provider state/requests, not inspect implementation strings.

| ID | Data before / walkthrough | Required data after |
|---|---|---|
| P01 | User-owned Project contains an organization-repository issue outside local remotes; discover types | Enabled and disabled type metadata returned from the content organization, changed:false; no write |
| P02 | Select an enabled type by ID and by name through projectItemMutation; read projectItemDetails | Exactly one mutation per call, confirmed type read back; changed event and cache invalidation retain correct issue/project identity |
| P03 | Unknown/disabled type, PR content, mismatched project/item or substituted foreign host | Explicit safe refusal before mutation; prior type unchanged |
| P04 | A personal-repository issue is in either Project owner type | Authenticated User repository owner produces an empty catalog; requested type is not_found; missing repository/permission/schema error stays an error |
| P05 | Paginated type catalog, malformed connection or failed provider read | Follow valid continuation; never silently return a partial/empty successful catalog for unavailable data |
| S01 | Distinct issue searches and count requests become ready in the same turn/scope | One or bounded split aliased GraphQL calls; correct independently mapped rows/counts and runner cost accounting |
| S02 | >10 aliases, large requests, exact duplicates, differing bindings/hosts | Deterministic bounded batches, duplicate coalescing, no result/account cross-contamination |
| S03 | Fetch page one then a later page and adjacent pages of the same query | Correct ordered rows/totals/hasNextPage, reuse learned cursors/pages; skip-to-page walks <=100-result blocks and never requests >1000 results |
| S04 | Fresh response cached, then noCache/mutation/account or remote change | Fresh independent scoped results; late old response cannot repopulate new-generation cache or cursor state |
| S05 | One alias fails while another succeeds; whole GraphQL call fails | Successful alias remains usable; failed caller uses existing safe fallback/partial error; no false zero or empty success |
| S06 | End of results, invalid/repeated/missing cursor or malformed page | Correct end-of-list or safe failure/fallback, never duplicated rows advertised as complete |
| C01 | Real quirky hosting CLI discovers and changes a user-Project issue type, then lists/counts | Same daemon behavior and readback as API; no private handler/import bypass |
| U01 | Tasks opens a user-owned Project containing an organization issue, loads issue-type choices and changes it | Existing selector works without D38 warning; selected type survives refresh; failures retain rollback/error behavior |

## Orca defect regressions

These flows introduce no new Orca-specific UI defect from hosting-api.md. Preserve predecessor GH08 account-separated budgets, GH11 generation-safe invalidation, GH18 explicit status-only rerun errors and GH22–24 single merge path. S02/S04 specifically exercise cross-account and stale-result protections while adding batching.

## Industry Insights

No research swarm under LOOP night-mode instructions. Requirements: external hosting-api.md sections Work items and Projects v2 (lines301–322), parent decisions D17/D37/D38 and existing runtime-runner cost/account policy. GitHub issue types are organization-owned, not Project-owner-owned; authenticated repository metadata determines capability.

## Deferred Ideas

None beyond the predecessor's platform deferral. No new scope deferred by this item.

## Glossary

Alias: one independent search field in a shared GraphQL query. Cursor: opaque provider continuation token for a validated query/scope and result offset. Content owner: owner of the repository containing the Project issue, not the Project owner.

## Technical decisions and contracts

Public contracts stay exactly the existing manifest signatures: listWorkItems(params, caller), countWorkItems(params, caller), projectItemMutation(params, caller), and quirky.tasks/projectEdit. Existing Handler, HostingEnv, Scope, RunOptions and ItemSourcePage remain authoritative; no protocol/schema growth is required. Parent public APIs already declare all selectors/results needed here.

Implementation scopes: consume lane8's committed9cc24e68 (search coordinator and dedicated daemon tests) andeafde4d7 (content-owner issue types, dedicated tests and Tasks guards), then independently verify remaining regressions. The coordinator stays private in item-search.ts; no separate module/interface is necessary. Local test-only components own work-items.test.ts, parity-search-regressions.test.ts and Tasks projects tests/fixtures without overlapping files. Main orchestrator owns docs, actual CLI/UI smoke, reconciliation and final verification. No local implementer commits or runs checks mid-flight; parent runs checks after the wave barrier.

Batch coordinator is per HostingEnv, with scope-keyed pending aliases and bounded settled page/cursor caches. Reuse env.cacheKey (including environment/account/repo generation) and env.onInvalidate/onDispose; route all actual GraphQL calls through env.graphql so rate cost is parsed/debited once. Keep internal types private unless a focused module must export them; no daemon/kernel imports. All mutation paths keep existing non-idempotent policy and confirmation behavior.

Verification commands: bun test plugins/quirky.hosting/test/search-batch.test.ts; bun test plugins/quirky.hosting/test/work-items.test.ts; bun test plugins/quirky.tasks/test/projects.test.ts; then bun scripts/suite.ts plugins/quirky.hosting plugins/quirky.tasks, bun test scripts, bun run typecheck. Final integration tests belong to queue land. Run bun run build for U01; guarded web-only unattended dogfood uses an isolated fixture and temporary QUIRKY_HOME, then kills its daemon and deletes that home. No native scenarios are added.

## Status & amendments

Status: Autonomous design accepted under LOOP.md; self-reviewed for scope, examples and error consistency. Combined logic/technical spec under night-mode one-spec rule; no separate spec review. Existing public contracts are committed before implementers start.

**Amendments:** 2026-10-28 — initial combined specification. Coordination from lane8 supplies already-committed implementations of both exact gaps, consumed without duplicate rewriting. Correct the speculative combined-variable batch ceiling to the source's GraphQL document limit and existing runner request bounds; all acceptance behavior remains required.
