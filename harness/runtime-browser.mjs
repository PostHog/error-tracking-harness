// Declarative static browser and attached HTTP page driver.
import { createRequire } from 'node:module'
import { createServer as createHttpServer } from 'node:http'
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const harnessRoot = path.resolve(import.meta.dirname, '..')

// A browser runtime (`runtime: { kind: 'browser', serve, page }`): serve the built directory over
// loopback, open the page in headless Chromium with the mock's origin as ?host=, and wait for the
// page to capture its exceptions. Page errors and failed requests are evidence: a chunk whose SRI
// hash no longer matches is refused by the browser and never runs.
function contentType(file) {
    if (/\.(m?js|cjs)$/.test(file)) return 'text/javascript'
    if (file.endsWith('.html')) return 'text/html'
    if (file.endsWith('.css')) return 'text/css'
    if (file.endsWith('.map') || file.endsWith('.json')) return 'application/json'
    return 'application/octet-stream'
}

export async function runBrowser({ fixture, work, host, expectedEvents, mock, log, replay, captureTimeoutMs }) {
    const root = path.join(work, fixture.lifecycle.runtime.serve)
    const triggers = fixture.lifecycle.triggers.filter((trigger) => trigger.kind === 'browser')
    const served = []
    const server = createHttpServer((request, response) => {
        const pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname)
        const file = path.join(root, pathname === '/' ? triggers[0].page : pathname)
        if (!file.startsWith(root) || !existsSync(file) || !statSync(file).isFile()) {
            served.push({ path: pathname, status: 404 })
            response.writeHead(404).end()
            return
        }
        served.push({ path: pathname, status: 200 })
        response.writeHead(200, { 'Content-Type': contentType(file), 'Cache-Control': 'no-store' })
        response.end(readFileSync(file))
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    const origin = `http://127.0.0.1:${server.address().port}`
    try {
        const result = { code: 0, origin, pageErrors: [], consoleErrors: [], failedRequests: [], replayed: [], served }
        let expected = 0
        for (const trigger of triggers) {
            expected += trigger.expects.length
            const page = await openPage({ origin, page: trigger.page, host, expectedEvents: Math.min(expected, expectedEvents), mock, replay, captureTimeoutMs })
            if (page.code !== 0) result.code = 1
            result.pageErrors.push(...page.pageErrors)
            result.consoleErrors.push(...page.consoleErrors)
            result.failedRequests.push(...page.failedRequests)
            result.replayed.push(...page.replayed)
        }
        if (log) writeFileSync(log, JSON.stringify(result, null, 2) + '\n')
        return result
    } finally {
        server.closeAllConnections()
        await new Promise((resolve) => server.close(resolve))
    }
}

// Opens `origin + page` in headless Chromium and waits for `expectedEvents` exceptions to reach
// the mock. With `replay`, requests for immutable assets that existed in the previous release
// are answered with that release's bytes, as a browser holding a tab open across a deploy
// would see them (posthog-js#5332): the page must still work and report the new release.
export async function openPage({ origin, page: pagePath, host, expectedEvents, mock, replay, captureTimeoutMs = 20_000 }) {
    const { chromium } = createRequire(path.join(harnessRoot, 'package.json'))('playwright')
    const browser = await chromium.launch({ headless: true })
    const pageErrors = []
    const consoleErrors = []
    const failedRequests = []
    const replayed = []
    try {
        const page = await browser.newPage()
        page.on('pageerror', (error) => pageErrors.push(error.message))
        page.on('console', (message) => {
            if (message.type() === 'error') consoleErrors.push(message.text())
        })
        page.on('requestfailed', (request) => failedRequests.push({ url: request.url(), error: request.failure()?.errorText }))
        if (replay) {
            await page.route('**/*', async (route) => {
                const url = new URL(route.request().url())
                const previous = url.origin === origin ? replay(decodeURIComponent(url.pathname)) : undefined
                if (previous === undefined) return route.continue()
                replayed.push(url.pathname)
                return route.fulfill({ status: 200, contentType: contentType(url.pathname), body: previous })
            })
        }
        await page.goto(`${origin}${pagePath}?host=${encodeURIComponent(host)}`, { waitUntil: 'load' })
        const captured = () => mock.inspect().events.filter((event) => event.event === '$exception').length
        const deadline = Date.now() + captureTimeoutMs
        while (Date.now() < deadline && captured() < expectedEvents) await new Promise((resolve) => setTimeout(resolve, 200))
        await page.waitForTimeout(500)
        return { code: captured() >= expectedEvents && pageErrors.length === 0 ? 0 : 1, origin, pageErrors, consoleErrors, failedRequests, replayed }
    } finally {
        await browser.close()
    }
}
