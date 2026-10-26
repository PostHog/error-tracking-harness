# Next.js fixtures

What `distIgnore` leaves out of the invariants, and why:

- `static/chunks/polyfills-*.js`: a prebuilt file Next copies in; it has no map and never did.
- `server/**/*-manifest.js`, `server/**/*_client-reference-manifest.js`: JSON-in-JS manifests, not
  code that throws.
- `static/chunks/app/**`, `static/chunks/next/dist/**` have optional ids: the near-empty client
  reference chunks of server-component pages and layouts, and Next's builtin error pages, come out
  of the webpack build without a map, so nothing is injected there. A client page with real code
  (`app/client`) does get a map, an id and a symbol set, and is judged like any other chunk.

`volatileChunks` on the webpack fixtures: the webpack runtime chunks, into which `nextjs-config`
compiles the release id before hashing, and the SSR bundle of the client page
(`server/app/client/page.js`), which contains posthog-js and therefore that same compiled release id.
On Turbopack only the SSR chunk of the client page is exempted; static client chunks remain in the
cross-release chunk-ID multiset even when their content-hashed filenames change. A genuine plugin
failure is reported rather than exempted by a broad static-chunk pattern.
