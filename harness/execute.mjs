// Runs one cell of the matrix: build the fixture as its own process in a scrubbed environment,
// run the bundle, and collect evidence. Nothing here decides pass or fail; see judge.mjs.
import { spawn } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createMockServer } from './mock-server.mjs'
import { createErrorTrackingApi } from './mock-api.mjs'
import { prepareNodeModules } from './subject.mjs'
import { collectDist, collectEvents, collectSymbolSets, expectedThrows } from './collect.mjs'

const API_KEY = 'phx_harness_personal_key'
const PROJECT_ID = '4242'
const RELEASE_NAME = 'harness-app'
const PLUGIN_ERROR = /Error injecting PostHog|Error running PostHog|release resolve failed|Command failed with code|ERROR posthog_cli|panicked/

function run(command, args, { cwd, env, log, timeout = 180_000 }) {
    return new Promise((resolve) => {
        const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
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
    const api = createErrorTrackingApi({ apiKey: API_KEY, projectId: PROJECT_ID, fault: kase.fault })
    await api.start()
    const mock = createMockServer({ adapter: (request) => api.route(request) })
    const host = await mock.start()
    const evidence = {
        cli,
        fixture: { name: fixture.name, bundler: fixture.bundler, version: fixture.version },
        plugin: null,
        case: kase.name,
        selection,
        throws: null,
        releases: [],
        afterFinalUpload: null,
    }
    try {
        cpSync(fixture.dir, work, { recursive: true, filter: (source) => !/\/(node_modules|dist)(\/|$)/.test(source) })
        evidence.plugin = prepareNodeModules({ fixtureDir: fixture.dir, fixture, work, selection, subject })
        evidence.throws = expectedThrows(work, fixture)
        const dist = path.join(work, path.dirname(fixture.entry))
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
                    cliBinaryPath: cli.path,
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
                    PATH: `${path.join(work, 'node_modules/.bin')}${path.delimiter}${process.env.PATH}`,
                    POSTHOG_HARNESS_OPTIONS: JSON.stringify(options),
                    ...(kase.env ?? {}),
                }),
            })
            if (existsSync(dist)) cpSync(dist, path.join(output, `${tag}-dist`), { recursive: true })

            const state = api.snapshot()
            const release = state.releases.find((row) => row.project === RELEASE_NAME && row.version === releaseVersion) ?? null
            if (release) releaseIds.push(release.id)
            const { chunks, mapsLeft } = collectDist(work, dist)
            const entry = path.join(work, fixture.entry)
            let runtime = null
            let events = null
            if (build.code === 0 && existsSync(entry)) {
                runtime = await run(process.execPath, [entry], {
                    cwd: work,
                    log: path.join(output, `${tag}-runtime.log`),
                    env: sandboxEnv(work, { POSTHOG_HARNESS_HOST: host }),
                })
                events = collectEvents({ events: mock.inspect().events, chunks, api: state, work, throws: evidence.throws })
            }
            const uploaded = state.calls
                .filter((call) => call.action === 'symbol_sets/bulk_start_upload' && call.status === 200)
                .flatMap((call) => call.body.symbol_sets.map((set) => set.chunk_id))
            evidence.releases.push({
                releaseVersion,
                releaseId: release?.id ?? null,
                build: { code: build.code, signal: build.signal, pluginError: PLUGIN_ERROR.test(build.output) },
                chunks: chunks.map(({ code, absolute, ...chunk }) => chunk),
                mapsLeft,
                symbolSets: collectSymbolSets(chunks, state, releaseIds.slice(0, -1), release?.id),
                apiCalls: state.calls.map((call) => ({ action: call.action, status: call.status })),
                uploadedChunkIds: uploaded,
                runtime: runtime && { code: runtime.code, signal: runtime.signal },
                events,
                mockErrors: [...state.errors, ...mock.inspect().errors],
            })
            // Keep what each later release needs for the cross-release checks.
            evidence.releases.at(-1)._chunks = chunks
            evidence.releases.at(-1)._events = mock.inspect().events
        }

        // Re-resolve the first release's exceptions against what the server holds at the end.
        const first = evidence.releases[0]
        if (evidence.releases.length > 1 && first._events?.length) {
            evidence.afterFinalUpload = {
                events: collectEvents({ events: first._events, chunks: first._chunks, api: api.snapshot(), work, throws: evidence.throws }),
            }
        }
        for (const release of evidence.releases) {
            delete release._chunks
            delete release._events
        }
        writeFileSync(path.join(output, 'evidence.json'), JSON.stringify(evidence, null, 2))
        return { evidence, work }
    } finally {
        await mock.stop()
        await api.stop()
    }
}

export function discardWork(work) {
    rmSync(work, { recursive: true, force: true })
}
