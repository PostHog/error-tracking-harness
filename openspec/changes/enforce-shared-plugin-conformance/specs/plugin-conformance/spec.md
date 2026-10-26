## Purpose

Defines the user-visible outcomes a plugin must achieve when the harness builds an application, uploads symbols, captures an error, and checks whether the error can be diagnosed across releases.

## ADDED Requirements

### Requirement: Successful integrations diagnose known errors
For a conformance case with a healthy upload service, every selected plugin SHALL produce a successful build, upload the symbols required for the fixture's known errors, capture each expected exception, and resolve its in-application crash frame to the declared original source file and line. The verdict SHALL fail if any required step or expected exception is absent or incorrect.

#### Scenario: Known error resolves
- **WHEN** a fixture builds with the selected plugin, uploads to a healthy mock service, and triggers its declared errors
- **THEN** each expected exception is captured and its crash frame resolves to the declared original source file and line

#### Scenario: Plugin silently fails to upload
- **WHEN** the build succeeds but symbols needed for a declared error were not uploaded
- **THEN** the conformance verdict fails even if the build command exited successfully

### Requirement: Correct release on every expected event
For conformance cases that specify a release, every captured expected exception SHALL carry the release of the build that produced it, regardless of whether the error was captured on a server or in a browser. A plugin-specific acceptance of missing or wrong release metadata SHALL NOT make such a case pass.

#### Scenario: Server and browser exceptions
- **WHEN** a fixture captures a server error and a browser error from the same release
- **THEN** both events identify that release or the conformance verdict fails

#### Scenario: Missing release on one platform
- **WHEN** an expected exception resolves to the right source but lacks its build's release
- **THEN** the conformance verdict fails for that exception

### Requirement: Earlier releases remain diagnosable
For a conformance case with successive builds, the harness SHALL verify that each release's expected errors remain resolvable after the last upload and that each event identifies its own release. Required evidence that is missing or cannot be evaluated SHALL fail the verdict rather than be treated as a pass.

#### Scenario: Second build uploaded
- **WHEN** two successive builds are uploaded and both are run
- **THEN** exceptions from each build resolve to their expected source locations and carry their respective release identifiers

#### Scenario: Older event rechecked after the second upload
- **WHEN** the second upload has completed
- **THEN** the first release's saved exceptions still resolve against the final server state or the verdict fails

#### Scenario: Recheck evidence absent
- **WHEN** a successive-build case does not collect the required post-upload recheck
- **THEN** the verdict fails as unverified

### Requirement: Cross-release artifact invariants cannot pass vacuously
When a conformance case asserts artifact-identity stability or change across releases, the harness SHALL check the relevant emitted artifacts from both builds without relying only on filenames common to both. It SHALL fail if no comparable artifact evidence exists; explicit exclusions for inherently release-dependent generated artifacts SHALL remain limited to those declared by the fixture.

#### Scenario: Hashed filename changes but chunk identity unexpectedly changes
- **WHEN** two builds emit the corresponding non-volatile chunks under different filenames with different chunk identities in event mode
- **THEN** the verdict fails rather than ignoring those chunks because the names do not overlap

#### Scenario: All relevant artifacts are excluded
- **WHEN** every artifact needed to check an asserted multi-release identity invariant is excluded or missing
- **THEN** the verdict fails as unverified

### Requirement: Deliberate negative scenarios remain distinct
Cases that intentionally remove release information or simulate a failed upload SHALL specify their own outcome and SHALL NOT be classified as healthy-upload conformance cases. The harness SHALL NOT use a negative case's expected failure to relax a healthy-upload conformance verdict.

#### Scenario: Case deliberately removes a release default
- **WHEN** a case explicitly configures an upload without a release identity
- **THEN** its specified negative outcome is evaluated separately from conformance cases that require a release
