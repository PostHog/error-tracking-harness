# error-tracking-harness

End-to-end checks for PostHog error tracking symbol upload: real build plugins, real `posthog-cli`
releases, a mock PostHog, and an app that throws. One Docker image is the whole rig; each caller
mounts the one thing it changed.

```
source line ─▶ bundle (chunk id + release snippet) ─▶ posthog-cli ─▶ mock API + object store
                    │                                                     │ decoded symbol set
                    ▼                                                     ▼
               runtime throws ─▶ $exception ─▶ frame.chunk_id ─▶ map lookup ─▶ same source line
```

## Run it

```sh
# posthog-js: test the plugins you just changed against the baked CLIs
pnpm package                                          # writes target/*.tgz
docker run --rm --network none \
  -v "$PWD/target:/subject:ro" -v "$PWD/test-results:/artifacts" \
  ghcr.io/posthog/error-tracking-harness:latest

# posthog: test the CLI you just built against the baked plugins
docker run --rm --network none \
  -v "$PWD/target/release/posthog-cli:/mnt/posthog-cli:ro" -v "$PWD/test-results:/artifacts" \
  ghcr.io/posthog/error-tracking-harness:latest --cli-binary /mnt/posthog-cli

# nothing mounted: everything baked, the nightly baseline
docker run --rm --network none -v "$PWD/test-results:/artifacts" ghcr.io/posthog/error-tracking-harness:latest
```

Arguments narrow the matrix: `--cli 0.18.11,0.18.12`, `--fixtures vite-8`, `--cases 'baseline/*,upload/start-500'`,
`--plugins floor|latest|subject`. `--list` prints the cells without running them.
`--judge-only <run dir>` judges saved evidence again after a case changed.

Without Docker, from a checkout (CLIs are fetched into `~/.cache/error-tracking-harness` on demand):

```sh
pnpm install:fixtures
node harness/run.mjs --cli 0.18.11
```

Each run writes `report.md`, `summary.json`, and per cell `evidence.json`, `verdict.json`, the build
and runtime logs and every `dist/` under `test-results/run-*/<cli>/<fixture>/<case>/`.

## What is in the image

| Layer | Contents | Rebuilt when |
|---|---|---|
| 1 | each fixture's `node_modules` from its lockfile; every CLI in `cli-versions.txt` under `/opt/posthog-cli/<version>/` | a lockfile or the CLI list changes |
| 2 | fixtures, cases, the harness | anything else changes |

Each fixture pins the **latest** published plugin that is past the 7-day release cooldown and, as a
pnpm alias, the **floor**: the first version where event release mode is the default. `--plugins`
picks one, or overlays tarballs from `/subject`. Nothing in the image needs the network at run time;
run with `--network none` so neither the CLI's telemetry nor a stray install can leave.

## Fixtures

`fixtures/<name>/` is a complete project a user could `cd` into: `package.json`, lockfile, the
bundler config with the plugin wired the way its README shows, `src/` with the throwing app, and
`fixture.json` telling the harness the plugin name, the built entry, the runtime and the lines that
throw. The config reads the case's plugin options from one variable:

```js
const posthogOptions = JSON.parse(process.env.POSTHOG_HARNESS_OPTIONS)
```

To add a fixture, copy one, change the pins, `pnpm install`, commit the lockfile, add its `COPY`
lines to the `Dockerfile` and its name to `.github/workflows/run.yml`.

## Cases

`harness/cases/<group>/<name>.json`:

```json
{
    "options": { "sourcemaps": { "releaseMode": "event", "deleteAfterUpload": true } },
    "releases": 2,
    "fault": { "api": "bulk_start_upload", "status": 500 },
    "minCli": "0.18.11",
    "expect": {
        "build": { "@posthog/webpack-plugin": "green", "@posthog/rollup-plugin": "fails" },
        "maps": { "@posthog/webpack-plugin": "deleted", "@posthog/rollup-plugin": "kept-hidden" },
        "symbols": "none",
        "events": "unresolved"
    }
}
```

