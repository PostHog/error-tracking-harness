// Loopback HTTP server standing in for PostHog ingestion. It records every request, decodes the
// body the way the SDKs send it, captures exception events, and hands everything else to an
// adapter (the error tracking API lives in mock-api.mjs). Body decoding is taken from
// posthog-js/tooling/sdk-mock-server (decode.ts); the rest is a reduced form of that server:
// no flags, config, surveys, barriers or control endpoints, none of which a build needs.
import { createServer } from 'node:http'
import { gunzipSync } from 'node:zlib'

function base64Bytes(value) {
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
        throw new Error('Invalid base64 body')
    }
    return Buffer.from(value, 'base64')
}

export function decodeBody(raw, headers, url) {
    if (!raw.length) return { body: null, bodyWrapper: 'empty' }
    const compression = url.searchParams.get('compression')
    if (compression && !['base64', 'gzip', 'gzip-js'].includes(compression)) {
        throw new Error(`Unsupported compression: ${compression}`)
    }
    const encoding = String(headers['content-encoding'] ?? '').toLowerCase()
    if (encoding && encoding !== 'gzip' && encoding !== 'identity') {
        throw new Error(`Unsupported content encoding: ${encoding}`)
    }
    const gzipped =
        encoding === 'gzip' ||
        compression === 'gzip' ||
        compression === 'gzip-js' ||
        (raw[0] === 0x1f && raw[1] === 0x8b)
    let bytes = gzipped ? gunzipSync(raw) : raw
    let bodyWrapper = gzipped ? 'gzip' : 'json'
    const text = bytes.toString('utf8')
    if (
        String(headers['content-type'] ?? '').startsWith('application/x-www-form-urlencoded') ||
        text.startsWith('data=')
    ) {
        const data = new URLSearchParams(text).get('data')
        if (data === null) throw new Error('Missing form data field')
        if (compression !== 'base64') {
            try {
                return { body: JSON.parse(data), bodyWrapper: 'form-json' }
            } catch {
                // Older browser clients send base64 form data without a compression query.
            }
        }
        bytes = base64Bytes(data)
        bodyWrapper = 'form-base64'
    } else if (compression === 'base64') {
        bytes = base64Bytes(text)
        bodyWrapper = 'base64'
    }
    return { body: JSON.parse(bytes.toString('utf8')), bodyWrapper }
}

function isObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function eventsIn(body) {
    return isObject(body) && Array.isArray(body.batch) ? body.batch : Array.isArray(body) ? body : [body]
}

export function createMockServer({ adapter } = {}) {
    let requests = []
    let events = []
    let errors = []
    let sequence = 0
    let origin

    function send(response, value, record) {
        if (response.destroyed || response.writableEnded) return
        const status = value.status ?? 200
        const bytes = value.body === undefined ? Buffer.from(JSON.stringify(value.json ?? {})) : Buffer.from(value.body)
        response.writeHead(status, {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Headers': '*',
            'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
            'Cache-Control': 'no-store',
            'Content-Type': value.body === undefined ? 'application/json' : 'application/octet-stream',
            ...value.headers,
            'Content-Length': status === 204 ? 0 : bytes.length,
        })
        if (record) record.status = status
        response.end(status === 204 ? undefined : bytes)
    }

    function backend(request) {
        const path = request.path.replace(/\/+$/, '')
        if (request.method !== 'POST') return undefined
        if (['/batch', '/e', '/i/v0/e'].includes(path)) {
            events.push(...eventsIn(request.body))
            return { json: { status: 'ok' } }
        }
        if (path === '/i/v1/analytics/events') {
            const batch = eventsIn(request.body)
            events.push(...batch)
            const results = Object.fromEntries(batch.map((event) => [event?.uuid, { result: 'ok' }]))
            return { json: { results } }
        }
        return undefined
    }

    const server = createServer(async (incoming, response) => {
        const method = incoming.method ?? 'GET'
        let record
        try {
            const url = new URL(incoming.url ?? '/', origin)
            // Loopback only: a request addressed to another host means something tried to use
            // this server as a proxy to reach the outside.
            if (incoming.headers.host !== new URL(origin).host) {
                errors.push(`Blocked destination: ${incoming.headers.host ?? url.host}`)
                incoming.resume()
                send(response, { status: 403, json: { error: 'Outbound network blocked' } })
                return
            }
            if (method === 'OPTIONS') {
                incoming.resume()
                send(response, { status: 204 })
                return
            }
            const chunks = []
            for await (const chunk of incoming) chunks.push(Buffer.from(chunk))
            const rawBytes = Buffer.concat(chunks)
            record = {
                id: ++sequence,
                method,
                path: url.pathname,
                query: Object.fromEntries(
                    [...new Set(url.searchParams.keys())].map((key) => [key, url.searchParams.getAll(key)])
                ),
                headers: { ...incoming.headers },
                rawBodyBase64: rawBytes.toString('base64'),
                body: null,
                bodyWrapper: 'empty',
                status: null,
            }
            requests.push(record)
            try {
                Object.assign(record, decodeBody(rawBytes, incoming.headers, url))
            } catch (error) {
                record.decodeError = error.message
                throw error
            }
            const request = { ...record, url, rawBytes }
            const value = (await adapter?.(request)) ?? backend(request)
            if (value) send(response, value, record)
            else {
                errors.push(`Unexpected ${method} ${url.pathname}`)
                send(response, { status: 404, json: { error: 'Unknown path' } }, record)
            }
        } catch (error) {
            errors.push(error.message)
            send(response, { status: 400, json: { error: error.message } }, record)
        }
    })

    return {
        start() {
            return new Promise((resolve, reject) => {
                server.once('error', reject)
                server.listen(0, '127.0.0.1', () => {
                    origin = `http://127.0.0.1:${server.address().port}`
                    resolve(origin)
                })
            })
        },
        async stop() {
            server.closeAllConnections()
            await new Promise((resolve) => server.close(resolve))
        },
        inspect() {
            return structuredClone({ requests, events, errors })
        },
        clearCaptured() {
            requests = []
            events = []
            errors = []
        },
    }
}
