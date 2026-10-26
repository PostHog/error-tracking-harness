import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { runCommand } from '../commands.mjs'
import { prepareWorkspace, runProcess } from '../lifecycle.mjs'
import { runHttpLifecycle } from '../runtime-http.mjs'
import { runBrowser, openPage } from '../runtime-browser.mjs'
import { validateFixture, validateLifecycle } from '../validate.mjs'
import { loadCases, loadFixtures, planMatrix } from '../plan.mjs'
import { selectedPlugin } from '../subject.mjs'

const root = path.resolve(import.meta.dirname, '../..')
const throws = { entry: { file: 'boom.js', marker: 'throw' }, lazy: { file: 'lazy.js', marker: 'throw' } }
const processLifecycle = () => ({
    workspace: { adapter: 'command', command: { argv: ['sh', '-c', 'true'] } },
    build: { argv: ['sh', '-c', 'true'] }, outputs: { root: 'dist' },
    runtime: { driver: 'process' },
    triggers: [{ kind: 'process', command: { argv: ['sh', '-c', 'true'] }, expects: ['entry', 'lazy'] }],
})

test('tag-selected and override-planned matrices retain their pre-migration cells', () => {
    const before = JSON.parse(readFileSync(path.join(root, 'harness/tests/baselines/lifecycle-before.json'), 'utf8'))
    const fixtures = loadFixtures(path.join(root, 'fixtures'), undefined, ['next','browser','nuxt','cli','webpack','vite','rollup'])
    const cases = loadCases(path.join(root, 'harness/cases'), 'baseline/event,next/baseline-event,nuxt/baseline,cli/process-twice')
    const plugins = new Map(fixtures.map(f => [f.name, selectedPlugin(f, new Map(), { metadataOnly: true })]))
    const clis = ['0.18.0','0.18.11'].map(version => ({ label: version, version }))
    const current = planMatrix({ fixtures, cases, clis, plugins }).map(e => ({ fixture: e.fixture.name, case: e.kase.name, cli: e.cli.label, skip: e.skipped ?? null }))
    assert.deepEqual(current, before.matrix)
    const overrides = new Map([['@posthog/nextjs-config',{manifest:{name:'@posthog/nextjs-config',version:'1.12.0'}}],['next',{manifest:{name:'next',version:'16.3.8'}}]])
    const tagged = loadFixtures(path.join(root, 'fixtures'), undefined, ['next','browser'])
    const selectedCases = loadCases(path.join(root, 'harness/cases'), 'next/baseline-event,baseline/event')
    const versions = new Map(tagged.map(f => [f.name, selectedPlugin(f, overrides, { metadataOnly: true })]))
    const cli = { label: 'override', version: 'custom', path: '/subject/posthog-cli' }
    const selected = planMatrix({ fixtures: tagged, cases: selectedCases, clis: [cli], plugins: versions }).map(e => ({ fixture: e.fixture.name, case: e.kase.name, cli: e.cli.label, plugin: e.plugin, skipped: e.skipped ?? null }))
    assert.deepEqual(selected, JSON.parse(readFileSync(path.join(root, 'harness/tests/baselines/lifecycle-overrides.json'), 'utf8')))
})

test('lifecycle validation rejects missing commands, tokens and mismatched triggers', () => {
    const valid = processLifecycle()
    validateLifecycle(valid, 'shell', throws)
    const fixture = { bundler: 'shell', mode: 'shell-smoke', tags: ['shell'], throws, lifecycle: valid }
    validateFixture(fixture, 'shell')
    assert.throws(() => validateLifecycle({ ...valid, build: {} }, 'shell', throws), /requires nonempty argv/)
    assert.throws(() => validateLifecycle({ ...valid, build: { argv: ['{unknown}'] } }, 'shell', throws), /unknown command token/)
    assert.throws(() => validateLifecycle({ ...valid, outputs: { root: '../outside' } }, 'shell', throws), /invalid outputs.root/)
    assert.throws(() => validateLifecycle({ ...valid, triggers: [{ kind: 'http', path: '/throw', expects: ['entry', 'lazy'] }] }, 'shell', throws), /invalid trigger/)
    assert.throws(() => validateLifecycle({ ...valid, triggers: [{ kind: 'process', command: { argv: ['true'] }, expects: ['entry'] }] }, 'shell', throws), /do not cover/)
})

