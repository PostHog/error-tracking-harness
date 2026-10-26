## 1. Establish a single conformance case catalog

- [x] 1.1 Inventory all existing cases and their plugin-specific expectations; identify cases that describe agreed required behavior versus historical defects or incompatible fault behavior.
- [x] 1.2 Remove/rewrite defect-accepting expectations and retire alternate release/no-release and fault cases without a common required outcome from the active catalog; do not add a `conformance` opt-in flag or parallel legacy mode.
- [x] 1.3 Validate all retained cases against the common healthy-upload requirements; reject assertions that make a missing release, unresolved expected event, missing symbols or plugin-specific known defect pass.

## 2. Make every retained verdict strict

- [x] 2.1 Require successful build/upload, expected server/browser events, correct event release and resolved crash frames in the shared judge for every retained case, including `--judge-only` saved evidence.
- [x] 2.2 For every retained multi-release case, fail when a release, runtime event or post-final-upload resolution record is absent, or either release's events identify the wrong release; retain and test immutable-asset replay checks.
- [x] 2.3 Replace the same-filename intersection chunk-ID check with a non-volatile multiset comparison across releases; fail explicitly on no comparable chunks and add renamed-file and volatile-only regression tests.

## 3. Fail closed on matrix selection

- [x] 3.1 Declare/validate tags on every fixture; add `--tags` with any-tag (OR) matching and intersection with `--fixtures`, reporting names/tags and failing unmatched selections.
- [x] 3.2 Compute coverage for every selected applicable fixture/case pair across CLIs and fail on zero executed cells or uncovered pairs; test with actual Next 15 and Next 16 webpack fixture metadata plus tag-selected subsets.
- [x] 3.3 Parse a local `--overrides` manifest of named npm package tarballs and optional `posthog-cli` binary; validate exact package identity, path, executable/version and conflicting CLI options without network access.
- [x] 3.4 Extend workspace preparation to replace any named installed package (plugin or framework), check dependency compatibility, and fail when an override is unused, missing or unsupported; test plugin-only, framework-only, combined and isolated-layout selections.
- [x] 3.5 Use the overridden CLI binary in selected cells instead of baked CLI versions, preserve unrelated dependency pins, and record applied package/binary provenance in evidence and reports; test no silent fallback.
- [x] 3.6 Include executed, passed, failed, skipped and uncovered counts in `summary.json` and `report.md`; return a failure exit status for verdict failures or missing coverage and test all-skipped and mixed-CLI selections.

## 4. Remove historical plugin paths and document consumption

- [x] 4.1 Remove plugin-version gates, the `--plugins latest|floor|subject` switch, `floorAlias` declarations and old-plugin package aliases; refresh affected fixture lockfiles, CLI validation, tests and documentation while preserving framework/CLI coverage.
- [ ] 4.2 Document and smoke-test `--overrides` with PR-built plugin, framework and/or CLI artifacts and tag selection; verify failures propagate to `posthog-js` CI.
- [ ] 4.3 Run `pnpm check`, `git diff --check`, planning/list tests, judge-only regressions and relevant matrix cells; record genuine plugin failures without turning them into accepted outcomes.
