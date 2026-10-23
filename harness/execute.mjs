// Runs one cell of the matrix: build the fixture as its own process in a scrubbed environment,
// run the bundle, and collect evidence. Nothing here decides pass or fail; see judge.mjs.
import { execFileSync, spawn } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs'
import { createServer } from 'node:net'
import { createServer as createHttpServer } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createMockServer } from './mock-server.mjs'
import { createErrorTrackingApi } from './mock-api.mjs'
import { prepareNodeModules } from './subject.mjs'
import { collectDist, collectEvents, collectInjection, collectIntegrity, collectSymbolSets, expectedThrows, listDist } from './collect.mjs'

const harnessRoot = path.resolve(import.meta.dirname, '..')
const API_KEY = 'phx_harness_personal_key'
const PROJECT_ID = '4242'
const RELEASE_NAME = 'harness-app'
const PLUGIN_ERROR = /Error injecting PostHog|Error running PostHog|release resolve failed|Command failed with code|ERROR posthog_cli|panicked/

function run(command, args, { cwd, env, log, input, timeout = 180_000 }) {
    return new Promise((resolve) => {
        const child = spawn(command, args, { cwd, env, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] })
        if (input !== undefined) child.stdin.end(input)
        let output = ''
        child.stdout.on('data', (data) => (output += data))
        child.stderr.on('data', (data) => (output += data))
        const timer = setTimeout(() => child.kill('SIGKILL'), timeout)
        child.on('close', (code, signal) => {
            clearTimeout(timer)
            if (log) writeFileSync(log, output)
            resolve({ code: code ?? -1, signal, output })
        })
    })
}

// Nothing from the developer's shell or the CI runner reaches the build: GITHUB_SHA, VERCEL_*,
// POSTHOG_* and a real ~/.posthog would all change which release the CLI resolves.
function sandboxEnv(work, extra) {
    const home = path.join(work, '.home')
    mkdirSync(home, { recursive: true })
    return {
        PATH: process.env.PATH,
        HOME: home,
        XDG_CONFIG_HOME: home,
        POSTHOG_HOME: home,
        TMPDIR: tmpdir(),
        LANG: 'C.UTF-8',
        NO_COLOR: '1',
        CI: '1',
        ...extra,
    }
}

// A case can ask to build inside a git checkout (`git: { remote, worktree }`): the CLI derives
// the release from it when the plugin passes no name or version, and copies what it finds into
// the release metadata. The repository is created from the fixture copy; with `worktree` the
// build runs in a linked worktree, where `.git` is a file rather than a directory.
function createRepository(work, git) {
    const run = (cwd, ...args) =>
        execFileSync('git', args, {
            cwd,
            stdio: 'pipe',
            env: { ...process.env, GIT_AUTHOR_NAME: 'Harness', GIT_AUTHOR_EMAIL: 'harness@example.com', GIT_COMMITTER_NAME: 'Harness', GIT_COMMITTER_EMAIL: 'harness@example.com', GIT_CONFIG_GLOBAL: '/dev/null' },
        })
            .toString()
            .trim()
    let repository = work
    if (git.worktree) {
        repository = `${work}-repository`
        cpSync(work, repository, { recursive: true })
        rmSync(work, { recursive: true, force: true })
    }
    run(repository, 'init', '-q', '-b', 'main')
    if (git.remote) run(repository, 'remote', 'add', 'origin', git.remote)
    run(repository, 'add', '-A')
    run(repository, 'commit', '-q', '-m', 'Fixture')
    if (git.worktree) run(repository, 'worktree', 'add', '-q', '-b', 'harness-worktree', work, 'main')
    return { commit: run(work, 'rev-parse', 'HEAD'), worktree: Boolean(git.worktree), remote: git.remote ?? null }
}

