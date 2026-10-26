// Runs one cell of the matrix: build the fixture as its own process in a scrubbed environment,
// run the bundle, and collect evidence. Nothing here decides pass or fail; see judge.mjs.
import { execFileSync, spawn } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path, { matchesGlob } from 'node:path'
import { createMockServer } from './mock-server.mjs'
import { createErrorTrackingApi } from './mock-api.mjs'
import { collectDist, collectEvents, collectInjection, collectIntegrity, collectSymbolSets, expectedThrows, listDist } from './collect.mjs'
import { runCommand } from './commands.mjs'
import { prepareWorkspace, runProcess } from './lifecycle.mjs'
import { runHttpLifecycle } from './runtime-http.mjs'
import { runBrowser, openPage } from './runtime-browser.mjs'

const API_KEY = 'phx_harness_personal_key'
const PROJECT_ID = '4242'
const RELEASE_NAME = 'harness-app'
const PLUGIN_ERROR = /Error injecting PostHog|Error running PostHog|release resolve failed|Command failed with code|ERROR posthog_cli|panicked/

function run(command, args, { cwd, env, log, input, timeout = 180_000 }) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, { cwd, env, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] })
        if (input !== undefined) child.stdin.end(input)
        let output = ''
        child.stdout.on('data', (data) => (output += data))
        child.stderr.on('data', (data) => (output += data))
        const timer = setTimeout(() => child.kill('SIGKILL'), timeout)
        child.once('error', (error) => {
            clearTimeout(timer)
            reject(error)
        })
        child.once('close', (code, signal) => {
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

async function buildFixture({ fixture, work, options, binPath, extra, log, tokens }) {
    return runCommand(fixture.lifecycle.build, { work, tokens,
        env: sandboxEnv(work, { PATH: binPath, NEXT_TELEMETRY_DISABLED: '1', POSTHOG_HARNESS_OPTIONS: JSON.stringify(options), ...(extra ?? {}) }), log })
}

async function runFixture({ fixture, work, options, host, binPath, mock, log, replay, tokens }) {
    const env = sandboxEnv(work, {
        PATH: binPath,
        POSTHOG_HARNESS_HOST: host,
        POSTHOG_HARNESS_OPTIONS: JSON.stringify(options),
        NEXT_TELEMETRY_DISABLED: '1',
    })
    if (fixture.lifecycle.runtime.driver === 'process') return runProcess({ fixture, work, env, tokens, log })
    if (fixture.lifecycle.runtime.driver === 'browser') return runBrowser({ fixture, work, host, replay,
        expectedEvents: Object.keys(fixture.throws).length, mock, log })
    if (fixture.lifecycle.runtime.driver === 'http') {
        const browserTriggers = fixture.lifecycle.triggers.filter((trigger) => trigger.kind === 'browser')
        const visitBrowser = browserTriggers.length && (async ({ origin }) => {
            const result = { code: 0, pageErrors: [], consoleErrors: [], failedRequests: [], replayed: [] }
            let expected = fixture.lifecycle.triggers.filter((trigger) => trigger.kind === 'http')
                .reduce((count, trigger) => count + trigger.expects.length, 0)
            for (const trigger of browserTriggers) {
                expected += trigger.expects.length
                const page = await openPage({ origin, page: trigger.page, host, expectedEvents: expected, mock, replay })
                if (page.code !== 0) result.code = 1
                result.pageErrors.push(...page.pageErrors)
                result.consoleErrors.push(...page.consoleErrors)
                result.failedRequests.push(...page.failedRequests)
                result.replayed.push(...page.replayed)
            }
            return result
        })
        return runHttpLifecycle({ fixture, work, env, tokens, log, visitBrowser })
    }
    if (fixture.lifecycle.runtime.driver === 'none') return null
    throw new Error(`${fixture.name}: unsupported runtime driver ${fixture.lifecycle.runtime.driver}`)
}

export async function executeCase({ cli, fixture, kase, overrides, output }) {
    mkdirSync(output, { recursive: true })
    const work = mkdtempSync(path.join(tmpdir(), 'error-tracking-harness-'))
    const api = createErrorTrackingApi({ apiKey: API_KEY, projectId: PROJECT_ID, fault: kase.fault, server: kase.server })
    const mock = createMockServer({ adapter: (request) => api.route(request) })
    let apiStarted = false
    let mockStarted = false
    const evidence = {
        cli,
        fixture: {
            name: fixture.name,
            bundler: fixture.bundler,
            version: fixture.version,
            runtime: fixture.lifecycle.runtime.driver,
            immutable: fixture.immutable ?? null,
            volatileChunks: fixture.volatileChunks ?? [],
            optionalIds: fixture.optionalIds ?? [],
        },
        plugin: null,
        case: kase.name,
        selection: Object.fromEntries([...overrides ?? []].map(([name, entry]) => [name, entry.tarball])),
        throws: null,
        git: null,
        releases: [],
        afterFinalUpload: null,
    }
    try {
        await api.start()
        apiStarted = true
        const host = await mock.start()
        mockStarted = true
        cpSync(fixture.dir, work, { recursive: true, filter: (source) => !/\/(node_modules|dist)(\/|$)/.test(source) })
        if (kase.git) evidence.git = createRepository(work, kase.git)
        const binPath = `${path.join(work, 'node_modules/.bin')}${path.delimiter}${process.env.PATH}`
        const baseTokens = { work, host, cliPath: cli.path }
        evidence.plugin = await prepareWorkspace({ fixture, work, overrides, tokens: baseTokens,
            env: sandboxEnv(work, { PATH: binPath, POSTHOG_HARNESS_HOST: host, POSTHOG_HARNESS_CLI: cli.path ?? '' }) })
        evidence.throws = expectedThrows(work, fixture)
        const dist = path.join(work, fixture.lifecycle.outputs.root)
        const releaseIds = []
        const previousReleases = []
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
            // Run the fixture script without a package manager, with only the sandboxed environment.
            const tokens = { ...baseTokens, releaseVersion }
            const build = await buildFixture({ fixture, work, options, binPath, extra: kase.env, tokens,
                log: path.join(output, `${tag}-build.log`) })
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
            let served = null
            if (build.code === 0) {
                // Replay the prior release's immutable assets while loading the new page, as a
                // browser with cached files would across a deployment.
                const previousDist = index > 0 && fixture.immutable ? path.join(output, `release-1.0.${index - 1}-dist`) : null
                const prefix = fixture.lifecycle.runtime.browser?.urlPrefix ?? '/'
                const replay = previousDist && ['http', 'browser'].includes(fixture.lifecycle.runtime.driver)
                    ? (pathname) => {
                          if (!pathname.startsWith(prefix)) return undefined
                          const relative = pathname.slice(prefix.length)
                          if (!matchesGlob(relative, fixture.immutable)) return undefined
                          const file = path.join(previousDist, relative)
                          return existsSync(file) ? readFileSync(file) : undefined
                      }
                    : undefined
                runtime = await runFixture({ fixture, work, options, host, binPath, mock, replay, tokens,
                    log: path.join(output, `${tag}-runtime.log`) })
                served = runtime?.origin && {
                    origin: runtime.origin,
                    root: path.join(work, fixture.lifecycle.runtime.browser?.root ?? fixture.lifecycle.runtime.serve ?? '.'),
                    strip: fixture.lifecycle.runtime.browser?.urlPrefix ?? '',
                }
                if (runtime) events = collectEvents({ events: mock.inspect().events, chunks, api: state, work, throws: evidence.throws, served })
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
                runtime: runtime && { code: runtime.code, signal: runtime.signal ?? null, requests: runtime.requests ?? null, pageErrors: runtime.pageErrors ?? null, failedRequests: runtime.failedRequests ?? null, replayed: runtime.replayed ?? null },
                events,
                mockErrors: [...state.errors, ...mock.inspect().errors],
            })
            // Keep what each later release needs for the cross-release checks.
            previousReleases.push({ chunks, events: mock.inspect().events, served })
        }

        // Re-resolve the first release's exceptions against what the server holds at the end.
        const first = previousReleases[0]
        if (previousReleases.length > 1 && first.events.length) {
            evidence.afterFinalUpload = {
                events: collectEvents({ events: first.events, chunks: first.chunks, api: api.snapshot(), work, throws: evidence.throws, served: first.served }),
            }
        }
        writeFileSync(path.join(output, 'evidence.json'), JSON.stringify(evidence, null, 2))
        if (evidence.git?.worktree) rmSync(`${work}-repository`, { recursive: true, force: true })
        return { evidence, work }
    } catch (error) {
        // A harness error is still diagnosable: keep the partial workspace and its path.
        const repository = `${work}-repository`
        writeFileSync(path.join(output, 'workspace.txt'), work + '\n' + (existsSync(repository) ? repository + '\n' : ''))
        throw error
    } finally {
        try {
            if (mockStarted) await mock.stop()
        } finally {
            if (apiStarted) await api.stop()
        }
    }
}

export function discardWork(work) {
    rmSync(work, { recursive: true, force: true })
}
