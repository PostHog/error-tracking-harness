## Why

The matrix currently passes when a plugin's known defect is written into its expected result, and can pass while an entire selected case or fixture is skipped by a plugin-version floor. In particular, the two-release Next.js browser case executes zero cells against the baked plugin, so a green run does not establish release correctness. The harness must enforce one user-visible contract against the packages produced by `posthog-js`, rather than certify historical plugin behavior.

## What Changes

- **BREAKING:** Every retained case is a conformance test, with no `conformance: true` flag or parallel characterization mode. Healthy-upload cases require a successful build and upload, a captured exception resolved to the known source location, and the correct release on server and browser events. Two-release cases must preserve resolution for both builds. A real deviation fails the verdict; plugin-specific `no-release` success overrides are removed.
- **BREAKING:** Remove historical characterization cases whose expected outcome accepts a product defect, including alternate release semantics not part of the agreed event-mode contract. Fault-injection cases remain only when they assert a single, explicitly agreed failure policy for all applicable plugins; otherwise remove them from the matrix until that policy is specified. No case is silently excluded or converted to an expected failure to keep CI green.
- **BREAKING:** Remove old-plugin `floor` selection and plugin-version floors that skip cases or whole fixtures. Keep framework versions (Next 14/15/16) and CLI toolchain selection where they satisfy the same conformance contract.
- Select fixtures using manifest tags (`--tags` matches **any** supplied tag); combine with `--fixtures` by intersection. Surface tags and selected fixtures in `--list` and reports; fail rather than pass when the selection exercises nothing.
- **BREAKING:** Replace the separate `--plugins latest|floor|subject` modes with a single run path and optional local overrides: a manifest maps npm package names (plugins **or frameworks**) to package artifacts and `posthog-cli` to a binary. Only the named dependencies are replaced; all other fixture dependencies retain their pins. Validate and report what each cell actually used, with no network access or silent fallback when an override is missing, incompatible or unused.
- **BREAKING:** A run fails if a selected applicable fixture/case has no executed cell, including when all cells are skipped or a requested override cannot be applied. Reports distinguish skipped, uncovered, and failed.
- Strengthen multi-release assertions so a renamed artifact does not silently escape the stability check merely because its filename changed. If logical identity cannot be established, report that the invariant is unverified rather than passing it.
- Add planning and judge regression tests with actual fixture declarations and examples of tag filtering, plugin/framework/CLI overrides, missing releases, skipped coverage, and renamed artifacts. Document how `posthog-js` CI supplies PR-built artifacts and consumes a failing harness exit status.
- Keep JS-specific checks such as source-map comments and SRI as additional conformance assertions for applicable fixtures, not an alternate pass criterion. A language-neutral fixture lifecycle is a separate change.

## Capabilities

### New Capabilities

- `plugin-conformance`: The single normative build/upload/capture/resolution/release and multi-release contract required of every retained test case and applicable plugin.
- `matrix-coverage`: Tag-based fixture selection, named local dependency overrides, and run/report rules that prevent a green result when requested conformance was not exercised.

### Modified Capabilities

None; the project has no existing OpenSpec capability specs.

## Impact

- `harness/judge.mjs`, `harness/plan.mjs`, `harness/run.mjs`, `harness/subject.mjs`, validation, tests, case catalog, and fixture declarations; possibly dependency pins/lockfiles when deleting the floor alias.
- `README.md` and the consumer CI invocation documented for `posthog-js`; any actual workflow change in that repository must be coordinated separately.
- Existing CI may become red where plugins currently fail the contract. This is intended: no skip, weakened assertion, or expected-defect override should turn nonconformance green.