// cli-mode fixtures: the harness drives posthog-cli over the built files, the way a user without a
// bundler plugin does. `cli.command` is process | inject-upload | upload, `cli.input` is directory
// (the default) or stdin (the file list the plugins pipe in). The environment is what the plugins
// set (plugin-utils' buildCliEnv) and the flags are the ones they pass.
async function runCliSteps({ cli, kase, options, work, dist, host, output, tag, fixture }) {
    const config = kase.cli ?? {}
    const sourcemaps = options.sourcemaps ?? {}
    const releaseFlags = []
    if (sourcemaps.releaseName) releaseFlags.push('--release-name', sourcemaps.releaseName)
    if (sourcemaps.releaseVersion) releaseFlags.push('--release-version', sourcemaps.releaseVersion)
    const mode = sourcemaps.releaseMode ?? 'event'
    const modeFlags = mode === 'event' ? ['--release-mode', 'event'] : []
    const deleteFlags = sourcemaps.deleteAfterUpload === false ? [] : ['--delete-after']
    const files = listDist(dist, fixture).filter((file) => !file.endsWith('.map')).map((file) => path.join(dist, file))
    const target = config.input === 'stdin' ? ['--stdin'] : ['--directory', dist]
    const input = config.input === 'stdin' ? files.join('\n') + '\n' : undefined
    const env = sandboxEnv(work, {
        RUST_LOG: 'posthog_cli=debug',
        POSTHOG_CLI_HOST: host,
        POSTHOG_CLI_API_KEY: options.personalApiKey,
        POSTHOG_CLI_PROJECT_ID: options.projectId,
        POSTHOG_RELEASE_MODE: mode,
        ...(kase.env ?? {}),
    })
    const commands = {
        process: [['sourcemap', 'process', ...target, ...releaseFlags, ...modeFlags, ...deleteFlags]],
        'inject-upload': [
            ['sourcemap', 'inject', ...target, ...releaseFlags, ...modeFlags],
            ['sourcemap', 'upload', ...target, ...releaseFlags, ...modeFlags, ...deleteFlags],
        ],
        upload: [['sourcemap', 'upload', ...target, ...releaseFlags, ...modeFlags, ...deleteFlags]],
    }[config.command ?? 'process']
    const steps = []
    for (const [index, args] of commands.entries()) {
        const result = await run(cli.path, args, { cwd: work, env, input, log: path.join(output, `${tag}-cli-${index + 1}-${args[1]}.log`) })
        steps.push({ args, code: result.code })
        if (result.code !== 0) break
    }
    return steps
}

async function availablePort() {
    const server = createServer()
    await new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(0, '127.0.0.1', resolve)
    })
    const port = server.address().port
    await new Promise((resolve) => server.close(resolve))
    return port
}

function killGroup(child, signal) {
    if (!child.pid) return
    try {
        process.kill(-child.pid, signal)
    } catch (error) {
        if (error.code !== 'ESRCH') throw error
    }
}

// An HTTP runtime (`runtime: { kind: 'http', start, paths }`): start the built server from the
// fixture's node_modules/.bin, wait for it to answer, request each path so the server captures
// its exceptions, then stop the whole process group (frameworks fork workers).
async function runHttp({ fixture, work, env, log }) {
    const port = await availablePort()
    const origin = `http://127.0.0.1:${port}`
    // Frameworks take the port as flags (next start -p) or as variables (Nitro: PORT, HOST).
    const { portEnv, hostEnv } = fixture.runtime
    const command = portEnv ? fixture.runtime.start : `${fixture.runtime.start} -p ${port} -H 127.0.0.1`
    const serverEnv = { ...env }
    for (const name of portEnv ?? []) serverEnv[name] = String(port)
    for (const name of hostEnv ?? []) serverEnv[name] = '127.0.0.1'
    const child = spawn('sh', ['-c', command], {
        cwd: work,
        env: serverEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
    })
    let output = ''
    child.stdout.on('data', (data) => (output += data))
    child.stderr.on('data', (data) => (output += data))
    const exited = new Promise((resolve) => child.once('close', (code, signal) => resolve({ code, signal })))
    const requests = []
    try {
        const deadline = Date.now() + 90_000
        let ready = false
        while (Date.now() < deadline && !ready) {
            if (child.exitCode !== null) break
            try {
                ready = (await fetch(origin, { signal: AbortSignal.timeout(2000) })).ok
            } catch {
                await new Promise((resolve) => setTimeout(resolve, 250))
            }
        }
        if (!ready) return { code: -1, output: `server did not become ready\n${output}`, requests }
        for (const route of fixture.runtime.paths) {
            try {
                const response = await fetch(origin + route, { signal: AbortSignal.timeout(30_000) })
                requests.push({ path: route, status: response.status, body: (await response.text()).slice(0, 2000) })
            } catch (error) {
                requests.push({ path: route, status: null, error: error.message })
            }
        }
        // The SDK flushes on shutdown inside the handler; give the capture a moment to land.
        await new Promise((resolve) => setTimeout(resolve, 1500))
        return { code: requests.every((request) => request.status === 200) ? 0 : 1, output, requests }
    } finally {
        killGroup(child, 'SIGTERM')
        const timer = setTimeout(() => killGroup(child, 'SIGKILL'), 5000)
        await exited
        clearTimeout(timer)
        if (log) writeFileSync(log, output + '\n' + JSON.stringify(requests, null, 2) + '\n')
    }
}

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

