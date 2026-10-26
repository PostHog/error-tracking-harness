## Purpose

Allows fixtures from different languages and frameworks to provide the same build, run, error-trigger, and artifact-discovery contract without introducing language-specific execution branches in the harness.

## ADDED Requirements

### Requirement: Fixtures declare a complete lifecycle
Each fixture SHALL declare its workspace preparation method, build command, build-output location, runtime kind and any runtime command, trigger action(s), and expected error source locations in a validated manifest. Commands SHALL have an explicit executable and argument list and SHALL NOT require a `package.json` or Node.js entry by default. Invalid or incomplete lifecycle declarations SHALL fail before executing a matrix cell.

#### Scenario: Non-Node fixture is valid
- **WHEN** a fixture declares an executable build command, output directory, process runtime command, and error trigger without any `package.json`
- **THEN** the harness accepts and executes its lifecycle without requiring Node.js-specific fixture metadata

#### Scenario: Build command missing
- **WHEN** a fixture has no executable build command
- **THEN** validation fails with a fixture-specific error before the matrix runs

### Requirement: Releases use the same isolated build lifecycle
The harness SHALL prepare an isolated fixture workspace once per cell using its declared preparation method, then run the declared build for every selected release with the mock host, release identity, and case configuration available through the fixture contract. It SHALL use the scrubbed environment and record build status and logs. A failed preparation or build SHALL remain a visible cell error or failed verdict, not a skip.

#### Scenario: Two successive builds
- **WHEN** a selected case requests two releases
- **THEN** the fixture's declared build is run for each release with the corresponding release identity, and both results are recorded

#### Scenario: Build fails
- **WHEN** the fixture's build exits unsuccessfully
- **THEN** the failure and build output are recorded and the cell cannot be reported as an unqualified pass

### Requirement: Drivers execute declared triggers and clean up
The harness SHALL use reusable process, HTTP, and browser runtime drivers according to the fixture manifest. A fixture SHALL be able to declare its startup, readiness, trigger, and shutdown needs without changing the core executor for a new framework. Runtime failures, timeouts, and missing expected events SHALL be visible in evidence or a failed cell, and a started child process SHALL be stopped after execution, including on failure.

#### Scenario: HTTP server reports a known exception
- **WHEN** a fixture declares an HTTP startup command, a readiness probe, and a request that triggers an error
- **THEN** the harness starts it, waits for readiness, requests the declared route, captures the event, and stops the server

#### Scenario: Process command reports a known exception
- **WHEN** a fixture declares a process runtime and executable trigger command
- **THEN** the harness runs that command without assuming the process is Node.js and collects its exit status and captured event

#### Scenario: Server fails to become ready
- **WHEN** the declared HTTP startup process exits early or does not become ready before its deadline
- **THEN** the cell records the failure and terminates any remaining child process

### Requirement: Output and runtime mappings are explicit
The fixture SHALL identify which built files belong to the release and, for served artifacts, how runtime URLs map back to those files. The harness SHALL retain per-release output and collected events so existing evidence and judge behavior, including previous-release asset replay where configured, are preserved after migration.

#### Scenario: Browser loads old immutable assets
- **WHEN** a second release's declared browser page requests an asset that the fixture marks immutable and the first release emitted
- **THEN** the driver can serve the first release's bytes, record the replay, and still attribute captured events to the appropriate release

#### Scenario: Fixture migrated without changing its verdict inputs
- **WHEN** an existing fixture is migrated to the lifecycle manifest
- **THEN** it supplies the same built files, thrown-error markers, runtime observations, and event evidence to the judge as before the migration

### Requirement: Selection tags and applicability labels remain distinct
A fixture's selection tags SHALL continue to select fixtures by any-tag matching, independently of case applicability. Cases and fixtures SHALL declare compatible applicability labels rather than require a hardcoded list of framework names. Matching an applicable case to a newly named fixture category SHALL not require a new execution branch, while explicitly selected incompatible combinations SHALL remain uncovered rather than passing silently.

#### Scenario: New framework category
- **WHEN** a fixture and case share a valid new applicability label
- **THEN** the planner can form a cell and use the declared lifecycle without changing framework-specific executor logic

#### Scenario: Incompatible selection
- **WHEN** a tag-selected fixture and case have no compatible applicability label
- **THEN** the matrix reports no applicable cell instead of claiming that the case passed

### Requirement: Lifecycle preparation preserves selected overrides
The declared workspace preparation SHALL apply all compatible local package and CLI overrides selected for that cell before running its build or runtime commands. Changing the fixture lifecycle SHALL NOT cause an overridden plugin, framework or CLI to fall back to a pinned dependency; unsupported or unapplied overrides SHALL remain visible failures.

#### Scenario: Framework and plugin overrides survive migration
- **WHEN** a Next fixture is selected by tag and receives local overrides for `next` and `@posthog/nextjs-config`
- **THEN** both overridden packages are used by the declared build, and their identities are recorded in evidence

#### Scenario: Command-prepared fixture cannot apply an override
- **WHEN** a fixture's preparation command has no binding for an override that applies to it
- **THEN** the cell fails before it can be reported as passing