test('argv runner preserves quoting, isolates env, expands documented tokens and records failures', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'lifecycle-command-'))
    try {
        const child = path.join(dir, 'sub'); mkdirSync(child)
        const log = path.join(dir, 'build.log')
        const command = { argv: [process.execPath, '-e', 'console.log(JSON.stringify(Object.fromEntries([["args",process.argv.slice(1)],["secret",process.env.LEAK_ME??null],["cwd",process.cwd()],["host",process.env.HOST]])))', 'a b', '{releaseVersion}'], cwd: 'sub', env: { HOST: '{host}' } }
        const result = await runCommand(command, { work: dir, tokens: { releaseVersion: '1.0.0', host: 'http://127.0.0.1:42' }, env: { PATH: process.env.PATH }, log })
        assert.equal(result.code, 0)
        assert.deepEqual(JSON.parse(result.output), { args: ['a b', '1.0.0'], secret: null, cwd: realpathSync(child), host: 'http://127.0.0.1:42' })
        assert.equal(readFileSync(log, 'utf8'), result.output)
        const failure = await runCommand({ argv: [process.execPath, '-e', 'process.exit(7)'] }, { work: dir, env: { PATH: process.env.PATH } })
        assert.equal(failure.code, 7)
        await assert.rejects(runCommand({ argv: ['/missing/lifecycle-command'] }, { work: dir, env: { PATH: process.env.PATH } }), /ENOENT/)
    } finally {
        rmSync(dir, { recursive: true, force: true })
    }
})

test('POSIX-shell workspace/build/process lifecycle needs no Node project or entry', async () => {
    const work = mkdtempSync(path.join(tmpdir(), 'lifecycle-shell-'))
    try {
        const lifecycle = processLifecycle()
        lifecycle.workspace.command = { argv: ['sh', '-c', 'printf prepared > prepared'] }
        lifecycle.build = { argv: ['sh', '-c', 'mkdir -p dist && printf "%s" "$RELEASE" > dist/artifact.js'], env: { RELEASE: '{releaseVersion}', CLI: '{cliPath}' } }
        lifecycle.triggers = [{ kind: 'process', expects: ['entry', 'lazy'], command: { argv: ['sh', '-c', 'test "$(cat prepared)" = prepared && test "$(cat dist/artifact.js)" = 1.0.1 && printf event'] } }]
        const fixture = { name: 'shell', lifecycle }
        const env = { PATH: process.env.PATH, HOME: work }
        const tokens = { releaseVersion: '1.0.1', cliPath: '/offline/posthog-cli' }
        const plugin = await prepareWorkspace({ fixture, work, env, tokens })
        assert.equal(plugin.source, 'command')
        const build = await runCommand(lifecycle.build, { work, env, tokens })
        assert.equal(build.code, 0)
        const runtime = await runProcess({ fixture, work, env, tokens })
        assert.equal(runtime.code, 0)
        assert.equal(runtime.output, 'event')
        assert.equal(readFileSync(path.join(work, 'dist/artifact.js'), 'utf8'), '1.0.1')
        await assert.rejects(prepareWorkspace({ fixture, work, env, tokens, overrides: new Map([['plugin', {}]]) }), /no binding/)
        lifecycle.triggers[0].command.argv = ['sh', '-c', 'exit 9']
        assert.equal((await runProcess({ fixture, work, env, tokens })).code, 9)
    } finally {
        rmSync(work, { recursive: true, force: true })
    }
})

