## Context

See `proposal.md`, `specs/plugin-conformance/spec.md`, and `specs/matrix-coverage/spec.md`. Today the case catalog includes expected defects, historical compatibility behavior and negative scenarios; `planMatrix` skips cells using `minPlugin`; `run.mjs` returns success for zero executed cells; subject mode silently drops `subject: false` fixtures; `--fixtures` selects only by name; and `judge.mjs` compares cross-release IDs only for identical filenames. The normal CI matrix uses baked plugin pins; `posthog-js` can supply packages through `/subject` but framework and CLI overrides take separate paths. No language-neutral fixture lifecycle is introduced here.

## Goals / Non-Goals

**Goals:**
- One test standard: every retained case describes behavior plugins must satisfy. There is no opt-in conformance flag, legacy characterization suite, or accepted-defect expectation.
- Require correct builds, uploads, resolved errors and releases in healthy cases, including the currently skipped Next two-release case.
- Select fixtures by discoverable tags and test locally supplied plugins, frameworks and CLI binaries through one optional override interface.
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

### Select fixtures by tags and calculate coverage

Require a validated `tags` array of unique lowercase, kebab-case strings on every fixture (shared defaults may supply common tags). `--tags a,b` matches a fixture with **any** of the named tags (OR). Intersect this set with `--fixtures` when supplied; no filter selects all eligible fixtures. Preserve deterministic fixture order and show names/tags in `--list` and report metadata. An unknown/unmatched tag, an empty intersection or an unknown fixture name is a selection error.

After filtering, derive all applicable fixture/case pairs using existing case applicability rules. Explicit fixture/case filters must produce at least one applicable pair. Every selected applicable pair must have at least one executed cell across the selected CLIs; the run as a whole must execute at least one cell. Persist uncovered pairs with reasons in `summary.json` and `report.md`, distinct from skipped cells, and make `saveSummary` fail for incomplete coverage. `--list` remains diagnostic, prints counts and uncovered pairs, and never claims an actual run passed. This catches an all-skipped job without treating an old CLI skip as a failure when a newer selected CLI covers the pair.

### Bind named local dependencies instead of switching plugin modes

Use one run path with optional `--overrides /subject/overrides.json`, a local manifest such as:

```json
{
  "packages": { "@posthog/nextjs-config": "/subject/nextjs-config.tgz", "next": "/subject/next.tgz" },
  "binaries": { "posthog-cli": "/subject/posthog-cli" }
}
```

Package keys are exact npm names; inspect each tarball's package manifest and validate it matches. Resolve relative paths against the override manifest, verify the CLI executable and reported version, and never fetch/install from the network at run time. Reuse/extend `prepareNodeModules` to overlay every *named* package used by a fixture, not only its primary plugin; check transitive dependency compatibility and fail when the target layout cannot be overlaid (including isolated pnpm layouts). Unmentioned packages keep their pins. If the CLI binary is supplied, use that one binary for selected cells instead of enumerating baked CLIs. `--cli-binary` can be a compatibility spelling for the same override, but conflicting CLI inputs are errors; remove the separate `--plugins latest|floor|subject` mode selection. Record all applied package names/versions and the CLI path/version in evidence and reports without changing judge semantics.

With no fixture/tag filter, package overrides select fixtures using at least one named package; a CLI override applies across fixtures. With filters, keep the filtered set, but fail if any requested override is unused by the selected fixtures. A selected fixture depending on an overridden package must consume it or fail; do not silently test its pinned copy. This permits testing a plugin alone, a framework alone, both together, or a custom CLI binary without requiring a plugin tarball in each case. Document `posthog-js` CI mounting its tarballs, passing `--overrides /subject/overrides.json --tags <relevant-tag>`, and requiring the harness exit status.

### Do not treat renamed files as absent evidence

For the existing JS-specific chunk identity invariant, restore comparison of the sorted multiset of non-volatile chunk IDs across releases rather than intersecting filenames. A changed number of checked chunks or changed IDs in event mode fails. Fail explicitly when either release has zero checked chunks. Review broad `volatileChunks` exclusions so they do not exempt all application chunks. This conservative rule may expose real nondeterminism; do not replace an unverified check with success. Other symbol formats can define artifact identity in a later proposal.

### Require complete successive-build evidence

For every retained case with `releases > 1`, `judge` requires the requested number of successful releases, runtime events for each, and `afterFinalUpload` containing first-release events re-resolved against the final upload. Preserve the browser replay count check where `immutable` is configured and verify second-release browser events carry the new release. Add synthetic judge tests for absent, stale and mismatched evidence.

## Risks / Trade-offs

- [Baked published plugins have known defects] → CI may turn red by design; report the package version and failing assertion, then fix the plugin and update its pin.
- [Retiring historical/fault cases reduces diagnostic breadth] → Record removed observations in issue #9 or a future agreed policy spec, but do not count them as passing tests or keep a parallel mode.
- [Strict chunk multiset checks flag nondeterministic builds] → Retain logs/dist evidence and narrow only genuinely volatile generated artifacts after source-level investigation.
- [Framework overrides may need an incompatible dependency graph] → Validate declared/transitive dependencies against installed fixture packages and fail with a reproducible compatibility error rather than network-installing or falling back.
- [An override cannot reach an isolated fixture layout] → Fail when selected; a later binding adapter can support that layout.
- [An override is unused because of tag filters] → Fail early and show the override name and selected fixtures.
- [Consumer workflow lives in another repository] → Provide a tested image invocation and coordinate the required check in `posthog-js` separately.

## Migration Plan

1. Inventory each case against the single event-mode contract, and classify it for rewrite into a normative assertion or removal from the active catalog. Do not silently omit an agreed requirement.
2. Add unconditional judge/validation checks and unit tests, including saved-evidence and zero-coverage failures; keep the report honest when published plugins fail.
3. Remove defect acceptances, alternate release/legacy cases, plugin-age floors and floor aliases; update fixture lockfiles, docs and planning tests. Preserve latest published pins only for standalone/nightly runs until subject builds replace them.
4. Add fixture tags and local named overrides for npm plugin/framework tarballs and a CLI binary. Test selection, artifact compatibility, provenance and no-fallback errors; document a `--overrides` invocation with packages built by `posthog-js`. A later PR in that repo makes the harness exit status a required check.
5. Run fast harness checks, metadata planning, `--judge-only` regressions and relevant matrix cells; genuine plugin failures are expected red results, not a reason to weaken expectations.

Rollback: revert harness changes if planning or execution is incorrect. Do not restore a historical/expected-defect success mode.
