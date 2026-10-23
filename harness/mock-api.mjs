// PostHog error tracking API as posthog-cli speaks it (cli/src/api/{releases,symbol_sets}.rs in
// PostHog/posthog), mounted as a mock-server adapter. Presigned uploads go to a separate object
// store server, as they go to S3 in production, so the API host never sees symbol set bytes.
//
// A `fault` makes one endpoint misbehave for the whole run:
//   { api: 'auth' }                                    every request is rejected as unauthorised
//   { api: 'bulk_start_upload', status: 500 }          that action answers with the status
//   { api: 'releases', status: 400, code: 'x' }        ...optionally with a structured error code
import { createHash, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { decodeSymbolSet } from './symbol-data.mjs'

const API = /^\/api\/(?:projects|environments)\/([^/]+)\/error_tracking\/(.+?)\/?$/

export function createErrorTrackingApi({ apiKey, projectId, fault }) {
    const releases = new Map() // hash_id -> release row
    const symbolSets = new Map() // chunk_id -> stored symbol set
    const attempts = new Map() // upload_attempt_id -> chunk ids started under it
    const calls = []
    const errors = []
    let objectStoreOrigin

    const objectStore = createServer(async (request, response) => {
        const chunks = []
        for await (const chunk of request) chunks.push(chunk)
        const bytes = Buffer.concat(chunks)
        const url = new URL(request.url, objectStoreOrigin)
        let key, data
        if (request.method === 'PUT' && url.pathname.startsWith('/put/')) {
            key = url.pathname.slice('/put/'.length)
            data = bytes
        } else if (request.method === 'POST' && url.pathname === '/post') {
            ;({ key, data } = parseMultipart(bytes, request.headers['content-type']))
        }
        if (fault?.api === 'object_store') {
            response.writeHead(fault.status ?? 500).end()
            return
        }
        const set = [...symbolSets.values()].find((candidate) => candidate.id === key)
        if (!set || !data) {
            errors.push(`object store: unexpected ${request.method} ${url.pathname}`)
            response.writeHead(404).end()
            return
        }
        if (set.declaredLength !== undefined && set.declaredLength !== data.length) {
            errors.push(`object store: ${set.chunk_id} declared ${set.declaredLength} bytes, sent ${data.length}`)
        }
        set.transport = request.method
        set.bytes = data
        try {
            set.upload = decodeSymbolSet(data)
        } catch (error) {
            errors.push(`object store: ${set.chunk_id} is not valid symbol data: ${error.message}`)
        }
        response.writeHead(request.method === 'PUT' ? 200 : 204).end()
    })

    function apiError(status, code, detail) {
        return { status, json: { type: 'validation_error', code, detail, attr: null } }
    }

    function route(request) {
        const match = API.exec(request.path)
        if (!match) return undefined
        const [, project, action] = match
        const name = action.replace(/^symbol_sets\//, '').replace(/^releases\/hash\/.*$/, 'release_lookup')
        const call = { method: request.method, action, body: request.body, status: null }
        calls.push(call)
        const answer = (value) => {
            call.status = value.status ?? 200
            return value
        }
        if (fault?.api === 'auth' || request.headers.authorization !== `Bearer ${apiKey}`) {
            if (fault?.api !== 'auth') errors.push(`api: bad authorization on ${action}`)
            return answer({ status: 401, json: { type: 'authentication_error', detail: 'Invalid personal API key' } })
        }
        if (project !== String(projectId)) {
            errors.push(`api: wrong project ${project}`)
            return answer({ status: 404, json: { detail: 'Not found' } })
        }
        if (fault?.api === name) {
            return answer(apiError(fault.status ?? 500, fault.code ?? 'injected_fault', `Injected fault on ${name}`))
        }

        const hash = /^releases\/hash\/([^/]+)$/.exec(action)
        if (request.method === 'GET' && hash) {
            const release = releases.get(hash[1])
            return answer(release ? { json: release } : { status: 404, json: { detail: 'Not found' } })
        }
        if (request.method === 'POST' && action === 'releases') {
            const { hash_id, version, project: releaseName, metadata } = request.body
            if (releases.has(hash_id)) return answer(apiError(400, 'release_hash_in_use', 'Release hash already in use'))
            const release = { id: randomUUID(), hash_id, version, project: releaseName, metadata: metadata ?? {} }
            releases.set(hash_id, release)
            return answer({ status: 201, json: release })
        }

        if (request.method === 'POST' && action === 'symbol_sets/bulk_check_upload') {
            const needed = request.body.symbol_sets
                .filter((set) => symbolSets.get(set.chunk_id)?.content_hash !== set.content_hash)
                .map((set) => set.chunk_id)
            return answer({ json: { chunk_ids_to_upload: needed } })
        }
        if (request.method === 'POST' && action === 'symbol_sets/bulk_start_upload') {
            const { symbol_sets: requested, upload_attempt_id, force } = request.body
            const id_map = {}
            for (const set of requested) {
                const existing = symbolSets.get(set.chunk_id)
                if (existing?.finished && existing.content_hash !== set.content_hash && !force) {
                    return answer(apiError(400, 'content_hash_mismatch', `Content changed for ${set.chunk_id}`))
                }
                if (existing?.finished && (existing.release_id ?? null) !== (set.release_id ?? null)) {
                    return answer(apiError(400, 'release_id_mismatch', `Release changed for ${set.chunk_id}`))
                }
                const id = existing?.id ?? randomUUID()
                symbolSets.set(set.chunk_id, {
                    ...existing,
                    id,
                    chunk_id: set.chunk_id,
                    release_id: set.release_id ?? null,
                    content_hash: set.content_hash,
                    declaredLength: set.content_length,
                    finished: false,
                })
                id_map[set.chunk_id] = {
                    symbol_set_id: id,
                    presigned_url: { url: `${objectStoreOrigin}/post`, fields: { key: id } },
                    presigned_put_url: `${objectStoreOrigin}/put/${id}`,
                }
            }
            attempts.set(upload_attempt_id, requested.map((set) => set.chunk_id))
            return answer({ json: { id_map } })
        }
        if (request.method === 'POST' && action === 'symbol_sets/bulk_finish_upload') {
            const { content_hashes, upload_attempt_id } = request.body
            if (!attempts.has(upload_attempt_id)) {
                return answer(apiError(400, 'unknown_upload_attempt', `Unknown attempt ${upload_attempt_id}`))
            }
            for (const [symbolSetId, contentHash] of Object.entries(content_hashes)) {
                const set = [...symbolSets.values()].find((candidate) => candidate.id === symbolSetId)
                if (!set) return answer(apiError(400, 'unknown_symbol_set', symbolSetId))
                if (!set.bytes) return answer(apiError(400, 'upload_missing', `No bytes uploaded for ${set.chunk_id}`))
                if (set.content_hash !== contentHash) errors.push(`api: finish hash differs for ${set.chunk_id}`)
                set.finished = true
            }
            return answer({ json: { success: true } })
        }

        errors.push(`api: unhandled ${request.method} ${action}`)
        return answer({ status: 404, json: { detail: 'Not found' } })
    }

    return {
        route,
        async start() {
            await new Promise((resolve) => objectStore.listen(0, '127.0.0.1', resolve))
            objectStoreOrigin = `http://127.0.0.1:${objectStore.address().port}`
        },
        async stop() {
            objectStore.closeAllConnections()
            await new Promise((resolve) => objectStore.close(resolve))
        },
        /** Everything stored so far. `upload` carries the decoded symbol set; `sha512` the raw bytes. */
        snapshot() {
            return {
                releases: [...releases.values()],
                symbolSets: [...symbolSets.values()].map(({ bytes, ...set }) => ({
                    ...set,
                    sha512: bytes && createHash('sha512').update(bytes).digest('hex'),
                })),
                calls: structuredClone(calls),
                errors: [...errors],
            }
        },
        clearCalls() {
            calls.length = 0
            errors.length = 0
        },
    }
}

// Enough multipart/form-data to read a presigned POST: the `key` field and the `file` part.
function parseMultipart(bytes, contentType) {
    const boundary = /boundary=(?:"([^"]+)"|([^;]+))/.exec(contentType ?? '')
    if (!boundary) return {}
    const delimiter = Buffer.from(`--${boundary[1] ?? boundary[2]}`)
    const fields = {}
    let data
    let at = bytes.indexOf(delimiter)
    while (at !== -1) {
        const start = at + delimiter.length + 2
        const next = bytes.indexOf(delimiter, start)
        if (next === -1) break
        const part = bytes.subarray(start, next - 2)
        const split = part.indexOf('\r\n\r\n')
        const headers = part.subarray(0, split).toString()
        const body = part.subarray(split + 4)
        const name = /name="([^"]+)"/.exec(headers)?.[1]
        if (name === 'file') data = Buffer.from(body)
        else if (name) fields[name] = body.toString()
        at = next
    }
    return { key: fields.key, data }
}
