# error-tracking-harness

Offline, end-to-end conformance checks for PostHog error tracking: real plugin and `posthog-cli`
builds, a local mock API/object store, browser and server exceptions, and source-map resolution.
A passing run means the selected fixtures **ran**, uploaded their symbols and resolved every
expected error with the correct build release. Missing coverage and known plugin defects fail CI.

## Run

```sh
pnpm install && pnpm install:browser && pnpm install:fixtures
pnpm check
# Use a prebuilt CLI via --cli-binary, HARNESS_CLI_DIR, or the baked image.
node harness/run.mjs --cli-binary /path/to/posthog-cli --tags next,browser --cases 'next/*'
node harness/run.mjs --cli 0.18.11 --fixtures next-15,next-16-webpack --cases next/baseline-event --list
```

Fixture lockfiles pin exact versions for reproducible builds. pnpm retains a seven-day release-age
check for third-party dependencies but exempts PostHog packages, so newly published integrations
can be tested immediately. Refresh the fixture pins and lockfiles to pick up new releases.

The Docker image contains pinned fixture dependencies and CLIs. No network access is required at
run time; use `--network none` and pin the image digest in CI. With no filters, the full conformance
matrix runs. `--fixtures` selects names; `--tags` selects any matching tag (OR); both together
intersect. `--cases` accepts comma-separated globs. `--cli` selects versions; `--cli-binary` uses
a local executable instead. When testing an overridden or PR-prepared plugin tarball, the baked
CLI versions are filtered by **that plugin's** `@posthog/cli` dependency range; slow framework
fixtures use the oldest and newest compatible versions. Pinned base-image fixtures retain their
existing conformance matrix (some intentionally require newer CLIs than their older plugin shim
declares). An explicit `--cli-binary` bypasses this filter for compatibility experiments.
`--list` previews the selection without installing fixture packages or downloading CLIs. Unknown
or empty selections fail. `--judge-only <run-dir>` rejudges saved
`evidence.json` files against the current case catalog.

Every selected applicable fixture/case pair must execute at least one cell; CLI-incompatible skips
never count as coverage. The exit status is nonzero for uncovered pairs, zero executed cells, a
harness error or a failing verdict. `summary.json` and `report.md` include executed, passed,
failed, skipped, uncovered and selected fixtures/tags. Per-cell evidence, verdicts, build/runtime
logs and built files live under `<artifacts>/<cli>/<fixture>/<case>/` (by default a new
`test-results/run-*` directory).

## Prepared subject images (posthog-js CI)

The base image contains pinned fixture dependencies. The posthog-js pack job stages the fixed
smoke suite's selected npm tarballs, `overrides.json` and `source.txt` as one artifact; the
reusable workflow below downloads it and builds a temporary derivative from an inline Dockerfile.
No repository checkout or credentials enter the build context.

At image build time, `/rig/harness/prepare-subject.mjs /subject/overrides.json <fixtures>`
rewrites **only selected fixtures'** direct and transitive dependencies to mounted `file:`
tarballs via pnpm overrides, then installs them once with network access and scripts disabled.
The builder verifies the actual bytes and versions resolved by the consuming plugins, rejects
unused tarballs, and writes `prepared-subject.json` with per-fixture provenance. At runtime no
pnpm install or package override occurs; `--network none` remains safe. Each cell receives a
writable **copy** of the verified fixture `node_modules`, so builds cannot mutate the prepared
image or other cells. Summary, report, and per-cell evidence record the installed packages.

`@posthog/cli` in the tarball manifest is its npm shim, not the CLI executable. The harness
selects the CLI binary independently with `--cli`, `--cli-binary` or the baked versions. Pack the
npm shim matching the PR-built plugin's dependency when building the subject image; its networked
postinstall is intentionally skipped. The posthog-js pack job stages the dependency closure
for the smoke fixtures and that shim in the build context.

### Legacy runtime overrides

`--overrides /subject/overrides.json` remains for existing consumers while they migrate. It can
accept named package tarballs or a `binaries.posthog-cli` executable; absent explicit fixture
tags/names it selects fixtures using those packages. It is **not** used by posthog-js CI. A
prepared image rejects runtime overrides to avoid mixing a verified installed graph with a
second installation. Prefer a prepared image for new package-override consumers.

## Reusable subject smoke workflow

`.github/workflows/subject-smoke.yml` is called from posthog-js with `subject-artifact`
and exactly one of `harness-source-ref` (build a temporary, unpublished harness image) or
`harness-image` (pull a published digest). Pin the reusable workflow and source checkout to
the **same** harness commit, for example:

```yaml
smoke:
    needs: pack
    uses: PostHog/error-tracking-harness/.github/workflows/subject-smoke.yml@<harness-commit>
    with:
        subject-artifact: error-tracking-subject
        harness-source-ref: <same-harness-commit>
```

Once a matching image is published, replace `harness-source-ref` with
`harness-image: ghcr.io/posthog/error-tracking-harness@sha256:<published-digest>`.

