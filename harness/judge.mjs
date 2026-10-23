// Decides whether a case passed from its evidence alone. Pure: no files, no network, so saved
// evidence can be judged again after a case changes.
//
// `expect` vocabulary (each value may be a string, or an object keyed by plugin name):
//   build:     green | fails                      default green
//   chunkIds:  all | none                         default all (none: injection never ran)
//   maps:      deleted | kept-hidden | kept-visible  default deleted
//   symbols:   all | none                         default all
//   events:    resolved | unresolved | no-release  default resolved
//   transport: PUT | POST                          how every symbol set reached the object store
//   release:   { name, version }                   the release row the CLI created; version 'commit'
//                                                  means the HEAD of the case's git checkout
//   metadataFree: [string]                         text that must not appear in release metadata
//   reuploads: { minCli?, minPlugin?, <plugin>: <count> }  chunks uploaded again by the second release
// Everything not named in `expect` is an invariant checked on every green release.
import { cliAtLeast, pluginAtLeast } from './plan.mjs'

function pick(value, plugin, fallback) {
    if (value === undefined) return fallback
    if (typeof value === 'object' && value !== null) return value[plugin] ?? value.default ?? fallback
    return value
}

export function judge(evidence, kase) {
    const failures = []
    const plugin = evidence.plugin.name
    const expect = kase.expect ?? {}
    const expected = {
        build: pick(expect.build, plugin, 'green'),
        chunkIds: pick(expect.chunkIds, plugin, 'all'),
        maps: pick(expect.maps, plugin, 'deleted'),
        symbols: pick(expect.symbols, plugin, 'all'),
        events: pick(expect.events, plugin, 'resolved'),
    }
    const mode = kase.options?.sourcemaps?.releaseMode ?? 'event'
    const green = []

    evidence.releases.forEach((release, index) => {
        const tag = `release ${release.releaseVersion}`
        const build = release.build.code === 0 ? 'green' : 'fails'
        if (build !== expected.build) failures.push(`${tag}: build ${build}, expected ${expected.build}`)
        if (build === 'fails') return
        green.push(release)

        if (expected.symbols === 'all' && release.build.pluginError) {
            failures.push(`${tag}: the plugin reported an error in the build log`)
        }
        if (release.mockErrors.length) failures.push(`${tag}: mock errors: ${release.mockErrors.join('; ')}`)

        const maps =
            release.mapsLeft.length === 0 ? 'deleted' : release.chunks.some((chunk) => chunk.sourceMappingURL) ? 'kept-visible' : 'kept-hidden'
        if (maps !== expected.maps) failures.push(`${tag}: maps ${maps} (${release.mapsLeft.join(', ') || 'none'}), expected ${expected.maps}`)

        if (release.chunks.length < 2) failures.push(`${tag}: expected an entry and a lazy chunk, found ${release.chunks.map((chunk) => chunk.file)}`)
        for (const chunk of release.chunks) {
            if (expected.chunkIds === 'all' && !chunk.chunkId) failures.push(`${tag}: ${chunk.file} has no chunk id`)
            if (expected.chunkIds === 'none' && chunk.chunkId) failures.push(`${tag}: ${chunk.file} carries a chunk id although injection should not have run`)
        }

        const finished = release.symbolSets.filter((set) => set.finished)
        if (expected.symbols === 'all') {
            if (expected.events !== 'no-release' && !release.releaseId) failures.push(`${tag}: no release was created`)
            if (expect.release && release.release) {
                const want = { ...expect.release }
                if (want.version === 'commit') want.version = evidence.git?.commit
                if (want.name !== undefined && release.release.name !== want.name) failures.push(`${tag}: release name ${release.release.name}, expected ${want.name}`)
                if (want.version !== undefined && release.release.version !== want.version) failures.push(`${tag}: release version ${release.release.version}, expected ${want.version}`)
            }
            if (expect.metadataFree && release.release) {
                const metadata = JSON.stringify(release.release.metadata)
                for (const text of expect.metadataFree) if (metadata.includes(text)) failures.push(`${tag}: release metadata contains ${JSON.stringify(text)}`)
            }
            for (const chunk of release.chunks) {
                const set = finished.find((candidate) => candidate.chunkId === chunk.chunkId)
                if (!set) {
                    failures.push(`${tag}: no finished symbol set for ${chunk.file}`)
                    continue
                }
                if (!set.decoded) failures.push(`${tag}: symbol set for ${chunk.file} does not decode`)
                if (set.storedMatchesDisk === 'differs') failures.push(`${tag}: stored ${chunk.file} no longer lines up with disk`)
                if (set.storedMatchesDisk === 'layout' && mode !== 'event') failures.push(`${tag}: stored ${chunk.file} differs from disk`)
                if (mode === 'event' && set.releaseId !== null) failures.push(`${tag}: event mode bound ${chunk.file} to a release`)
                if (mode === 'symbol-set' && set.releaseId !== release.releaseId) failures.push(`${tag}: ${chunk.file} not bound to the release`)
            }
            if (expect.transport) {
                for (const set of finished) {
                    if (set.transport !== expect.transport) failures.push(`${tag}: ${set.file} uploaded over ${set.transport}, expected ${expect.transport}`)
                }
            }
        } else if (finished.length) {
            failures.push(`${tag}: ${finished.length} symbol sets finished, expected none`)
        }

        if (!release.runtime) {
            failures.push(`${tag}: the bundle was not run`)
            return
        }
        if (release.runtime.code !== 0) failures.push(`${tag}: the bundle exited with ${release.runtime.code}`)
        judgeEvents(release.events, { tag, expected: expected.events, mode, release, throws: evidence.throws }, failures)

        if (index === 1 && expect.reuploads) {
            const count = expect.reuploads[plugin]
            if (count !== undefined && cliAtLeast(evidence.cli, expect.reuploads.minCli) && pluginAtLeast(evidence.plugin, expect.reuploads.minPlugin)) {
                if (release.uploadedChunkIds.length !== count) {
                    failures.push(`${tag}: re-uploaded ${release.uploadedChunkIds.length} chunks, expected ${count}`)
                }
            }
        }
    })

    if (green.length === 2 && expected.symbols === 'all') {
        const [first, second] = green.map((release) => release.chunks.map((chunk) => chunk.chunkId).sort())
        const same = JSON.stringify(first) === JSON.stringify(second)
        if (mode === 'event' && !same) failures.push('event mode: chunk ids changed between releases')
        if (mode === 'symbol-set' && same) failures.push('symbol-set mode: chunk ids reused across releases')
        // Event mode uploads with force, so a later release can overwrite a symbol set an older
        // deployment still points at. Its exceptions must still resolve against what is stored now.
        if (evidence.afterFinalUpload && expected.events !== 'unresolved') {
            judgeEvents(
                evidence.afterFinalUpload.events,
                { tag: 'release 1 after the last upload', expected: expected.events, mode, release: green[0], throws: evidence.throws },
                failures
            )
        }
    }

    return { ok: failures.length === 0, failures }
}

