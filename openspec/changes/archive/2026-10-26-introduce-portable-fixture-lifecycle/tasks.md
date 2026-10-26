## 1. Establish lifecycle contract and migration baseline

- [x] 1.1 Apply `enforce-shared-plugin-conformance` first, then snapshot tag-selected fixture/case/CLI matrices (with plugin/framework/CLI overrides) and representative evidence for Node, browser, Next, Nuxt and CLI fixtures.
- [x] 1.2 Add and validate required `lifecycle.workspace`, `build.argv`, `outputs.root`, `runtime`, and `triggers` in `harness/validate.mjs`; reject missing commands, invalid driver/trigger combinations, and unknown command tokens before execution.
- [x] 1.3 Replace the closed framework `mode` enum with a validated applicability label while preserving existing matching and selected-coverage behavior; add metadata-planning tests for old and new labels.

## 2. Run portable commands and drivers

- [x] 2.1 Extract an argv-based sandboxed command runner with explicit cwd, environment, documented token substitution, timeouts, log capture, and error propagation; test quoting, missing commands, and scrubbed environment.
- [x] 2.2 Extract workspace preparation so the Node adapter preserves named plugin/framework tarball overrides and the selected CLI binary, while a declared command-based fixture prepares without Node; test both with a POSIX-shell smoke fixture and assert unsupported overrides fail.
- [x] 2.3 Extract a process driver that executes a declared trigger argv and records the same runtime/evidence shape; test success and nonzero exit without a Node entrypoint.
- [x] 2.4 Extract an HTTP driver with declared start/readiness/trigger/shutdown, dynamic port and process-group cleanup; test readiness timeout, early exit, and cleanup.
- [x] 2.5 Adapt the static/attached browser driver to declared pages and URL-to-file mapping, retaining event capture, old immutable-asset replay, and cleanup; test missing events, replay and page errors.

## 3. Migrate existing fixtures without changing verdict inputs

- [x] 3.1 Rework `harness/execute.mjs` to invoke the lifecycle phases once per cell and per release as specified while preserving `evidence.json`, CLI post-build processing, the mock API, release selection, and judge inputs.
- [x] 3.2 Migrate process fixtures (webpack, rollup, vite and CLI) to explicit commands/output roots and verify a targeted Node fixture preserves event and artifact evidence.
- [x] 3.3 Migrate browser and SRI fixtures to the browser driver; verify a targeted fixture preserves served-path mapping, browser event capture and integrity evidence.
- [x] 3.4 Migrate the shared Next defaults, Next variants and Nuxt fixture to HTTP startup/triggers and optional Chromium; verify a two-release replay and server/browser event evidence without framework-specific executor branches.
- [x] 3.5 Delete the implicit package-script build, inferred Node runtime, and closed-framework execution fallbacks once all fixtures and tests use lifecycle declarations.

## 4. Verify the boundary and document it

- [x] 4.1 Check before/after any-tag fixture selection, fixture/case/CLI plans, applied override identities, artifact lists, runtime/evidence fields and strict verdicts; retain genuine plugin failures instead of changing expectations.
- [x] 4.2 Document the new `fixture.json` lifecycle and an offline POSIX-shell smoke example; explicitly state that non-JS symbol collectors and non-npm subject bindings are not yet implemented.
- [x] 4.3 Run `pnpm check`, `git diff --check`, lifecycle smoke tests, metadata planning and targeted real-fixture cases; diagnose any preparation/runtime regression before completion.
