## Why

The harness assumes a fixture is a Node project: it builds through `package.json`, prepares `node_modules`, and runs a Node entry or special-cased server/browser paths. Those assumptions make a new language or framework require changes to the core executor, even though every fixture should offer the same build/run/trigger/artifact lifecycle. This proposal follows `enforce-shared-plugin-conformance`: the conformance judge stays authoritative while execution becomes portable.

## What Changes

- **BREAKING:** Give every fixture an explicit, validated lifecycle declaration: how to prepare its workspace, build each release, locate outputs, start and stop its app (if needed), and trigger declared errors. Commands are executable/argument arrays, not implicitly `package.json` scripts or a Node binary.
- Make process, HTTP, and Chromium reusable runtime drivers. Drivers accept declarative commands, readiness probes, trigger actions, served URL-to-file mappings, and previous-release asset replay rather than identifying Next, Nuxt, or another framework in executor code.
- Move the first change's named npm plugin/framework override preparation into a JavaScript-specific adapter. A fixture can use an alternative preparation command without going through `node_modules`; native or other ecosystem bindings are deferred. Preserve the existing local CLI binary override.
- Keep the mock API, release loop, evidence schema, collector, judge, tag-based selection and local override behavior unchanged. Migrate existing JS/Next/Nuxt/CLI fixtures to the lifecycle contract with regression tests showing the same applicable matrix and verdict inputs.
- Add a tiny POSIX-shell (non-Node) lifecycle smoke fixture used by harness tests, without claiming to symbolicate non-JS artifacts. Accept declarative fixture/case applicability labels rather than hardcoded framework names so future frameworks need not add an executor branch.
- Defer other symbol formats, language-specific subject bindings and collectors, and any changes to conformance expectations to later proposals.

## Capabilities

### New Capabilities

- `fixture-lifecycle`: A declarative, language-neutral workspace/build/runtime/trigger/output interface that the harness executes under its existing sandbox and translates into the existing evidence flow.

### Modified Capabilities

None; no archived OpenSpec capability requirement is modified. The unarchived conformance proposal remains the prerequisite and its judge contract is not changed here.

## Impact

- `harness/execute.mjs`, `harness/validate.mjs`, `harness/plan.mjs`, the JavaScript preparation in `harness/subject.mjs`, `fixtures/*/fixture.json` and shared fixture defaults, harness tests, fixture documentation and examples.
- Fixture authors must declare commands instead of relying on the implicit `package.json`/Node entry fallback. CLI invocations from the first change (`--tags`, `--overrides`) and verdict semantics remain stable; applied-dependency provenance continues to be recorded in evidence.
- Implementation should follow the conformance change, not relax strict assertions to preserve green CI while migrating fixtures.