function judgeEvents(events, { tag, expected, mode, release, throws }, failures) {
    for (const name of Object.keys(throws)) {
        const event = events.find((candidate) => candidate.case === name)
        if (!event) {
            failures.push(`${tag}: no $exception for ${name}`)
            continue
        }
        const label = `${tag} ${name}`
        if (event.type !== throws[name].type) failures.push(`${label}: type ${event.type}, expected ${throws[name].type}`)
        if (event.value !== throws[name].value) failures.push(`${label}: value ${JSON.stringify(event.value)}`)
        if (event.stacktraceType !== 'raw') failures.push(`${label}: stacktrace type ${event.stacktraceType}`)
        const ours = event.frames.filter((frame) => frame.file)
        if (!ours.length) failures.push(`${label}: no frame points into dist (${event.frames.map((frame) => frame.filename)})`)
        for (const frame of ours) {
            if (frame.chunkId !== frame.expectedChunkId) failures.push(`${label}: ${frame.file}:${frame.lineno} has chunk_id ${frame.chunkId}`)
        }
        if (!event.crash?.file) {
            failures.push(`${label}: the last frame is not inside dist`)
            continue
        }
        if (expected === 'unresolved') {
            if (event.crash.symbolSet) failures.push(`${label}: resolved although no symbols were expected`)
            continue
        }
        const resolved = event.crash.resolved
        if (!resolved) {
            failures.push(`${label}: ${event.crash.file} does not resolve (symbol set: ${event.crash.symbolSet})`)
        } else {
            if (!resolved.source?.endsWith(throws[name].file)) failures.push(`${label}: resolved to ${resolved.source}`)
            if (resolved.line !== throws[name].line) failures.push(`${label}: resolved to line ${resolved.line}, threw on ${throws[name].line}`)
            if (!resolved.hasContent) failures.push(`${label}: map carries no sourcesContent`)
        }
        const wantRelease = mode === 'event' && expected === 'resolved' ? release.releaseId : null
        if (event.releaseId !== wantRelease) failures.push(`${label}: $release_id ${event.releaseId}, expected ${wantRelease}`)
    }
}