async function runBrowser({ fixture, work, host, expectedEvents, mock, log }) {
    const root = path.join(work, fixture.runtime.serve)
    const served = []
    const server = createHttpServer((request, response) => {
        const pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname)
        const file = path.join(root, pathname === '/' ? fixture.runtime.page : pathname)
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
    const { chromium } = createRequire(path.join(harnessRoot, 'package.json'))('playwright')
    const browser = await chromium.launch({ headless: true })
    const pageErrors = []
    const consoleErrors = []
    const failedRequests = []
    try {
        const page = await browser.newPage()
        page.on('pageerror', (error) => pageErrors.push(error.message))
        page.on('console', (message) => {
            if (message.type() === 'error') consoleErrors.push(message.text())
        })
        page.on('requestfailed', (request) => failedRequests.push({ url: request.url(), error: request.failure()?.errorText }))
        await page.goto(`${origin}${fixture.runtime.page}?host=${encodeURIComponent(host)}`, { waitUntil: 'load' })
        const deadline = Date.now() + 20_000
        while (Date.now() < deadline) {
            const captured = mock.inspect().events.filter((event) => event.event === '$exception').length
            if (captured >= expectedEvents) break
            await new Promise((resolve) => setTimeout(resolve, 200))
        }
        await page.waitForTimeout(500)
        const captured = mock.inspect().events.filter((event) => event.event === '$exception').length
        const result = { code: captured >= expectedEvents && pageErrors.length === 0 ? 0 : 1, origin, pageErrors, consoleErrors, failedRequests, served }
        if (log) writeFileSync(log, JSON.stringify(result, null, 2) + '\n')
        return result
    } finally {
        await browser.close()
        server.closeAllConnections()
        await new Promise((resolve) => server.close(resolve))
    }
}

// Case options override the defaults; a null deletes the key so a case can leave out a default.
function mergeOptions(base, patch) {
    const merged = { ...base }
    for (const [key, value] of Object.entries(patch ?? {})) {
        if (value === null) delete merged[key]
        else if (typeof value === 'object' && !Array.isArray(value) && typeof merged[key] === 'object') {
            merged[key] = mergeOptions(merged[key], value)
        } else merged[key] = value
    }
    return merged
}

export async function executeCase({ cli, fixture, kase, selection, subject, output }) {
    mkdirSync(output, { recursive: true })
    const work = mkdtempSync(path.join(tmpdir(), 'error-tracking-harness-'))
    const api = createErrorTrackingApi({ apiKey: API_KEY, projectId: PROJECT_ID, fault: kase.fault, server: kase.server })
    await api.start()
    const mock = createMockServer({ adapter: (request) => api.route(request) })
    const host = await mock.start()
    const evidence = {
        cli,
        fixture: {
            name: fixture.name,
            bundler: fixture.bundler,
            version: fixture.version,
            runtime: fixture.runtime?.kind ?? (fixture.runtime ?? 'node'),
            volatileChunks: fixture.volatileChunks ?? [],
            optionalIds: fixture.optionalIds ?? [],
        },
        plugin: null,
        case: kase.name,
        selection,
        throws: null,
        git: null,
        releases: [],
        afterFinalUpload: null,
    }
    try {
        cpSync(fixture.dir, work, { recursive: true, filter: (source) => !/\/(node_modules|dist)(\/|$)/.test(source) })
        if (kase.git) evidence.git = createRepository(work, kase.git)
        evidence.plugin = prepareNodeModules({ fixtureDir: fixture.dir, fixture, work, selection, subject })
        evidence.throws = expectedThrows(work, fixture)
        const dist = path.join(work, fixture.dist ?? path.dirname(fixture.entry))
        const binPath = `${path.join(work, 'node_modules/.bin')}${path.delimiter}${process.env.PATH}`
        const releaseIds = []
        const releaseCount = kase.releases ?? 1

        for (let index = 0; index < releaseCount; index++) {
            const releaseVersion = `1.0.${index}`
            const tag = `release-${releaseVersion}`
            api.clearCalls()
            mock.clearCaptured()
            rmSync(dist, { recursive: true, force: true })

            const options = mergeOptions(
                {
                    personalApiKey: API_KEY,
                    projectId: PROJECT_ID,
                    host,
                    ...(cli.path ? { cliBinaryPath: cli.path } : {}),
                    logLevel: 'debug',
                    sourcemaps: { enabled: true, releaseName: RELEASE_NAME, releaseVersion, deleteAfterUpload: true },
                },
                kase.options
            )
            // The fixture's own `build` script, run the way npm would: with node_modules/.bin on
            // PATH and no package manager in between, which would otherwise try to install
            // itself into the sandboxed HOME.
            const script = JSON.parse(readFileSync(path.join(work, 'package.json'), 'utf8')).scripts?.[fixture.script ?? 'build']
            if (!script) throw new Error(`${fixture.name}: package.json has no "${fixture.script ?? 'build'}" script`)
            const build = await run('sh', ['-c', script], {
                cwd: work,
                log: path.join(output, `${tag}-build.log`),
                env: sandboxEnv(work, {
                    PATH: binPath,
                    NEXT_TELEMETRY_DISABLED: '1',
                    POSTHOG_HARNESS_OPTIONS: JSON.stringify(options),
                    ...(kase.env ?? {}),
                }),
            })
            // In cli mode the plugin-free build is done; keep its bytes, then let the CLI rewrite them.
            let cliSteps = null
            let pristine = null
            if (fixture.mode === 'cli' && build.code === 0) {
                pristine = Object.fromEntries(listDist(dist, fixture).map((file) => [file, readFileSync(path.join(dist, file), 'utf8')]))
                cliSteps = await runCliSteps({ cli, kase, options, work, dist, host, output, tag, fixture })
            }
            // Keep the judged files, not the whole output directory (a framework's cache is huge).
            for (const file of listDist(dist, fixture)) {
                mkdirSync(path.dirname(path.join(output, `${tag}-dist`, file)), { recursive: true })
                cpSync(path.join(dist, file), path.join(output, `${tag}-dist`, file))
            }

            const state = api.snapshot()
            // With no name and version from the plugin, the release is whatever the CLI derived.
            const configured = options.sourcemaps?.releaseName !== undefined || options.sourcemaps?.releaseVersion !== undefined
            const release = configured
                ? (state.releases.find((row) => row.project === RELEASE_NAME && row.version === releaseVersion) ?? null)
                : (state.releases.at(-1) ?? null)
            if (release) releaseIds.push(release.id)
            const cliLog = (cliSteps ?? []).length ? readFileSync(path.join(output, `${tag}-cli-${cliSteps.length}-${cliSteps.at(-1).args[1]}.log`), 'utf8') : ''
            const { chunks, mapsLeft } = collectDist(work, dist, fixture, build.output + '\n' + cliLog)
            let runtime = null
            let events = null
            if (build.code === 0) {
                // A framework server reads its config again at start, so the options stay in scope.
                const runtimeEnv = sandboxEnv(work, {
                    PATH: binPath,
                    POSTHOG_HARNESS_HOST: host,
                    POSTHOG_HARNESS_OPTIONS: JSON.stringify(options),
                    NEXT_TELEMETRY_DISABLED: '1',
                })
                const log = path.join(output, `${tag}-runtime.log`)
                if (fixture.runtime?.kind === 'none') {
                    runtime = null
                } else if (fixture.runtime?.kind === 'browser') {
                    runtime = await runBrowser({ fixture, work, host, expectedEvents: Object.keys(evidence.throws).length, mock, log })
                } else if (fixture.runtime?.kind === 'http') {
                    runtime = await runHttp({ fixture, work, env: runtimeEnv, log })
                } else if (existsSync(path.join(work, fixture.entry))) {
                    runtime = await run(process.execPath, [path.join(work, fixture.entry)], { cwd: work, log, env: runtimeEnv })
                }
                if (runtime) events = collectEvents({ events: mock.inspect().events, chunks, api: state, work, throws: evidence.throws, served: runtime.origin && { origin: runtime.origin, root: path.join(work, fixture.runtime.serve) } })
            }
            // Keep the server's copy of any chunk that no longer matches disk, for diagnosis.
            for (const set of state.symbolSets) {
                const chunk = chunks.find((candidate) => candidate.chunkId === set.chunk_id)
                if (chunk && set.upload && set.upload.minifiedSource !== chunk.code) {
                    const stored = path.join(output, `${tag}-stored`, chunk.file)
                    mkdirSync(path.dirname(stored), { recursive: true })
                    writeFileSync(stored, set.upload.minifiedSource)
                }
            }
            const uploaded = state.calls
                .filter((call) => call.action === 'symbol_sets/bulk_start_upload' && call.status === 200)
                .flatMap((call) => call.body.symbol_sets.map((set) => set.chunk_id))
            evidence.releases.push({
                releaseVersion,
                releaseId: release?.id ?? null,
                release: release && { name: release.project, version: release.version, metadata: release.metadata ?? {} },
                build: { code: build.code, signal: build.signal, pluginError: PLUGIN_ERROR.test(build.output) },
                cli: cliSteps,
                injection: pristine && collectInjection(pristine, chunks),
                integrity: collectIntegrity(work, fixture),
                chunks: chunks.map(({ code, absolute, ...chunk }) => chunk),
                mapsLeft,
                symbolSets: collectSymbolSets(chunks, state, releaseIds.slice(0, -1), release?.id),
                apiCalls: state.calls.map((call) => ({ action: call.action, status: call.status })),
                uploadedChunkIds: uploaded,
                runtime: runtime && { code: runtime.code, signal: runtime.signal ?? null, requests: runtime.requests ?? null, pageErrors: runtime.pageErrors ?? null, failedRequests: runtime.failedRequests ?? null },
                events,
                mockErrors: [...state.errors, ...mock.inspect().errors],
            })
            // Keep what each later release needs for the cross-release checks.
            evidence.releases.at(-1)._chunks = chunks
            evidence.releases.at(-1)._events = mock.inspect().events
            evidence.releases.at(-1)._served = runtime?.origin && { origin: runtime.origin, root: path.join(work, fixture.runtime.serve) }
        }

        // Re-resolve the first release's exceptions against what the server holds at the end.
        const first = evidence.releases[0]
        if (evidence.releases.length > 1 && first._events?.length) {
            evidence.afterFinalUpload = {
                events: collectEvents({ events: first._events, chunks: first._chunks, api: api.snapshot(), work, throws: evidence.throws, served: first._served }),
            }
        }
        for (const release of evidence.releases) {
            delete release._chunks
            delete release._events
            delete release._served
        }
        writeFileSync(path.join(output, 'evidence.json'), JSON.stringify(evidence, null, 2))
        if (evidence.git?.worktree) rmSync(`${work}-repository`, { recursive: true, force: true })
        return { evidence, work }
    } finally {
        await mock.stop()
        await api.stop()
    }
}

export function discardWork(work) {
    rmSync(work, { recursive: true, force: true })
}
