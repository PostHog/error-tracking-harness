## 1. Establish a single conformance case catalog

- [ ] 1.1 Inventory all existing cases and their plugin-specific expectations; identify cases that describe agreed required behavior versus historical defects or incompatible fault behavior.
- [ ] 1.2 Remove/rewrite defect-accepting expectations and retire alternate release/no-release and fault cases without a common required outcome from the active catalog; do not add a `conformance` opt-in flag or parallel legacy mode.
- [ ] 1.3 Validate all retained cases against the common healthy-upload requirements; reject assertions that make a missing release, unresolved expected event, missing symbols or plugin-specific known defect pass.

## 2. Make every retained verdict strict

- [ ] 2.1 Require successful build/upload, expected server/browser events, correct event release and resolved crash frames in the shared judge for every retained case, including `--judge-only` saved evidence.
- [ ] 2.2 For every retained multi-release case, fail when a release, runtime event or post-final-upload resolution record is absent, or either release's events identify the wrong release; retain and test immutable-asset replay checks.
- [ ] 2.3 Replace the same-filename intersection chunk-ID check with a non-volatile multiset comparison across releases; fail explicitly on no comparable chunks and add renamed-file and volatile-only regression tests.

## 3. Fail closed on matrix selection

- [ ] 3.1 Compute coverage for every applicable selected fixture/case pair across selected CLIs and fail on zero executed cells or uncovered pairs; test with actual Next 15 and Next 16 webpack fixture metadata.
- [ ] 3.2 Make explicit subject fixture selections reject missing tarballs and unsupported overlays; infer only eligible plugin fixtures when no fixture filter is given and reject an empty inference; test both paths.
- [ ] 3.3 Include executed, passed, failed, skipped and uncovered counts in `summary.json` and `report.md`; return a failure exit status for verdict failures or missing coverage and test all-skipped and mixed-CLI selections.

## 4. Remove historical plugin paths and document consumption

- [ ] 4.1 Remove plugin-version gates and `--plugins floor`, `floorAlias` declarations and old-plugin package aliases; refresh affected fixture lockfiles, CLI validation, tests and documentation while preserving framework/CLI coverage.
- [ ] 4.2 Document and smoke-test the `posthog-js` PR-built package invocation with `--plugins subject`, including failure exit status and explicit fixture selection.
- [ ] 4.3 Run `pnpm check`, `git diff --check`, planning/list tests, judge-only regressions and relevant matrix cells; record genuine plugin failures without turning them into accepted outcomes.
