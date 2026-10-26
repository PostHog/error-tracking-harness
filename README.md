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

The Docker image contains pinned fixture dependencies and CLIs. No network access is required at
run time; use `--network none` and pin the image digest in CI. With no filters, the full conformance
matrix runs. `--fixtures` selects names; `--tags` selects any matching tag (OR); both together
intersect. `--cases` accepts comma-separated globs. `--cli` selects versions; `--cli-binary` uses
a local executable instead. `--list` previews the selection without installing fixture packages
or downloading CLIs. Unknown or empty selections fail. `--judge-only <run-dir>` rejudges saved
`evidence.json` files against the current case catalog.

Every selected applicable fixture/case pair must execute at least one cell; CLI-incompatible skips
never count as coverage. The exit status is nonzero for uncovered pairs, zero executed cells, a
harness error or a failing verdict. `summary.json` and `report.md` include executed, passed,
failed, skipped, uncovered and selected fixtures/tags. Per-cell evidence, verdicts, build/runtime
logs and built files live under `<artifacts>/<cli>/<fixture>/<case>/` (by default a new
`test-results/run-*` directory).

## Local overrides (posthog-js and framework CI)

Build npm tarballs before starting the offline harness. An override manifest identifies **exactly**
which packages to replace and optionally a CLI binary. Paths are relative to the manifest:

```json
{
  "packages": {
    "@posthog/nextjs-config": "./nextjs-config.tgz",
    "next": "./next.tgz"
  },
  "binaries": { "posthog-cli": "./posthog-cli" }
}
```

Mount the manifest and artifacts into the image:

```sh
# posthog-js CI: first produce the package tarball(s) with pnpm package, then stage the manifest.
docker run --rm --network none \
  -v "$PWD/target:/subject:ro" -v "$PWD/test-results:/artifacts" \
  ghcr.io/posthog/error-tracking-harness@sha256:<pinned-digest> \
  --overrides /subject/overrides.json --tags next
# The workflow must treat this process's exit status as a required check.
```

A framework-only, plugin-only, combined or CLI-only override works. Unmentioned packages retain
fixture pins. For posthog-js PRs that pack `@posthog/core` alongside a plugin, include the already-
packed core tarball in the same manifest, for example:

```json
{
  "packages": {
    "@posthog/nuxt": "./nuxt.tgz",
    "@posthog/webpack-plugin": "./webpack-plugin.tgz",
    "@posthog/core": "./core.tgz"
  }
}
```

Mount all three tarballs under `/subject` with the manifest. The harness uses the fixture's
pruned pnpm store plus those tarballs to reinstall the affected dependency graph with `pnpm
install --offline`; it never fetches packages at run time. If the PR needs another dependency
absent from the image's store, pack and override that package too or update the image's pinned
lockfiles. `@posthog/cli` is an npm dependency/shim, distinct from the CLI executable selected
with `binaries.posthog-cli` or `--cli-binary`. Only use the binary field for the executable.
Installed paths and versions in per-cell evidence/report are verified against tarball contents;
requested but failed overrides are not listed as applied.

Without `--fixtures` or `--tags`, package overrides select fixtures depending on at least one
named package; a CLI-only override selects all fixtures. With filters, every named
override must be used in the selected fixtures. Tarball identity and paths, CLI executability and
reported version, dependency compatibility and binding support are checked: no missing override
silently falls back to the pinned copy. An isolated pnpm layout that cannot accept an override
fails when selected, rather than being skipped. `--cli` and `--cli-binary` conflict with a CLI
manifest override. Evidence and reports record the applied tarballs, plugin/framework versions,
and CLI path/version. A new consumer workflow in `posthog-js` must mount its PR-built tarball(s),
pass `--overrides /subject/overrides.json --tags <relevant-tag>` and require the harness exit code.

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
`node-modules` workspace adapter, which applies named npm overrides. A command-prepared fixture
with a selected package override fails without a compatible binding. Non-JS symbol collectors and
non-npm subject bindings are not yet implemented. Process triggers run explicit argv; HTTP
triggers declare startup, readiness and routes; browser triggers declare a page and served file
mapping, with immutable-asset replay available across releases.

## Fixtures and cases

Each `fixtures/<name>/` is a standalone pinned project with `fixture.json` declaring its plugin,
**tags**, build output, runtime and marked source lines that throw. Browser fixtures run in
Chromium. HTTP fixtures start their server and optionally open a client page; `immutable` replays
prior-release static assets to a later-release browser. Next and Nuxt fixtures exercise their
respective build integrations. CLI-mode fixtures run `posthog-cli` on plain built output. To add a
fixture, commit its lockfile, update the Dockerfile and CI fixture list, then run `pnpm check`.

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