- `options` merge into the defaults the harness passes (`host`, keys, `cliBinaryPath`, release name
  and version); `null` removes a default.
- `releases` builds the fixture that many times as successive releases.
- `fault` makes the mock API misbehave: `auth`, `releases`, `bulk_check_upload`, `bulk_start_upload`,
  `bulk_finish_upload`, `object_store`, with a `status` and optional error `code`.
- `minCli` skips the case on older CLIs; `minPlugin`, keyed by plugin name, on older plugins.
- `expect` values are a string, or an object keyed by plugin name since the plugins disagree on
  purpose: `build` green|fails, `maps` deleted|kept-hidden|kept-visible, `symbols` all|none,
  `events` resolved|unresolved|no-release, `reuploads` chunk count per plugin for the second
  release, with its own `minCli`.

Everything not named in `expect` is an invariant checked on every green release: each emitted chunk
carries a chunk id; each id has a finished, decodable symbol set whose stored source lines up with
the file on disk; the release exists and the symbol sets are bound to it or not according to the
mode; every in-bundle frame carries its chunk id; the crash frame (the last one) resolves through
the uploaded map to the line that threw, with `sourcesContent`; chunk ids stay stable across
releases in event mode and change in symbol-set mode; and the first release's exceptions still
resolve after the second release's upload overwrote what the server holds.

## How a cell runs

1. Copy the fixture to a temporary directory; its `node_modules` is symlinks into the installed
   tree, with the selected plugin swapped in.
2. Start a fresh mock API and object store on loopback, with the case's fault armed.
3. Run the fixture's `build` script with `node_modules/.bin` on `PATH` and nothing else from the
   caller's environment: a temporary `HOME`, no `GITHUB_*`, no `VERCEL_*`, no `POSTHOG_*`. Any of
   those would change which release the CLI resolves.
4. Run the built entry in Node against the mock.
5. Collect `evidence.json`: build exit and log classification, `dist` listing with chunk ids and
   `sourceMappingURL` flags, the API transcript, decoded symbol-set metadata, and the captured
   exceptions with every crash frame already resolved through the stored maps.
6. Judge the evidence (`harness/judge.mjs`, pure) and write `verdict.json`.

## Behaviours the harness pins

These are by design today, and each is a case or an invariant so a change shows up:

- The plugins are fail-soft in different ways. A failed upload leaves a **webpack** build green with
  the maps deleted; it **fails** a rollup or vite build and leaves the hidden maps in `dist`.
- Event mode renames every chunk on every release with all three bundlers: the release id is in the
  chunk's bytes and the content hash covers it. Unchanged code still busts the browser cache.
- From CLI 0.18.11 on, a new release re-uploads only chunks whose bytes changed for another reason.
  Webpack's runtime chunk does, because it spells lazy chunk names by concatenation. Older CLIs
  re-upload everything, every release.
- Rollup and vite keep a stale copy of the entry chunk server-side: it still imports the previous
  lazy file name. Columns still line up because hashed names have a fixed length, and the harness
  checks exactly that.
- Snippet text drifting between `@posthog/plugin-utils` and the CLI breaks nothing visible: the CLI
  stops recognising the snippet and every chunk re-uploads. Only the re-upload count catches it.

## Roadmap

Fixtures: webpack below 5.104 (no debug ids), rollup 3, vite 7 (rollup, not rolldown), Next 14/15/16
with webpack and Turbopack, Nuxt 4 with Nitro, then React Native Hermes, Android Gradle, iOS, native.
Runtime: Chromium for client bundles. Cases: the rest of the fault and cleanup matrix (401, 403 on the
check endpoint, `content_hash_mismatch`, stale maps from a previous build, custom map file names, no
`sourcesContent`, directives and hashbangs, SRI). Resolution: the real symbolicator from
`PostHog/posthog` once a second symbol type arrives.
