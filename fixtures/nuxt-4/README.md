Nuxt 4 with `@posthog/nuxt`. The module runs posthog-cli on disk: `inject` then `upload` over
`.output/public` before Nitro writes its asset manifest, and over `.output/server` in the `close`
hook. It passes no release mode, so the CLI's default applies: event from posthog-cli 0.18.0,
which is this fixture's CLI floor.

Nitro ignores the hidden-map setting for the server bundle and writes `sourceMappingURL`
comments there; the client build honours it. Cases judge the two with `mapsBy`.

Nitro writes each public asset's `etag` and `mtime` into `server/chunks/nitro/nitro.mjs`, and its
`virtual/styles.mjs` is not ordered deterministically, so those two chunks (`volatileChunks`) may
change between identical builds; every other chunk keeps its id across releases.
