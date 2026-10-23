// Reads what posthog-cli uploads (rust/common/symbol_data in PostHog/posthog) and resolves a
// frame through the uploaded map, the way the symbolication service would.
import { zstdDecompressSync } from 'node:zlib'

const MAGIC = Buffer.from('posthog_error_tracking')
const SOURCE_AND_MAP = 2

export function decodeSymbolSet(bytes) {
    if (!bytes.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('bad magic')
    let at = MAGIC.length
    const version = bytes.readUInt32LE(at)
    at += 4
    const type = bytes.readUInt32LE(at)
    at += 4
    if (type !== SOURCE_AND_MAP) throw new Error(`unexpected symbol data type ${type}`)
    let payload
    if (version === 1) payload = bytes.subarray(at)
    else if (version === 2) {
        const compression = bytes[at++]
        payload = compression === 1 ? zstdDecompressSync(bytes.subarray(at)) : bytes.subarray(at)
    } else throw new Error(`unknown symbol data version ${version}`)

    const sourceLength = Number(payload.readBigUInt64LE(0))
    const minifiedSource = payload.subarray(8, 8 + sourceLength).toString('utf8')
    const mapLength = Number(payload.readBigUInt64LE(8 + sourceLength))
    const sourcemap = payload.subarray(16 + sourceLength, 16 + sourceLength + mapLength).toString('utf8')
    if (16 + sourceLength + mapLength !== payload.length) throw new Error('trailing bytes after source map')
    return { version, minifiedSource, sourcemap: JSON.parse(sourcemap) }
}

const BASE64 = Object.fromEntries(
    [...'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'].map((c, i) => [c, i])
)

function decodeMappings(mappings) {
    const lines = []
    let source = 0,
        originalLine = 0,
        originalColumn = 0,
        name = 0
    for (const line of mappings.split(';')) {
        const segments = []
        let column = 0
        for (const segment of line.split(',')) {
            if (!segment) continue
            const values = []
            let value = 0,
                shift = 0
            for (const char of segment) {
                const digit = BASE64[char]
                value += (digit & 31) << shift
                if (digit & 32) shift += 5
                else {
                    values.push(value & 1 ? -(value >>> 1) : value >>> 1)
                    value = shift = 0
                }
            }
            column += values[0]
            if (values.length >= 4) {
                source += values[1]
                originalLine += values[2]
                originalColumn += values[3]
                if (values.length >= 5) name += values[4]
                segments.push({
                    column,
                    source,
                    originalLine,
                    originalColumn,
                    name: values.length >= 5 ? name : undefined,
                })
            } else segments.push({ column })
        }
        lines.push(segments)
    }
    return lines
}

/** Resolves a 1-based line and column, as SDK frames carry them, to the original position. */
export function originalPosition(map, lineno, colno) {
    const segments = decodeMappings(map.mappings)[lineno - 1] ?? []
    let found
    for (const segment of segments) {
        if (segment.column > colno - 1) break
        found = segment
    }
    if (!found || found.source === undefined) return undefined
    return {
        source: map.sources[found.source],
        line: found.originalLine + 1,
        column: found.originalColumn,
        name: found.name === undefined ? undefined : map.names[found.name],
        hasContent: typeof map.sourcesContent?.[found.source] === 'string',
    }
}
