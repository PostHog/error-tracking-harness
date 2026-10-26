## Context

See `proposal.md`, `specs/plugin-conformance/spec.md`, and `specs/matrix-coverage/spec.md`. Today the case catalog includes expected defects, historical compatibility behavior and negative scenarios; `planMatrix` skips cells using `minPlugin`; `run.mjs` returns success for zero executed cells; subject mode silently drops `subject: false` fixtures; and `judge.mjs` compares cross-release IDs only for identical filenames. The normal CI matrix uses baked plugin pins; `posthog-js` can supply packages through `/subject`. No language-neutral fixture lifecycle is introduced here.

## Goals / Non-Goals

**Goals:**
- One test standard: every retained case describes behavior plugins must satisfy. There is no opt-in conformance flag, legacy characterization suite, or accepted-defect expectation.
- Require correct builds, uploads, resolved errors and releases in healthy cases, including the currently skipped Next two-release case.
- Preserve saved evidence and the pure `judge(evidence, kase)` API so `--judge-only` still works.

**Non-Goals:**
- Defining a universal upload-failure policy without a product decision. Remove fault cases that currently assert incompatible behavior until their common required outcome is specified; do not count them as passing conformance.
- Supporting symbol-set/no-release as an alternative conformance mode in this first standard. Retire these cases from the active conformance matrix without claiming to remove production functionality.
- Creating native/Hermes collectors, replacing the mock with the production symbolicator, or implementing the language-neutral fixture lifecycle.
- Editing workflows in `posthog-js` from this repository; document the invocation and coordinate the integration separately.

## Decisions

### One normative case catalog, not an opt-in flag

Do not add `conformance: true` or any other switch that chooses a strict judge. Inventory existing cases: retain or rewrite only those expressing the agreed contract; remove historical `expect.events: no-release`, `maps: dangling`, inconsistent build-failure expectations, old-version branches, and cases that explicitly disable the release required by the standard. The initial release contract is event mode with the correct release on each expected event; move symbol-set/no-release characterization cases out of the active catalog. A future fault scenario may be added once its expected behavior is uniform across all applicable plugins. Enforce conformance in the judge for *every* retained case, including saved-evidence rejudging; case-specific assertions may add requirements but cannot weaken build, symbol, resolution, or release outcomes. Keep JS-specific map/SRI checks on applicable fixtures, removing defect-accepting expectations rather than calling those fixtures exempt.

### Eliminate plugin-age gates, not framework coverage

Remove `minPlugin` case/fixture floors and the `floor` plugin selection and aliases. Do not replace them with expected failures or a `>=` pin still absent from the image. Keep Next 14/15/16 and other framework fixtures; independently selected CLI versions may remain for compatibility as long as they are judged against the same contract. A CLI requirement (`minCli`) may skip older CLI cells, but a selected fixture/case pair with no executed cell is uncovered and fails.

### Calculate coverage before declaring success

After planning, derive all applicable fixture/case pairs using existing mode compatibility rules. Explicit fixture/case filters must produce at least one applicable pair. Every selected applicable pair must have at least one executed cell across the selected CLIs; the run as a whole must execute at least one cell. Persist uncovered pairs with reasons in `summary.json` and `report.md`, distinct from skipped cells, and make `saveSummary` fail for incomplete coverage. `--list` remains diagnostic, prints counts and uncovered pairs, and never claims that an actual run passed. This catches an all-skipped job without treating an old CLI skip as a failure when a newer selected CLI covers the pair.

### Make subject selection explicit and fail closed

When `--plugins subject` and `--fixtures` are explicit, reject missing plugin tarballs or `subject: false` fixtures before planning. Without an explicit fixture filter, include only fixtures whose plugin is supplied; print the set and fail if none can run. A shared dependency tarball alone does not select a fixture. `selectedPlugin` and `prepareNodeModules` still record the overlaid package name/version; dependency mismatches remain harness errors, not skips. Document `posthog-js` CI invoking the image with `--plugins subject --subject /subject --fixtures <affected-fixtures>` to test PR-built packages, not baked pins.

### Do not treat renamed files as absent evidence

For the existing JS-specific chunk identity invariant, restore comparison of the sorted multiset of non-volatile chunk IDs across releases rather than intersecting filenames. A changed number of checked chunks or changed IDs in event mode fails. Fail explicitly when either release has zero checked chunks. Review broad `volatileChunks` exclusions so they do not exempt all application chunks. This conservative rule may expose real nondeterminism; do not replace an unverified check with success. Other symbol formats can define artifact identity in a later proposal.

### Require complete successive-build evidence

For every retained case with `releases > 1`, `judge` requires the requested number of successful releases, runtime events for each, and `afterFinalUpload` containing first-release events re-resolved against the final upload. Preserve the browser replay count check where `immutable` is configured and verify second-release browser events carry the new release. Add synthetic judge tests for absent, stale and mismatched evidence.

## Risks / Trade-offs

- [Baked published plugins have known defects] → CI may turn red by design; report the package version and failing assertion, then fix the plugin and update its pin.
- [Retiring historical/fault cases reduces diagnostic breadth] → Record removed observations in issue #9 or a future agreed policy spec, but do not count them as passing tests or keep a parallel mode.
- [Strict chunk multiset checks flag nondeterministic builds] → Retain logs/dist evidence and narrow only genuinely volatile generated artifacts after source-level investigation.
- [Subject overlay is unsupported for a selected layout] → Fail explicit selection; a later fixture binding change can support that layout.
- [Consumer workflow lives in another repository] → Provide a tested image invocation and coordinate the required check in `posthog-js` separately.

## Migration Plan

1. Inventory each case against the single event-mode contract, and classify it for rewrite into a normative assertion or removal from the active catalog. Do not silently omit an agreed requirement.
2. Add unconditional judge/validation checks and unit tests, including saved-evidence and zero-coverage failures; keep the report honest when published plugins fail.
3. Remove defect acceptances, alternate release/legacy cases, plugin-age floors and floor aliases; update fixture lockfiles, docs and planning tests. Preserve latest published pins only for standalone/nightly runs until subject builds replace them.
4. Document and exercise a `--plugins subject` invocation with packages built by `posthog-js`; a later PR in that repo makes the harness exit status a required check.
5. Run fast harness checks, metadata planning, `--judge-only` regressions and relevant matrix cells; genuine plugin failures are expected red results, not a reason to weaken expectations.

Rollback: revert harness changes if planning or execution is incorrect. Do not restore a historical/expected-defect success mode.
