## 1. Mark and validate conformance cases

- [ ] 1.1 Add a validated `conformance: true` case flag and reject healthy-baseline expectations that declare build/upload failure, missing symbols, unresolved events, or plugin-specific missing releases; cover validation with tests.
- [ ] 1.2 Mark `baseline/event`, `next/baseline-event`, and `nuxt/baseline` as conformance cases; remove their plugin-defect success overrides and plugin-age floors, including fixture-wide floors that skip a marked baseline.
- [ ] 1.3 Keep explicitly negative and symbol-set cases separate; add tests proving their deliberate expectations are not overwritten by the conformance defaults.

## 2. Strengthen conformance verdicts

- [ ] 2.1 Require successful releases, all expected server/browser events, correct release identity, and resolvable crash frames for marked cases even when rejudging saved evidence with `--judge-only`.
- [ ] 2.2 For marked multi-release cases, fail when a release, event, or post-final-upload resolution record is absent or when either release's events carry the wrong release; retain and test immutable-asset replay checks.
- [ ] 2.3 Replace the same-filename intersection chunk-ID check with a non-volatile multiset comparison across releases; fail explicitly on no comparable chunks and add renamed-file and volatile-only regression tests.

## 3. Fail closed on matrix selection

- [ ] 3.1 Compute applicable fixture/case coverage across selected CLIs and fail a run with zero executed cells or uncovered explicitly selected conformance pairs; add actual-fixture planning tests for the Next 15 and Next 16 webpack cases.
- [ ] 3.2 Make explicit subject fixture selections reject missing tarballs and unsupported overlays; infer only eligible plugin fixtures when no fixture filter is given and reject an empty inference; test both paths.
- [ ] 3.3 Include executed, passed, failed, skipped, and uncovered results in `summary.json` and `report.md`, with a nonzero exit status for either failures or missing coverage; add run/report tests for all-skipped and mixed-CLI selections.

## 4. Remove obsolete old-plugin path and document consumption

- [ ] 4.1 Remove `--plugins floor`, `floorAlias` declarations, and their old-plugin package aliases; refresh affected fixture lockfiles, CLI validation, tests, and documentation while preserving framework and CLI coverage.
- [ ] 4.2 Document and smoke-test running affected fixtures with PR-built `posthog-js` tarballs via `--plugins subject`, including the required failure exit status and the explicit fixture selection for a consumer workflow.
- [ ] 4.3 Run `pnpm check`, `git diff --check`, planning/list tests, judge-only regression tests, and the relevant matrix; record any genuine plugin failures without changing conformance assertions to make them green.
