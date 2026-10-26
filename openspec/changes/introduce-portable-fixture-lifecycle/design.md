## Context

See `proposal.md` and `specs/fixture-lifecycle/spec.md`. This change is planned after `enforce-shared-plugin-conformance`: its strict judge and coverage behavior must not be relaxed. At present `executeCase` always prepares `node_modules`, reads a `package.json` build script, infers output from `entry`, and dispatches on Node/HTTP/browser. `planMatrix` and validation use a fixed `mode` enum. `collectDist` and `subject.mjs` still parse JavaScript/npm artifacts; this proposal separates running fixtures from those format-specific collectors without pretending to support non-JS end-to-end symbolication yet.

## Goals / Non-Goals

**Goals:**
- Permit a non-Node program to be prepared, built, and run through the same lifecycle API as existing fixtures.
- Preserve the case options, mock, CLI steps, release loop, browser replay, saved evidence fields, and judge inputs for existing fixtures.
- Make manifest mistakes fail validation before expensive matrix execution.

**Non-Goals:**
- Making all non-JS formats diagnosable with the current JS collector.
- Replacing npm tarball overlays with Gradle, native, or mobile subject bindings; that is the next change.
- Moving the mock and judging requirements into fixture-specific scripts or making fixture scripts determine whether a test passes.

## Decisions

### A single manifest lifecycle, not framework branches

Add a required `lifecycle` object to `fixture.json` (and shared defaults) with `workspace`, `build`, `outputs`, `runtime`, and `triggers`. Commands use `argv: [executable, ...args]`, optional `cwd` and explicit environment mappings. A `workspace` selects the existing `node-modules` adapter (delegating to `prepareNodeModules`) or a declared preparation command; no implicit `package.json` lookup is allowed. `outputs.root` is the build root and existing include/ignore globs are kept for the JS collector. The `runtime` field selects `process`, `http`, `browser`, or `none` and carries its driver's details. `triggers` declares requests/pages or process commands and their expected throw names; the pre-existing `throws` map stays the source of expected source lines.

Illustrative Next shape (details finalized with migration tests):

```json
{
  "lifecycle": {
    "workspace": { "adapter": "node-modules" },
    "build": { "argv": ["node_modules/.bin/next", "build"] },
    "outputs": { "root": ".next" },
    "runtime": {
      "driver": "http",
      "start": { "argv": ["node_modules/.bin/next", "start", "-p", "{port}", "-H", "127.0.0.1"] },
      "ready": { "path": "/" },
      "browser": { "page": "/client", "urlPrefix": "/_next/", "root": ".next" }
    },
    "triggers": [{ "kind": "http", "path": "/api/throw", "expects": ["entry", "lazy"] }, { "kind": "browser", "page": "/client", "expects": ["browser-entry", "browser-lazy"] }]
  }
}
```

The command runner replaces only documented tokens (e.g. `{port}`) in argv elements, never constructs shell source from user input. If a fixture genuinely needs a shell, it explicitly declares `sh -c` as its argv. This makes builds portable and arguments safe to reason about; arbitrary plugin-specific options continue to reach JS builds through `POSTHOG_HARNESS_OPTIONS` supplied by the JS adapter.

### Separate workspace preparation from collecting symbols

`executeCase` copies a fixture, creates its mock and release loop, then calls `prepareWorkspace`, `buildRelease`, and `executeRuntime`, returning normalized build/runtime observations to existing collectors. The Node adapter retains pnpm's symlink/copy behavior and tarball overlay; its bin directory is included only for Node fixtures. A declared command preparation path is invoked inside the scrubbed, offline workspace and must not assume `node_modules`. The POSIX-shell smoke test calls lifecycle functions with a command-prepared fixture to validate this path; it is not entered into the production JS symbolication matrix until a suitable binding and collector exist. Failing to bind a required subject remains an error as established by the first change.

### Make runtime drivers reusable, but keep evidence stable

A process driver runs explicit argv and records exit/logs; an HTTP driver starts argv, allocates a port, checks a configurable readiness URL, performs declared requests, and terminates the process group in `finally`; the browser driver serves declared output or attaches to HTTP, opens the requested page, captures errors/events, and optionally routes immutable assets to previous-release bytes. All drivers receive timeout, mock origin, release identity and case configuration from the central executor. Existing `runtime.code`, `requests`, `pageErrors`, `failedRequests`, `replayed`, `served` and `events` evidence keys remain; if a driver cannot run, it records a failure, not a missing optional runtime. `none` is explicit and limited to cases whose verdict permits it.

### Decouple case applicability from a closed framework list

Replace the validator's enumerated `mode` names with a validated, nonempty applicability label shared by case and fixture; map existing `plugin`, `cli`, `next`, `nuxt` labels unchanged to preserve matrix cardinality. A new label can be declared by a new fixture and its cases without touching an executor switch. Keep CLI post-build commands case-driven (the `cli` label), not a JavaScript build special case. CLI rewriter and JS artifact collection still use their current specialized code until the format-binding proposal.

### Compare migration at stable boundaries

Use metadata-only planning snapshots (fixture/case/CLI pairs) and unit driver tests before and after migration, then run targeted real fixtures for Node process, static browser, Next HTTP+browser and Nuxt HTTP. Compare emitted event names, artifact selection, release events and runtime evidence fields rather than exact bytes or unstable temp paths. The strict conformance verdict remains authoritative; an already failing plugin must continue failing for the same reason, not be rewritten as expected behavior.

## Risks / Trade-offs

- [Command declarations duplicate package scripts] → Document which command is canonical; keep a single explicit build argv in the manifest and test that it runs offline.
- [Generic tokens permit unexpected values] → Restrict substitution to known tokens with validation and do not evaluate strings through a shell implicitly.
- [HTTP processes or browser pages linger on failure] → Preserve detached-process-group teardown and browser/server `finally` cleanup, with tests for early exits and timeouts.
- [Non-Node smoke could imply unsupported symbolication] → Exercise only preparation/build/runtime plumbing; report symbol formats and subject binding as separate capabilities.
- [Migration occurs while earlier conformance work is unimplemented] → Apply the conformance change first, then rebase this proposal's implementation and confirm assertions/coverage have not regressed.

## Migration Plan

1. Land `enforce-shared-plugin-conformance` and record the current applicable matrix and evidence shape.
2. Implement/validate the lifecycle schema and command runner; add the POSIX-shell driver smoke test before moving production fixtures.
3. Move Node workspace preparation into its adapter and convert one Node fixture; prove metadata plan and output equivalence.
4. Convert browser, Next and Nuxt fixtures, shared defaults, and CLI-mode fixture; keep old runtime behavior only as temporary migration scaffolding, then delete the implicit build/Node fallback.
5. Rerun unit tests, fixture coverage, metadata planning, and targeted end-to-end fixtures. Real plugin failures remain failures; preserve logs and workspace evidence for diagnosis.

Rollback: revert lifecycle migration as a unit, restoring old fixture declarations. Never weaken the first change's judge or coverage rules for rollback convenience.
