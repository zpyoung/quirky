# m3-vault-consent-tip-completion decisions

## D1: Vault owns its one documented search tip, with a real UI consumer
- **Question:** No canonical feature-tip owner exists; where does the related tip live?
- **Options:** Add an unconsumed vault marker; build a generic onboarding subsystem; let Vault own its documented search tip and consume that state in its existing consent surface; block for another owner.
- **Chose:** Vault owns the agent-session-search tip in its existing daemon store, exposes its state through its public API/CLI, and its existing consent surface consumes that state.
- **Why:** The item explicitly requests establishing the owner/state. An unconsumed marker would not complete the flow. A generic registry or separate plugin is unnecessary for one feature; Mobile onboarding is unrelated. Blocking merely because the missing behavior has not yet been implemented would leave reachable work unfinished.
- **Evidence:** ai-vault.md:12,50-55; plugins/quirky.vault/main.ts:7-18; source surveys ConsentTipSurvey and TipSeams; repository search found no feature-tip owner. Mobile owns its independent onboardingSeen setting.
- **Reversibility:** medium (a future global tip owner would migrate this state, not duplicate it)
- **Confidence:** high
- **Revisit if:** A canonical global tip owner is introduced with a migration contract.
- **Source:** assumed — autonomous

## D2: Seen is a consequence of successful local opt-in, never authorization to index
- **Question:** Which enable, failure, restart, disable and remote semantics apply?
- **Options:** Mark on display/click; infer seen from enabled during startup; mark after successful local API enable; mark after any remote enable.
- **Chose:** Mark only after the local setSearchEnabled(true) operation successfully persists/applies policy and confirms enabled status. Repeated successful enables are idempotent. Disable/clear never reset seen. Failed enable, invalid input, remote-only enable and merely reading/displaying tip state do not mark it. Existing local/all selection semantics remain; a successful local portion of all-host enable counts.
- **Why:** This fulfills SC-07 without turning ancillary state into consent or creating a searchable copy before explicit opt-in. Generic setting writes retain existing policy semantics but are not the consent-card tip action.
- **Evidence:** ai-vault.md:54-59,242; m3-vault D5; plugins/quirky.vault/src/service.ts changeLocalPolicy and setSearchEnabled.
- **Reversibility:** hard for privacy, easy for bookkeeping
- **Confidence:** high
- **Revisit if:** Consent semantics are explicitly changed.
- **Source:** locked by docs/quirk/specs/2026-10-27-m3-vault/logic.md

## D3: Use one disclosure surface; seen never removes future consent controls
- **Question:** How is the tip a consumer-visible feature rather than an orphan marker?
- **Options:** Add a second promotional card; suppress all consent after seen; use tip title/description/action on the existing full-disclosure card while unseen, normal consent copy after seen.
- **Chose:** The existing local off-state disclosure uses Search every agent session, the documented description, and Turn on session search when its daemon-owned tip is unseen. It keeps the complete privacy disclosure. After seen, an off-state card still offers Enable. Unknown/loading tip state uses ordinary consent, never guessed unseen. Multiple windows refresh from a committed tip-state event; cold mount reads the public owner API.
- **Why:** One opt-in control avoids duplicate UI and preserves re-enable consent. Title/description/action come from the source feature, not a new onboarding concept.
- **Evidence:** ai-vault.md:12,54-55; plugins/quirky.vault/src/window/HistoryPanel.tsx SearchDisclosure.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** A shared feature-tip presentation owner ships.
- **Source:** assumed — autonomous

## D4: Use current standard loop steps after the night-mode cutoff
- **Question:** Which workflow and backend pairing apply?
- **Options:** Continue expired night-mode shortcuts; follow normal two-spec and review workflow.
- **Chose:** Two markdown specs, self-answer all questions, no research swarm or human ask, one implementation component because all changes implement one small vertical flow, then one final cross-family round/fix batch. OpenAI task implementer; Gemini high reviewer after actual Opus/Sonnet probes reported no authenticated model. Spec review uses reachable Codex as LOOP requests and is labeled same-family. Preserve inherited untracked .quirk/ and .serena/ without committing them. Tests use private state. macOS only.
- **Why:** Actual clock was 2026-10-28T05:40:50-0500. The feature doc/current code settle the bounded design; external industry research would not establish a missing internal owner.
- **Evidence:** pi-watch --check probes: opus/sonnet unavailable; gemini google/gemini-3.1-pro-preview:high ready; codex gpt-6.1-sol:medium ready; terra and flash ready. LSP status: no language servers configured. Initial HEAD 93ea5d004adb00d83dbd23ef2eb21b58eedcc9a2; no tracked inherited changes.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** Reviewer dispatch fails or implementation reveals a real dependency.
- **Source:** assumed — autonomous

## Progress
Brainstormed all relevant API/data/integration/UI gray areas: ownership, persistence/idempotency, fail-closed consent, local/remote scope, UI loading/errors and restart. Autonomous defaults recorded above; no open human questions. Specs are being written and reviewed before implementation. Exactly one item this iteration.
