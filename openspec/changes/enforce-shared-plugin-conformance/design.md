## Context

See `proposal.md` for the motivation and `specs/plugin-conformance/spec.md` and `specs/matrix-coverage/spec.md` for the contract. Today `planMatrix` pairs cases by framework-specific `mode` and skips cells using `minPlugin`; `run.mjs` counts skipped cells separately but returns success for 0 executed cells; subject mode silently drops `subject: false` fixtures; `judge.mjs` accepts per-plugin event outcomes and compares cross-release IDs only for identical filenames. The normal CI matrix uses baked plugin pins, whereas `posthog-js` can supply tarballs through `/subject`. No language-neutral fixture lifecycle is being introduced in this change.

## Goals / Non-Goals

**Goals:**
- Make baseline event-mode conformance explicit and fail noncompliant builds, including the currently skipped Next two-release case.
- Preserve the existing evidence format and pure `judge(evidence, kase)` interface so `--judge-only` still works.
- Maintain separate CLI-version compatibility and intentional negative tests without treating them as excuses for healthy-upload failures.

**Non-Goals:**
- Choosing a unified policy for fault-injection/upload-error cases; they continue to test their declared outcomes.
- Creating native/Hermes symbol collectors or the common language-neutral fixture prepare/build/run interface.
- Altering the symbol data wire format or replacing the mock with the production symbolicator.
- Changing `posthog-js` repository workflows within this repo; document the invocation and coordinate its actual wiring separately.

## Decisions

### Identify conformance cases explicitly

Add a boolean `conformance: true` case field, validated as a boolean. Mark the healthy event-mode baselines (`baseline/event`, `next/baseline-event`, `nuxt/baseline`) first; the plugin-free CLI cases and symbol-set mode are separate paths with different release semantics. For marked cases, validation rejects plugin-specific `expect.events`/`expect.eventsBy` outcomes other than `resolved`, and incompatible `build`/`symbols`/`events` outcomes; `judge` also applies a hard conformance check on saved evidence so `--judge-only` cannot trust an edited expectation. Keep existing JS-specific map/SRI checks, but delete the Next baseline `maps: dangling` exception so it fails instead of succeeding on a known defect. This is a small explicit policy boundary rather than relying on case path names or weakening expectations across negative cases.

### Eliminate plugin-age exclusion from conformance

Remove `minPlugin` from marked cases and fixture-wide plugin floors that suppress them (for example `next-16-webpack`). Do not replace those skips with expected failures or a `>=` pin that is still absent from the image. Remove the `floor` selection and floor-alias dependencies/lock entries if no other supported matrix needs them; preserve CLI compatibility (`minCli`, `cliSelection`) and framework-version fixtures. Nonconformance legacy minima can be retired or reviewed separately, but a requested conformance cell may not be skipped for plugin age.

### Calculate coverage before declaring success

After planning, derive expected fixture/case pairs using the mode compatibility rule. Explicit fixture/case filters must produce at least one applicable pair. Every explicitly requested fixture and applicable marked conformance case must have at least one executed cell (across the selected CLIs); the run as a whole must execute at least one cell. For the default per-fixture CI run, the conformance check applies to that fixture. Persist uncovered pairs with a reason in `summary.json` and `report.md`, separate from skipped cells; make `saveSummary` return false when coverage is incomplete. `--list` remains diagnostic and prints the counts and uncovered pairs without claiming that an actual run passed. This avoids treating an old CLI skip as a failure when a newer selected CLI exercises the same pair, while catching all-skipped selections.

### Make subject selection explicit and fail closed

In `run.mjs`, when `--plugins subject` and `--fixtures` are explicit, reject missing plugin tarballs or `subject: false` fixtures before planning. Without an explicit fixture filter, include only fixtures whose `plugin` is in the supplied tarballs; print that set and fail if none can run. A tarball for a shared dependency alone does not select a fixture. `selectedPlugin` and `prepareNodeModules` continue to record the actual overlaid package name/version; dependency mismatches remain harness errors, not skips. This allows a `posthog-js` PR to invoke the image with `--plugins subject --subject /subject --fixtures <affected-fixtures>` without silently testing the baked pin.

### Do not treat renamed files as absent evidence

For the existing JS-specific chunk identity invariant, restore comparison of the sorted multiset of non-volatile chunk IDs across releases rather than intersecting filenames. A changed number of checked chunks, changed IDs in event mode, or reused entire set in symbol-set mode fails. Fail explicitly when either release has zero checked chunks, rather than passing an empty/empty comparison. Keep fixture-declared `volatileChunks` narrow and review broad exclusions; a release-dependent runtime chunk may still be excluded, but not all application chunks. This conservative rule may report a genuine build difference as a failure that needs investigation; do not replace it with an unverified success. Other languages can later define their own artifact identity adapter.

### Require complete successive-build evidence

For marked cases with `releases > 1`, `judge` requires the requested number of successful releases, runtime events for each, and `afterFinalUpload` evidence containing first-release events resolved against the final upload. Preserve the current browser replay count check where `immutable` is configured, and verify its events carry the new release. Add synthetic judge tests in which these fields are absent, stale or have missing releases.

## Risks / Trade-offs

- [Pinned published plugins have known defects] → CI may turn red by design; show failures and package versions in reports. Do not suppress them with skips or expectations; fix the plugins and update baked pins afterward.
- [Strict chunk multiset checks may flag nondeterministic builds or changed graph size] → Keep logs/dist evidence for diagnosis, narrow only genuinely volatile generated artifacts, and use case-specific source-level reasoning before revising the invariant.
- [A broad `subject: false` fixture cannot be run with an overlay] → Fail an explicit selection, and list it as not selected by default; a later fixture binding change can support that layout.
- [Consumer workflow is in another repository] → Include a tested image invocation and required artifacts in README; coordinate its adoption in `posthog-js` as a separate cross-repo action.

## Migration Plan

1. Introduce and validate the explicit conformance marker and coverage accounting with unit tests; keep existing defaults unchanged until marker adoption.
2. Mark healthy baselines, remove plugin-defect acceptances and plugin-age gates for those cells; run locally and record genuine red verdicts, not synthetic passes.
3. Remove old-plugin floor selection and aliases; update fixture lockfiles, documentation, and planning tests. Preserve latest published pins for standalone/nightly runs until subject builds can replace them.
4. Document and exercise a `--plugins subject` invocation with packages built by `posthog-js`. A later PR in that repo mounts its own packages and uses the harness exit status as a required check.
5. Run fast harness checks, `--list` against actual pins, `--judge-only` failure regressions, and the CI matrix; do not require green plugin verdicts before accepting truthful harness changes.

Rollback: revert the harness change if planning or execution is incorrect. Do not restore plugin-specific green expectations to mask confirmed product failures.
