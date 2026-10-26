## Purpose

Ensures a passing harness run actually exercised its requested fixtures, cases, and supplied plugin build, so skipped or incompatible selections cannot masquerade as conformance.

## ADDED Requirements

### Requirement: Explicitly selected conformance is exercised
For each selected fixture and applicable case in the active conformance catalog, the run SHALL execute at least one cell or fail with an uncovered-selection error. A run with zero executed cells SHALL fail. Skips SHALL be reported separately from executed passes and SHALL NOT count toward coverage.

#### Scenario: Every Next baseline cell is skipped
- **WHEN** a selected Next.js fixture has only skipped cells for its applicable baseline case
- **THEN** the run reports that fixture/case as uncovered and exits unsuccessfully

#### Scenario: No applicable fixture-case pair
- **WHEN** filters request fixtures and cases with no applicable pair
- **THEN** the run exits unsuccessfully instead of reporting zero passed and zero failed

#### Scenario: Mixed executed and skipped cells
- **WHEN** at least one requested applicable cell executes and another is skipped for an older CLI
- **THEN** the report counts the skip separately and uses only executed results for the corresponding coverage and pass decision

### Requirement: Subject runs test the supplied plugin build
When the user selects subject mode, every explicitly selected fixture SHALL receive a compatible supplied package for its required plugin or the run SHALL fail without falling back to the published pin. If fixtures are not explicitly selected, the harness SHALL select the fixtures whose plugin is supplied, report that selection, and fail if none are eligible. An incompatible fixture layout SHALL be an error for an explicit request, not a skip.

#### Scenario: Subject tarball supplied for a selected fixture
- **WHEN** a supplied plugin build is compatible with a selected fixture
- **THEN** the run uses that build and records its package name and version in the verdict

#### Scenario: Required plugin tarball missing
- **WHEN** the selected fixture's plugin has no supplied subject package
- **THEN** the run fails before reporting the fixture as passing

#### Scenario: Selected fixture cannot accept overlay
- **WHEN** subject mode explicitly selects a fixture whose layout cannot accept the supplied build
- **THEN** the run fails with an unsupported-binding error instead of silently skipping the fixture

### Requirement: No conformance case hides behind historical plugin floors
The planner SHALL NOT suppress any retained case or a whole fixture because the plugin under test is below a historical plugin-version floor. It SHALL allow independently configured CLI compatibility selection, but any applicable case requested with an unsupported CLI selection alone SHALL be reported as uncovered.

#### Scenario: Plugin does not satisfy an old version floor
- **WHEN** a selected subject plugin is an older version that exhibits incorrect behavior
- **THEN** its conformance cell runs and produces a failing verdict for the incorrect behavior rather than a version-based skip

#### Scenario: Case needs a newer CLI than any selected CLI
- **WHEN** no selected CLI can run a requested applicable conformance case
- **THEN** the run reports it as uncovered and exits unsuccessfully

### Requirement: Coverage and failures are visible in CI artifacts
The run SHALL expose executed, passed, failed, skipped, and uncovered counts in its summary and SHALL return a nonzero exit status when conformance fails or requested coverage is missing. A failure to prepare, build, execute, or judge a selected cell SHALL NOT be treated as a skip.

#### Scenario: One failing verdict amid passes
- **WHEN** one selected conformance cell fails and other cells pass
- **THEN** the report identifies the failing fixture/case and the process exits unsuccessfully

#### Scenario: Every selected case skipped
- **WHEN** a selected run generates skips but no executed cells
- **THEN** the summary reports zero executed cells and uncovered selections and the process exits unsuccessfully
