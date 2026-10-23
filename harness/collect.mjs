// Turns what a build and its runtime left behind into evidence.json: plain data the judge reads.
// Every lookup that needs a source map happens here, so the judge needs none.
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { originalPosition } from './symbol-data.mjs'

// The plugins are fail-soft: a failed upload leaves the build green, so the log is evidence too.
const PLUGIN_ERROR = /Error injecting PostHog|Error running PostHog|release resolve failed|Command failed with code|ERROR posthog_cli|panicked|\[posthog-rollup-plugin\] .*(?:failed|error)/i

// What posthog-cli reads chunk ids from: a `//# chunkId=` comment at the start of a line, or the
// `//# debugId=` comment a bundler with native debug ids writes (Turbopack, webpack >= 5.104).
const CHUNK_ID_COMMENT = /(?:^|\n)\/\/# (?:chunkId|debugId)=(\S{1,128})/
const SOURCE_MAPPING_URL = /^[ \t]*\/\/# sourceMappingURL=/m

const DEFAULT_GLOBS = ['**/*.js', '**/*.mjs', '**/*.cjs', '**/*.map']

/** The built files a fixture wants judged: `distGlobs` and `distIgnore` from fixture.json, or every script and map. */
export function listDist(dist, fixture = {}) {
    if (!existsSync(dist)) return []
    const globs = fixture.distGlobs ?? DEFAULT_GLOBS
    const ignore = fixture.distIgnore ?? []
    return readdirSync(dist, { recursive: true })
        .map(String)
        .map((file) => file.split(path.sep).join('/'))
        .filter((file) => globs.some((glob) => path.matchesGlob(file, glob)) && !ignore.some((glob) => path.matchesGlob(file, glob)))
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

// posthog-cli logs every source pair it leaves out ("Skipping <path>: <reason>" at debug level):
// stubs with empty maps, files without an id, oversized chunks. Those files are evidence of the
// CLI's choice, not a failure of injection, so the judge exempts them from the id and symbol-set
// invariants while the events still have to resolve.
export function cliSkips(log, work) {
    const skipped = new Map()
    const bySize = []
    // The CLI prints real paths; the workspace may be reached through a symlink (/var on macOS).
    const roots = [...new Set([work, realpathSync(work)])]
    for (const match of (log ?? '').matchAll(/Skipping (\/\S+?\.(?:[mc]?js)(?:\.map)?)(?::| because| -) ?([^\n]*)/g)) {
        const named = match[1]
        const absolute = named.replace(/\.map$/, '')
        const root = roots.find((candidate) => absolute.startsWith(candidate + path.sep))
        if (!root) continue
        const reason = match[2].trim().slice(0, 160)
        skipped.set(path.relative(root, absolute), reason)
        // A map not named after its chunk (Turbopack): the line still says how big the chunk was.
        const size = /sibling JS is (\d+) bytes/.exec(match[2])
        if (named.endsWith('.map') && size) bySize.push({ dir: path.relative(root, path.dirname(named)), mapName: path.basename(named), size: Number(size[1]), reason })
    }
    return { skipped, bySize }
}

// Ties a chunk to the CLI's skip line for it: by its own path, by the map its sourceMappingURL
// names, or, when --delete-after already stripped that comment, by the chunk size the skip line
// reports (before or after the stripped comment line).
const MAP_COMMENT = /^\/\/# sourceMappingURL=(\S+)\s*$/m
function skipFor({ skipped, bySize }, work, absolute, code) {
    const relative = path.relative(work, absolute)
    const direct = skipped.get(relative)
    if (direct) return direct
    const mapName = MAP_COMMENT.exec(code)?.[1]
    if (mapName && !/^(?:data:|https?:|\/\/)/.test(mapName)) {
        const viaMap = skipped.get(path.relative(work, path.join(path.dirname(absolute), mapName.replace(/\.map$/, ''))))
        if (viaMap) return viaMap
    }
    const size = Buffer.byteLength(code)
    const dir = path.dirname(relative)
    const match = bySize.find((entry) => entry.dir === dir && [0, 1, 2].some((extra) => entry.size === size + `//# sourceMappingURL=${entry.mapName}`.length + extra))
    return match ? match.reason : null
}

export function collectDist(work, dist, fixture, log) {
    const chunks = []
    const mapsLeft = []
    const skipped = cliSkips(log, work)
    for (const file of listDist(dist, fixture)) {
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
            cliSkipped: skipFor(skipped, work, absolute, code),
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

/**
 * Subresource Integrity: every `integrity` attribute in the built HTML must match the bytes of
 * the file it names, as a browser would check them. A plugin that rewrote a chunk after the SRI
 * plugin hashed it would leave a page the browser refuses to run.
 */
export function collectIntegrity(work, fixture) {
    if (!fixture.integrity) return null
    const htmlPath = path.join(work, fixture.integrity)
    if (!existsSync(htmlPath)) return []
    const html = readFileSync(htmlPath, 'utf8')
    const base = path.dirname(htmlPath)
    const checks = []
    // Attribute values may be quoted or, after HTML minification, bare.
    const attribute = (tag, name) => {
        const match = new RegExp(`\\b${name}=(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`).exec(tag)
        return match ? (match[1] ?? match[2] ?? match[3]) : undefined
    }
    for (const tag of html.matchAll(/<(?:script|link)\b[^>]*>/gi)) {
        const src = attribute(tag[0], 'src') ?? attribute(tag[0], 'href')
        const integrity = attribute(tag[0], 'integrity')
        if (!src || !integrity) continue
        const file = path.join(base, src.replace(/^\//, ''))
        const results = integrity.split(/\s+/).map((entry) => {
            const [algorithm, expected] = entry.split('-')
            const actual = existsSync(file) ? createHash(algorithm).update(readFileSync(file)).digest('base64') : null
            return { algorithm, ok: actual === expected }
        })
        checks.push({ src, file: path.relative(work, file), ok: results.every((result) => result.ok), algorithms: results.map((result) => result.algorithm) })
    }
    return checks
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
export function collectEvents({ events, chunks, api, work, throws, served }) {
    const byPath = new Map(chunks.map((chunk) => [chunk.absolute, chunk]))
    // posthog-node reports paths relative to the cwd; ESM frames arrive as file:// URLs; a browser
    // reports the URL the chunk was served from, which maps back into the served directory.
    const chunkOf = (frame) => {
        if (!frame?.filename) return undefined
        if (served && frame.filename.startsWith(served.origin + '/')) {
            let pathname = decodeURIComponent(new URL(frame.filename).pathname)
            if (served.strip && pathname.startsWith(served.strip)) pathname = pathname.slice(served.strip.length)
            return byPath.get(path.join(served.root, pathname))
        }
        return byPath.get(path.resolve(work, frame.filename.replace(/^file:\/\//, '')))
    }
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
