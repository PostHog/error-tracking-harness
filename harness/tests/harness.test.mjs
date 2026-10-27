import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { judge } from '../judge.mjs'
import { cliAtLeast, compareVersions, loadCases, loadFixtures, planMatrix } from '../plan.mjs'
import { validateCase, validateFixture } from '../validate.mjs'
import { createErrorTrackingApi } from '../mock-api.mjs'
import { collectEvents } from '../collect.mjs'
import { executeCase } from '../execute.mjs'
import { decodeSymbolSet, originalPosition } from '../symbol-data.mjs'

const root = path.resolve(import.meta.dirname, '../..')

test('fixture defaults resolve without installed dependencies', () => {
    const fixtures = loadFixtures(path.join(root, 'fixtures'))
    assert.ok(fixtures.length >= 13)
    const next = fixtures.find((fixture) => fixture.name === 'next-14')
    const turbo = fixtures.find((fixture) => fixture.name === 'next-16-turbopack')
    assert.equal(next.lifecycle.runtime.driver, 'http')
    assert.equal(next.plugin, '@posthog/nextjs-config')
    assert.equal(next.throws.lazy.file, 'lib/lazy.js')
    assert.equal(next.distIgnore.length, 3)
    assert.equal(next.lifecycle.runtime.browser.page, '/client')
    assert.equal(next.throws['browser-entry'].file, 'lib/boom.js')
    assert.equal(next.immutable, 'static/**')
    assert.equal(fixtures.find((fixture) => fixture.name === 'vite-8-sri').lifecycle.runtime.driver, 'browser')
    assert.equal(fixtures.find((fixture) => fixture.name === 'vite-8-autocapture').mode, 'autoexception')
    assert.equal(turbo.distIgnore.length, 3)
    assert.ok(loadCases(path.join(root, 'harness/cases')).length >= 15)
})

test('matrix can be planned from metadata alone', () => {
    const fixtures = loadFixtures(path.join(root, 'fixtures'), ['next-14'])
    const cases = loadCases(path.join(root, 'harness/cases'), 'next/baseline-event')
    const clis = [{ label: '0.18.11', version: '0.18.11', path: null }]
    const plugins = new Map([['next-14', { name: '@posthog/nextjs-config', version: '1.11.4' }]])
    const entries = planMatrix({ fixtures, cases, clis, plugins, metadataOnly: true })
    assert.equal(entries.length, 1)
    assert.equal(entries[0].skipped, undefined)
})

test('an untagged autocaptured exception is identified by its type and value', () => {
    const [event] = collectEvents({ events: [{ event: '$exception', properties: { $exception_list: [
        { type: 'Error', value: 'boom from uncaught exception', mechanism: { handled: false }, stacktrace: { type: 'raw', frames: [] } },
    ] } }], chunks: [], api: { symbolSets: [] }, work: '/tmp', throws: {
        uncaught: { type: 'Error', value: 'boom from uncaught exception', autocaptured: true },
    } })
    assert.equal(event.case, 'uncaught')
    assert.equal(event.mechanism.handled, false)
})

test('versions respect prereleases and missing fixture CLI versions', () => {
    assert.ok(compareVersions('1.2.0', '1.2.0-rc.1') > 0)
    assert.ok(compareVersions('1.2.0-rc.1', '1.2.0') < 0)
    assert.ok(compareVersions('1.2.0-rc.10', '1.2.0-rc.2') > 0)
    assert.equal(cliAtLeast({ version: 'unknown' }, '0.18.11'), false)
})

test('configuration typos and invalid combinations fail early', () => {
    assert.throws(() => validateCase({ expec: {} }, 'typo'), /unknown field expec/)
    assert.throws(() => validateCase({ mode: 'plugin', cli: { command: 'process' } }, 'wrong'), /cli steps require cli mode/)
    assert.throws(() => validateCase({ releases: 0 }, 'wrong'), /positive integer/)
    assert.throws(() => validateFixture({ mode: 'cli', bundler: 'rollup', tags: ['cli'], throws: {}, plugin: 'plugin' }, 'wrong'), /cannot use a plugin/)
    const { name: _name, dir: _dir, ...auto } = loadFixtures(path.join(root, 'fixtures'), ['vite-8-autocapture'])[0]
    auto.lifecycle.triggers[0].pageErrors = ['']
    assert.throws(() => validateFixture(auto, 'vite-8-autocapture'), /invalid expected page errors/)
})

const chunk = (file) => ({ file, chunkId: null, cliSkipped: null, sourceMappingURL: false })
function evidence(chunks, mapsLeft) {
    return {
        cli: { label: '0.18.11', version: '0.18.11' },
        fixture: { name: 'example', bundler: 'webpack', runtime: 'none' },
        plugin: { name: '@posthog/webpack-plugin', version: '1.0.0' },
        releases: [{ releaseVersion: '1.0.0', build: { code: 0, pluginError: false },
            chunks, mapsLeft, symbolSets: [], mockErrors: [], integrity: null }],
    }
}

