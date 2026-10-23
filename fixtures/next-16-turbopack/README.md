`next build` on Next 16, Turbopack. With event release mode `@posthog/nextjs-config` turns on
Turbopack's native debug ids and uploads from `runAfterProductionCompile`; in symbol-set mode it
runs `posthog-cli sourcemap process` over `.next`.

Turbopack emits page stubs (`server/app/**/page.js`, `server/pages/**`) and some internal chunks
with empty maps, and its runtime (`[turbopack]_runtime.js`) with a map but no debug id. The CLI
logs each of those as skipped (posthog#70235), and the harness reads those lines: a file the CLI
skipped is exempt from the id and symbol-set invariants, while the exceptions must still resolve,
which they do through `server/chunks/[root-of-the-server]__*.js`, where the API route's code lives.

`static/chunks/**` ids are optional: Turbopack emits a few client files without a map (page
loaders of a few hundred bytes and the polyfills bundle). Any that carries a debug id must still
have its symbol set.

Behaviour this fixture pins on the native debug id path (event mode), with CLI 0.18.11 or newer:
the plugin deletes the maps but leaves every `sourceMappingURL` comment in place
(`maps: dangling`), and no runtime module sets `_posthogReleaseId`, so an externalized
`posthog-node` reports no release on its exceptions (`events: no-release`) although every frame
resolves.