test('HTTP driver serves declared triggers, times out, detects early exits and cleans up', async () => {
    const work = mkdtempSync(path.join(tmpdir(), 'lifecycle-http-'))
    try {
        const start = { argv: [process.execPath, '-e', 'require("node:fs").writeFileSync("pid",String(process.pid));require("node:http").createServer((req,res)=>res.end(req.url)).listen(process.env.PORT,"127.0.0.1")'] }
        const fixture = { lifecycle: { runtime: { driver: 'http', start, portEnv: ['PORT'], ready: { path: '/ready', timeoutMs: 3000 } },
            triggers: [{ kind: 'http', path: '/api/throw', expects: ['entry'] }] } }
        const env = { PATH: process.env.PATH, HOME: work }
        const result = await runHttpLifecycle({ fixture, work, env })
        assert.equal(result.code, 0)
        assert.equal(result.requests[0].body, '/api/throw')
        assert.equal(result.requests[0].status, 200)
        const pid = Number(readFileSync(path.join(work, 'pid'), 'utf8'))
        assert.throws(() => process.kill(pid, 0), /ESRCH/)
        // An attached Chromium page must be able to load a prior release's immutable bytes.
        fixture.lifecycle.runtime.start = { argv: [process.execPath, '-e', 'require("node:http").createServer((req,res)=>{if(req.url.startsWith("/client"))res.setHeader("Content-Type","text/html");res.end(req.url.startsWith("/client")?"<script src=/static/app.js></script>":"new-release-asset")}).listen(process.env.PORT,"127.0.0.1")'] }
        const attached = await runHttpLifecycle({ fixture, work, env,
            visitBrowser: ({ origin }) => openPage({ origin, page: '/client', host: 'http://127.0.0.1:9',
                expectedEvents: 0, mock: { inspect: () => ({ events: [] }) },
                replay: pathname => pathname === '/static/app.js' ? 'globalThis.oldAsset = true' : undefined,
                captureTimeoutMs: 200 }) })
        assert.equal(attached.code, 0)
        assert.deepEqual(attached.replayed, ['/static/app.js'])
        fixture.lifecycle.runtime.start = { argv: [process.execPath, '-e', 'process.exit(5)'] }
        assert.equal((await runHttpLifecycle({ fixture, work, env })).code, -1)
        fixture.lifecycle.runtime.start = { argv: [process.execPath, '-e', 'require("node:fs").writeFileSync("pid",String(process.pid));setInterval(()=>{},1000)'] }
        fixture.lifecycle.runtime.ready.timeoutMs = 300
        assert.equal((await runHttpLifecycle({ fixture, work, env })).code, -1)
        assert.throws(() => process.kill(Number(readFileSync(path.join(work, 'pid'), 'utf8')), 0), /ESRCH/)
    } finally { rmSync(work, { recursive: true, force: true }) }
})

test('browser driver records replay, missing events and page errors without leaking the server', async () => {
    const work = mkdtempSync(path.join(tmpdir(), 'lifecycle-browser-'))
    try {
        const dist = path.join(work, 'dist'); mkdirSync(dist)
        const fixture = { lifecycle: { runtime: { driver: 'browser', serve: 'dist' },
            triggers: [{ kind: 'browser', page: '/index.html', expects: ['entry'] }] } }
        const mock = { inspect: () => ({ events: [] }) }
        writeFileSync(path.join(dist, 'index.html'), '<script src="/asset.js"></script>')
        const replay = pathname => pathname === '/asset.js' ? 'globalThis.wasReplayed = true' : undefined
        const result = await runBrowser({ fixture, work, host: 'http://127.0.0.1:9', expectedEvents: 0, mock, replay, captureTimeoutMs: 200 })
        assert.equal(result.code, 0)
        assert.deepEqual(result.replayed, ['/asset.js'])
        assert.equal(result.pageErrors.length, 0)
        const missing = await runBrowser({ fixture, work, host: 'http://127.0.0.1:9', expectedEvents: 1, mock, replay, captureTimeoutMs: 200 })
        assert.equal(missing.code, 1)
        writeFileSync(path.join(dist, 'asset.js'), 'throw new Error("page broke")')
        const error = await runBrowser({ fixture, work, host: 'http://127.0.0.1:9', expectedEvents: 0, mock, captureTimeoutMs: 200 })
        assert.equal(error.code, 1)
        assert.match(error.pageErrors.join(' '), /page broke/)
    } finally { rmSync(work, { recursive: true, force: true }) }
})

test('node-modules workspace still delegates to the named package adapter', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'lifecycle-node-'))
    try {
        const dir = path.join(root, 'fixture'), work = path.join(root, 'work')
        mkdirSync(path.join(dir, 'node_modules/smoke'), { recursive: true }); mkdirSync(work)
        writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ devDependencies: { smoke: '1.0.0' } }))
        writeFileSync(path.join(dir, 'node_modules/smoke/package.json'), JSON.stringify({ name: 'smoke', version: '1.0.0' }))
        const fixture = { name: 'node-smoke', plugin: 'smoke', dir, lifecycle: { workspace: { adapter: 'node-modules' } } }
        const result = await prepareWorkspace({ fixture, work })
        assert.equal(result.version, '1.0.0')
        assert.equal(readFileSync(path.join(work, 'node_modules/smoke/package.json'), 'utf8'), readFileSync(path.join(dir, 'node_modules/smoke/package.json'), 'utf8'))
    } finally { rmSync(root, { recursive: true, force: true }) }
})