test('mapsBy does not exempt unmatched files from cleanup', () => {
    const kase = { expect: { chunkIds: 'any', symbols: 'none', maps: 'deleted',
        mapsBy: { 'static/**': 'kept-hidden' } } }
    const result = judge(evidence([chunk('static/entry.js'), chunk('server/lazy.js')],
        ['static/entry.js.map', 'server/lazy.js.map']), kase)
    assert.equal(result.ok, false)
    assert.match(result.failures.join('\n'), /maps kept-hidden.*expected deleted/)
    assert.doesNotMatch(judge(evidence([chunk('static/entry.js'), chunk('server/lazy.js')],
        ['static/entry.js.map']), kase).failures.join('\n'), /maps .*expected/)
})

test('autocapture fails if the lazy exception script was not fetched', () => {
    const sample = evidence([chunk('entry.js'), chunk('lazy.js')], [])
    sample.fixture.mode = 'autoexception'
    assert.match(judge(sample, {}).failures.join('\n'), /exception-autocapture script was not fetched/)
})

test('judge-only refreshes the summary and report from saved evidence', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'harness-judge-test-'))
    try {
        const output = path.join(dir, 'cell')
        mkdirSync(output)
        writeFileSync(path.join(output, 'evidence.json'), JSON.stringify({
            ...evidence([chunk('entry.js'), chunk('lazy.js')], []),
            case: 'baseline/event', throws: {},
        }))
        // The synthetic evidence fails the baseline, but must still produce a complete report.
        try {
            execFileSync(process.execPath, [path.join(root, 'harness/run.mjs'), '--judge-only', dir])
            assert.fail('expected the synthetic evidence to fail')
        } catch (error) {
            assert.equal(error.status, 1)
        }
        assert.equal(JSON.parse(readFileSync(path.join(dir, 'summary.json'), 'utf8')).total, 1)
        assert.match(readFileSync(path.join(dir, 'report.md'), 'utf8'), /baseline\/event/)
    } finally {
        rmSync(dir, { recursive: true, force: true })
    }
})

test('executeCase keeps a failed workspace and closes servers', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'harness-execute-test-'))
    let work
    try {
        const fixtureDir = path.join(dir, 'fixture')
        const output = path.join(dir, 'output')
        mkdirSync(fixtureDir)
        await assert.rejects(executeCase({
            cli: { label: 'test' }, fixture: { name: 'test', dir: fixtureDir, mode: 'cli', lifecycle: { workspace: { adapter: 'node-modules' }, runtime: { driver: 'process' } } },
            kase: { name: 'test' }, selection: 'latest', subject: new Map(), output,
        }))
        work = readFileSync(path.join(output, 'workspace.txt'), 'utf8').trim()
        assert.ok(work.startsWith(tmpdir()))
    } finally {
        if (work) rmSync(work, { recursive: true, force: true })
        rmSync(dir, { recursive: true, force: true })
    }
})

test('symbol data decodes and indexed source maps resolve', () => {
    const map = { sources: ['src/boom.js'], names: [], sourcesContent: ['throw new Error()'], mappings: 'AAAA' }
    const source = Buffer.from('throw new Error()')
    const mapped = Buffer.from(JSON.stringify(map))
    const payload = Buffer.alloc(16 + source.length + mapped.length)
    payload.writeBigUInt64LE(BigInt(source.length), 0)
    source.copy(payload, 8)
    payload.writeBigUInt64LE(BigInt(mapped.length), 8 + source.length)
    mapped.copy(payload, 16 + source.length)
    const header = Buffer.alloc(8)
    header.writeUInt32LE(1, 0)
    header.writeUInt32LE(2, 4)
    const decoded = decodeSymbolSet(Buffer.concat([Buffer.from('posthog_error_tracking'), header, payload]))
    assert.equal(decoded.minifiedSource, source.toString())
    assert.deepEqual(originalPosition({ sections: [{ offset: { line: 2, column: 0 }, map: decoded.sourcemap }] }, 3, 1),
        { source: 'src/boom.js', line: 1, column: 0, name: undefined, hasContent: true })
})

test('mock API applies faults and records calls', () => {
    const api = createErrorTrackingApi({ apiKey: 'key', projectId: '42', fault: { api: 'releases', status: 500 } })
    const response = api.route({ method: 'POST', path: '/api/projects/42/error_tracking/releases',
        headers: { authorization: 'Bearer key' }, body: {} })
    assert.equal(response.status, 500)
    assert.equal(api.snapshot().calls[0].status, 500)
    api.clearCalls()
    assert.equal(api.snapshot().calls.length, 0)
})
