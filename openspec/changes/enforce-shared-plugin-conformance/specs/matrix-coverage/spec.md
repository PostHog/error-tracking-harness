## Purpose

Ensures a passing harness run actually exercised its requested fixtures, cases and locally supplied dependencies, so filters, skipped cells or incompatible overrides cannot masquerade as conformance.

## ADDED Requirements

### Requirement: Fixture tags select a reproducible subset
Each fixture SHALL declare discoverable tags. When one or more tags are requested, the harness SHALL select fixtures matching **at least one** requested tag; when fixture names are also requested, it SHALL use the intersection. No tag filter SHALL leave the full fixture set eligible. An unknown or unmatched tag selection SHALL fail instead of producing a green zero-cell run, and `--list` and reports SHALL show the selected fixture names and tags.

#### Scenario: Any-tag matching
- **WHEN** `--tags next,browser` is requested
- **THEN** fixtures tagged `next` or `browser` are eligible, not only fixtures with both tags

#### Scenario: Tag and name intersection
- **WHEN** `--tags browser` and `--fixtures next-15` are requested
- **THEN** `next-15` runs only if it has the `browser` tag; other browser fixtures do not run

#### Scenario: No tag matches
- **WHEN** the requested tags match no fixture
- **THEN** the harness reports the empty selection and the run exits unsuccessfully

### Requirement: Selected conformance is exercised
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

### Requirement: Local named overrides can target packages or the CLI
A run SHALL accept an optional local override manifest that names npm packages (including plugins and frameworks) and/or a `posthog-cli` executable. The harness SHALL replace exactly those named dependencies in compatible fixture workspaces and use pinned fixture dependencies for all other names. Overrides SHALL be local artifacts available before the offline run; no dependency SHALL be fetched at runtime. Each requested override SHALL apply to at least one selected fixture or cause an error, and every cell SHALL report the actual plugin, framework and CLI versions/paths used. An override SHALL NOT change what constitutes a passing verdict.

#### Scenario: Override a plugin and framework together
- **WHEN** local artifacts for `@posthog/nextjs-config` and `next` are supplied for a Next fixture
- **THEN** that fixture builds using both supplied packages and reports both identities while unmentioned dependencies retain their pinned versions

#### Scenario: Override only the framework
- **WHEN** a local artifact for `next` is supplied and no plugin override is supplied
- **THEN** matching Next fixtures use the supplied framework and their pinned plugin, with both identities reported

#### Scenario: Override the CLI binary
- **WHEN** a local `posthog-cli` executable is supplied
- **THEN** selected cells use that binary in place of baked CLI selections and report its path and reported version

#### Scenario: Override is invalid or unused
- **WHEN** an artifact is missing, names a different package, cannot be installed compatibly, or is not used by any selected fixture
- **THEN** the run fails before reporting those cells as passing rather than silently falling back to pinned dependencies

### Requirement: Overrides and filters cannot conceal coverage
When overrides are supplied without explicit fixture name or tag filters, the harness SHALL select fixtures that use at least one overridden package; a CLI binary override applies to all otherwise eligible fixtures. With explicit filters it SHALL retain the filtered fixtures, verify each requested override is used somewhere in that selection, and report which dependencies each fixture used. An unsupported override for a selected fixture that depends on that package SHALL fail, not skip.

#### Scenario: Plugin override without fixture filter
- **WHEN** a local plugin package is overridden with no fixture selection
- **THEN** fixtures using that plugin are selected, and unrelated fixture plugins are not silently tested instead

#### Scenario: Explicit selection cannot use override
- **WHEN** fixture tags or names select no fixture that consumes a requested framework package
- **THEN** the run fails with an unused-override diagnostic

#### Scenario: Selected fixture layout rejects override
- **WHEN** a selected fixture depends on a package override but its layout cannot accept it
- **THEN** the run fails with an unsupported-binding error instead of skipping the fixture

### Requirement: No conformance case hides behind historical plugin floors
The planner SHALL NOT suppress any retained case or a whole fixture because the plugin under test is below a historical plugin-version floor. It SHALL allow independently configured CLI compatibility selection, but any applicable case requested with an unsupported CLI selection alone SHALL be reported as uncovered.

#### Scenario: Plugin does not satisfy an old version floor
- **WHEN** a selected plugin build exhibits incorrect behavior
- **THEN** its case runs and produces a failing verdict for the incorrect behavior rather than a version-based skip

#### Scenario: Case needs a newer CLI than any selected CLI
- **WHEN** no selected CLI can run a requested applicable case
- **THEN** the run reports it as uncovered and exits unsuccessfully

### Requirement: Coverage and failures are visible in CI artifacts
The run SHALL expose executed, passed, failed, skipped and uncovered counts plus selected fixtures and applied overrides in its summary, and SHALL return a nonzero exit status when conformance fails or requested coverage is missing. A failure to prepare, build, execute or judge a selected cell SHALL NOT be treated as a skip.

#### Scenario: One failing verdict amid passes
- **WHEN** one selected cell fails and other cells pass
- **THEN** the report identifies the failing fixture/case and the process exits unsuccessfully

#### Scenario: Every selected case skipped
- **WHEN** a selected run generates skips but no executed cells
- **THEN** the summary reports zero executed cells and uncovered selections and the process exits unsuccessfully
