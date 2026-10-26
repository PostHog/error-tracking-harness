# Portable lifecycle migration baseline

`lifecycle-before.json` snapshots the tag-selected fixture/case/CLI plan and representative
per-release evidence for CLI, Rollup, Vite SRI browser, Next 15 HTTP+browser, and Nuxt HTTP runs.
`lifecycle-overrides.json` snapshots planning with a locally overridden Next/plugin and CLI.
The planning assertions in `lifecycle.test.mjs` compare the migrated fixtures against both plans.

The evidence projection records build/runtime statuses, emitted artifact paths, event names,
resolved sources and lines, runtime evidence keys, final-upload events and strict verdicts.
Content-hashed Next filenames and release IDs are not stable across independent builds; compare
artifact counts, event identities and release presence instead of exact hashes or temp paths.

After migration, targeted CLI, Rollup, Vite SRI, Nuxt and Next 15 cells produced the same stable
projections (build/runtime codes, chunk counts, event/source/line/release observations, evidence
keys and verdicts). Next 15 remains red for the same known assertion: no previous-release asset
was replayed on release 2. Do not turn that failure into an accepted expectation.