The artifact must contain `overrides.json` (package paths under
`/subject/`), `source.txt` (the caller's 40-character `github.sha`) and exactly the selected
`.tgz` files, all at its root. The workflow verifies provenance and rejects extra files, builds
one derivative image with the selected tarballs and installs dependencies with scripts disabled.
It runs **only** rollup-4, vite-8-autocapture, webpack-5.112, next-14, next-15,
next-16-webpack, next-16-turbopack and nuxt-4 against CLI 0.18.11, with one single-release smoke
case per applicable mode. Runtime is `--network none`;
the report and summary are uploaded when produced, full evidence on failure, and the report is
added to the job summary.
The harness repository's `run.yml` checks the same eight-fixture smoke suite against its pinned
packages. The full conformance matrix remains available when invoking `run.mjs` without filters.

Source-build mode does not push an image to any registry; it builds the pinned harness code
and PR-specific derivative on the caller's runner. Network access is confined to those image
builds; the smoke cells run offline. A fresh source build takes longer than pulling a published
image. The previous published 291c8246… digest lacks the new fixtures and cases; use source
mode until a matching base image is published. Do not use a moving image tag. The harness
`Image` workflow prints a digest to pin after publication.

## Fixture lifecycle

Every fixture declares `lifecycle.workspace`, `build.argv`, `outputs.root`, `runtime.driver`, and
`triggers` in `fixture.json`. Commands are argv arrays with an optional workspace-relative `cwd`,
`env` mapping and `timeoutMs`. Only `{work}`, `{host}` (mock origin), `{port}` (HTTP runtime),
`{releaseVersion}` and `{cliPath}` are substituted in argv/env values. No shell or package script
is inferred; use `sh -c` explicitly if needed. The harness supplies `POSTHOG_HARNESS_OPTIONS`,
`POSTHOG_HARNESS_HOST` and the selected CLI path in its scrubbed environment. For example, a
POSIX-shell lifecycle smoke fixture can build without `package.json` or `node_modules`:

```json
{
  "lifecycle": {
    "workspace": { "adapter": "command", "command": { "argv": ["sh", "-c", "mkdir -p dist"] } },
    "build": { "argv": ["sh", "-c", "printf 'artifact' > dist/main.js"] },
    "outputs": { "root": "dist" },
    "runtime": { "driver": "process" },
    "triggers": [{ "kind": "process", "command": { "argv": ["sh", "-c", "echo triggered"] }, "expects": ["entry"] }]
  }
}
```

The manifest also needs a `throws.entry` source marker for validation. This smoke example tests
preparation/build/runtime plumbing, **not** JS symbolication. Production JS fixtures use the
`node-modules` workspace adapter, which consumes the prepared fixture installation. A command-prepared fixture
with a selected package override fails without a compatible binding. Non-JS symbol collectors and
non-npm subject bindings are not yet implemented. Process triggers run explicit argv; HTTP
triggers declare startup, readiness and routes; browser triggers declare a page and served file
mapping, with immutable-asset replay available across releases.

## Fixtures and cases

Each `fixtures/<name>/` is a standalone pinned project with `fixture.json` declaring its plugin,
**tags**, build output, runtime and marked source lines that throw. Browser fixtures run in
Chromium. HTTP fixtures start their server and optionally open a client page; `immutable` replays
prior-release static assets to a later-release browser. Next and Nuxt fixtures exercise their
respective build integrations. `vite-8-autocapture` throws an uncaught browser error after the
installed `posthog-js` lazily loads its exception-autocapture script from the loopback mock;
it checks unhandled capture and symbolication without an external CDN. CLI-mode fixtures run
`posthog-cli` on plain built output. To add a fixture, commit its lockfile and update the
Dockerfile; add it to both smoke workflows only if it belongs in the fixed smoke suite, then run
`pnpm check`.

The active cases under `harness/cases/` assert one shared healthy-upload, event-mode contract.
Every successful build must produce the declared exceptions, finished decodable symbol sets and
a release ID on **each** server/browser event; crashes resolve to the declared source and line.
Successive builds must each run and resolve, retain comparable chunk identities even if filenames
change, and re-resolve the first release's saved exceptions against the final upload. A fixture's
`volatileChunks` may exclude only inherently release-dependent generated assets; excluding all
checked chunks fails. Map cleanup, transport and release metadata have case-specific assertions,
but no case accepts a missing release, an unresolved error, a plugin-age floor or an unagreed
fault outcome. Recorded defects should be fixed in the integration, not turned into expected
passes.

A cell copies the fixture to a temporary workspace, replaces only named override packages, runs
a scrubbed build against a fresh loopback mock, executes its runtime, collects `evidence.json`,
and judges that data without reading the workspace. Failing workspaces and logs are retained for
diagnosis. The Docker image bakes fixture lockfiles and CLI versions from `cli-versions.txt` so
matrix runs can remain offline.
