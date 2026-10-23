// Turns what a build and its runtime left behind into evidence.json: plain data the judge reads.
// Every lookup that needs a source map happens here, so the judge needs none.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { originalPosition } from './symbol-data.mjs'

// The plugins are fail-soft: a failed upload leaves the build green, so the log is evidence too.
const PLUGIN_ERROR = /Error injecting PostHog|Error running PostHog|release resolve failed|Command failed with code|ERROR posthog_cli|panicked|\[posthog-rollup-plugin\] .*(?:failed|error)/i

// What posthog-cli reads chunk ids from: a `//# chunkId=` comment at the start of a line.
const CHUNK_ID_COMMENT = /(?:^|\n)\/\/# chunkId=(\S{1,128})/
const SOURCE_MAPPING_URL = /^[ \t]*\/\/# sourceMappingURL=/m

export function listDist(dist) {
    if (!existsSync(dist)) return []
    return readdirSync(dist, { recursive: true })
        .map(String)
        .filter((file) => /\.([mc]?js|map)$/.test(file))
        .sort()
}

/** The lines the fixture throws on, read from the source so the fixture stays the single source of truth. */
export function expectedThrows(work, fixture) {
    return Object.fromEntries(
        Object.entries(fixture.throws).map(([name, throwSpec]) => {
            const lines = readFileSync(path.join(work, throwSpec.file), 'utf8').split('\n')
            const line = lines.findIndex((candidate) => candidate.includes(throwSpec.marker)) + 1
            if (!line) throw new Error(`${fixture.name}: marker ${throwSpec.marker} not found in ${throwSpec.file}`)
            return [name, { ...throwSpec, line }]
        })
    )
}

function sameLayout(a, b) {
    const left = a.split('\n')
    const right = b.split('\n')
    return left.length === right.length && left.every((line, index) => line.length === right[index].length)
}

/**
 * Compares the stored minified source with the file on disk. In event mode a later release can
 * keep an earlier upload: the CLI leaves the release id and hashed chunk names out of the content
 * hash, so the stored copy may differ in those tokens while every column still lines up.
 */
function storedMatchesDisk(stored, disk, releaseIds, releaseId) {
    // The CLI uploads a chunk before --delete-after strips its sourceMappingURL line, which is
    // last in the file, so the stored copy may carry that one extra line without moving a position.
    const withoutMapComment = (code) => code.replace(/^\/\/# sourceMappingURL=[^\n]*\n?/gm, '')
    const normalized = withoutMapComment(releaseIds.reduce((source, previous) => source.replaceAll(previous, releaseId ?? previous), stored))
    const onDisk = withoutMapComment(disk)
    if (normalized === onDisk) return 'exact'
    if (sameLayout(normalized, onDisk)) return 'layout'
    return 'differs'
}

export function collectDist(work, dist) {
    const chunks = []
    const mapsLeft = []
    for (const file of listDist(dist)) {
        if (file.endsWith('.map')) {
            mapsLeft.push(file)
            continue
        }
        const absolute = path.join(dist, file)
        const code = readFileSync(absolute, 'utf8')
        chunks.push({
            file,
            absolute,
            relative: path.relative(work, absolute),
            code,
            chunkId: CHUNK_ID_COMMENT.exec(code)?.[1] ?? null,
            sourceMappingURL: SOURCE_MAPPING_URL.test(code),
        })
    }
    return { chunks, mapsLeft }
}

/**
 * Whether the CLI's on-disk rewrite kept every original byte. `pristine` maps file names to the
 * bytes the bundler wrote; the rewritten chunk must still contain them, minus the
 * sourceMappingURL line the CLI strips with --delete-after. A rewrite that keeps the original
 * length while prepending a snippet (posthog#122580) fails this.
 */
export function collectInjection(pristine, chunks) {
    return chunks.map((chunk) => {
        const original = pristine[chunk.file]
        if (original === undefined) return { file: chunk.file, intact: null }
        const body = original.replace(/^\/\/# sourceMappingURL=[^\n]*\n?/gm, '')
        return { file: chunk.file, intact: chunk.code.includes(body), grew: chunk.code.length - original.length }
    })
}

export function collectSymbolSets(chunks, api, releaseIds, releaseId) {
    return api.symbolSets.map((set) => {
        const chunk = chunks.find((candidate) => candidate.chunkId === set.chunk_id)
        return {
            chunkId: set.chunk_id,
            file: chunk?.file ?? null,
            finished: Boolean(set.finished),
            releaseId: set.release_id ?? null,
            transport: set.transport ?? null,
            decoded: Boolean(set.upload),
            storedMatchesDisk:
                chunk && set.upload ? storedMatchesDisk(set.upload.minifiedSource, chunk.code, releaseIds, releaseId) : null,
        }
    })
}

/** Resolves every captured exception against the chunks on disk and the symbol sets in `api`. */
export function collectEvents({ events, chunks, api, work, throws }) {
    const byPath = new Map(chunks.map((chunk) => [chunk.absolute, chunk]))
    // posthog-node reports paths relative to the cwd; ESM frames arrive as file:// URLs.
    const chunkOf = (frame) =>
        frame?.filename ? byPath.get(path.resolve(work, frame.filename.replace(/^file:\/\//, ''))) : undefined
    return events
        .filter((event) => event.event === '$exception')
        .map((event) => {
            const properties = event.properties ?? {}
            const exception = properties.$exception_list?.[0]
            const frames = exception?.stacktrace?.frames ?? []
            const crash = frames.at(-1)
            const crashChunk = chunkOf(crash)
            const set = crashChunk && api.symbolSets.find((candidate) => candidate.chunk_id === crashChunk.chunkId)
            const resolved =
                set?.finished && set.upload ? (originalPosition(set.upload.sourcemap, crash.lineno, crash.colno) ?? null) : null
            const name = properties.harness_case
            return {
                case: name,
                expected: throws[name] ?? null,
                type: exception?.type ?? null,
                value: exception?.value ?? null,
                stacktraceType: exception?.stacktrace?.type ?? null,
                releaseId: properties.$release_id ?? null,
                frames: frames.map((frame) => {
                    const chunk = chunkOf(frame)
                    return { filename: frame.filename, lineno: frame.lineno, colno: frame.colno, chunkId: frame.chunk_id ?? null, file: chunk?.file ?? null, expectedChunkId: chunk?.chunkId ?? null }
                }),
                crash: crash
                    ? {
                          file: crashChunk?.file ?? null,
                          chunkId: crash.chunk_id ?? null,
                          symbolSet: Boolean(set?.finished),
                          resolved,
                      }
                    : null,
            }
        })
}
