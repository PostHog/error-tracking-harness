## Why

The matrix currently passes when a plugin's known defect is written into its expected result, and can pass while an entire selected case or fixture is skipped by a plugin-version floor. In particular, the two-release Next.js browser case executes zero cells against the baked plugin, so a green run does not establish release correctness. The harness must enforce one user-visible contract against the packages produced by `posthog-js`, rather than certify historical plugin behavior.

## What Changes

- **BREAKING:** Baseline conformance requires a successful build and upload, a captured exception resolved to the known source location, and the correct release on server and browser events. In two-release cases, events from both releases must remain resolvable after the second upload and the new release must be reported by its events. A real deviation fails the verdict; plugin-specific `no-release` success overrides are removed from these cases.
- **BREAKING:** Remove old-plugin `floor` selection from the conformance path and plugin-version floors that skip baseline cases or whole fixtures. Keep framework versions (Next 14/15/16) and independently selected CLI binaries; a CLI compatibility case is not an old-plugin test.
- **BREAKING:** A run fails if a selected applicable fixture/case has no executed cell, including when all cells are skipped, the required subject package is absent, or an overlay is unsupported. `--plugins subject` must exercise the supplied build, not silently fall back to baked packages. Reports distinguish skipped, uncovered, and failed.
- Strengthen multi-release assertions so a renamed artifact does not silently escape the stability check merely because its filename changed. If logical identity cannot be established, report that the invariant is unverified rather than passing it.
- Add planning and judge regression tests with actual fixture declarations and examples of missing releases, skipped coverage, and renamed artifacts. Document how `posthog-js` CI supplies PR-built tarballs and consumes a failing harness exit status.
- Preserve deliberately different scenarios (such as a case that explicitly disables release creation, or a fault that prevents upload); these are not baseline exceptions. Keep JS-specific checks such as source-map comments and SRI as existing specialized tests. Standardizing upload-failure policy and introducing a language-neutral fixture lifecycle are separate changes.

## Capabilities

### New Capabilities

- `plugin-conformance`: The common successful-build/upload/capture/resolution/release and multi-release outcomes required of every selected plugin under test.
- `matrix-coverage`: Selection, subject binding, and run/report rules that prevent a green result when requested conformance was not exercised.

### Modified Capabilities

None; the project has no existing OpenSpec capability specs.

## Impact

- `harness/judge.mjs`, `harness/plan.mjs`, `harness/run.mjs`, `harness/subject.mjs`, validation, tests, baseline case manifests, and fixture declarations; possibly dependency pins/lockfiles when deleting the floor alias.
- `README.md` and the consumer CI invocation documented for `posthog-js`; any actual workflow change in that repository must be coordinated separately.
- Existing CI may become red where plugins currently fail the contract. This is intended: no skip, weakened assertion, or expected-defect override should turn nonconformance green.
