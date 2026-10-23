# Next.js fixtures

What `distIgnore` leaves out of the invariants, and why:

- `static/chunks/polyfills-*.js`: a prebuilt file Next copies in; it has no map and never did.
- `server/**/*-manifest.js`, `server/**/*_client-reference-manifest.js`: JSON-in-JS manifests, not
  code that throws.
- `static/chunks/app/**`, `static/chunks/next/dist/**`: **App Router client chunks and Next's builtin
  error pages get no source map from the webpack build**, on Next 15 and 16, with the published and
  the HEAD plugins alike, while `main-app-*.js`, the pages-router chunks and every server chunk do.
  Without a map there is no chunk id and no symbol set, so a browser exception thrown from such a
  chunk cannot be symbolicated. This is a finding to take to posthog-js, not a property of the
  harness; the exclusion keeps the fixtures judging the rest until it is understood.
