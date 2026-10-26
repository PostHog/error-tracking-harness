import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { judge } from '../judge.mjs'
import { coverage } from '../coverage.mjs'
import { loadCases, loadFixtures, planMatrix } from '../plan.mjs'
import { loadOverrides, prepareNodeModules, selectedPlugin } from '../subject.mjs'
import { validateCase } from '../validate.mjs'

const root = path.resolve(import.meta.dirname, '../..')
const cli = { label: '0.18.11', version: '0.18.11' }
const kase = { releases: 2 }
const symbol = (id, file) => ({ chunkId: id, file, finished: true, decoded: true, releaseId: null, storedMatchesDisk: 'exact' })
function release(version, files, releaseId = version) {
    return {
        releaseVersion: version, releaseId, build: { code: 0, pluginError: false }, runtime: { code: 0, replayed: ['/static/x.js'] },
        chunks: files.map(([file, chunkId]) => ({ file, chunkId, sourceMappingURL: false })), mapsLeft: [],
        symbolSets: files.map(([file, id]) => symbol(id, file)), mockErrors: [],
        events: [{ case: 'entry', type: 'Error', value: 'boom', stacktraceType: 'raw', releaseId,
            frames: [{ file: files[0][0], chunkId: files[0][1], expectedChunkId: files[0][1] }],
            crash: { file: files[0][0], symbolSet: true, resolved: { source: 'src/boom.js', line: 4, hasContent: true } } }],
    }
}
function evidence() {
    const first = release('1.0.0', [['first-entry.js', 'a'], ['first-lazy.js', 'b']])
    const second = release('1.0.1', [['renamed-entry.js', 'a'], ['renamed-lazy.js', 'b']])
    return { cli, plugin: { name: '@posthog/webpack-plugin', version: '1.7.0' },
        fixture: { name: 'example', bundler: 'webpack', runtime: 'node' },
        throws: { entry: { file: 'src/boom.js', line: 4, type: 'Error', value: 'boom' } },
        releases: [first, second], afterFinalUpload: { events: structuredClone(first.events) } }
}

test('renamed chunks compare IDs, not names; empty and changed sets fail', () => {
    assert.equal(judge(evidence(), kase).ok, true)
    const changed = evidence()
    changed.releases[1].chunks[0].chunkId = 'changed'
    assert.match(judge(changed, kase).failures.join('\n'), /chunk ids changed/)
    const excluded = evidence()
    excluded.fixture.volatileChunks = ['**/*.js']
    assert.match(judge(excluded, kase).failures.join('\n'), /no non-volatile chunks/)
})

test('missing, stale or mismatched successive-build evidence fails', () => {
    const absent = evidence(); absent.releases.pop()
    assert.match(judge(absent, kase).failures.join('\n'), /expected 2 releases/)
    const noRecheck = evidence(); noRecheck.afterFinalUpload = null
    assert.match(judge(noRecheck, kase).failures.join('\n'), /missing first-release events/)
    const noEvents = evidence(); noEvents.releases[1].events = null
    assert.match(judge(noEvents, kase).failures.join('\n'), /missing runtime event evidence/)
    const stale = evidence(); stale.afterFinalUpload.events[0].releaseId = '1.0.1'
    assert.match(judge(stale, kase).failures.join('\n'), /\$release_id/)
    const wrong = evidence(); wrong.releases[1].events[0].releaseId = '1.0.0'
    assert.match(judge(wrong, kase).failures.join('\n'), /\$release_id/)
    const noReplay = evidence(); noReplay.fixture.immutable = 'static/**'; noReplay.releases[1].runtime.replayed = []
    assert.match(judge(noReplay, kase).failures.join('\n'), /no previous-release asset/)
})

test('historical defect expectations and plugin floors are rejected', () => {
    assert.throws(() => validateCase({ expect: { eventsBy: { entry: { foo: 'no-release' } } } }, 'bad'), /invalid expect.eventsBy/)
    assert.throws(() => validateCase({ minPlugin: { foo: '1.0.0' } }, 'bad'), /unknown field minPlugin/)
    assert.throws(() => validateCase({ fault: {} }, 'bad'), /unknown field fault/)
    const bad = evidence(); bad.releases[0].events[0].releaseId = null
    assert.equal(judge(bad, { releases: 2, expect: { eventsBy: { entry: 'no-release' } } }).ok, false)
})

test('tags use OR, intersect names, and skipped Next pairs remain uncovered', () => {
    const fixtures = loadFixtures(path.join(root, 'fixtures'), undefined, ['next', 'sri'])
    assert.ok(fixtures.some((fixture) => fixture.name === 'next-15'))
    assert.ok(fixtures.some((fixture) => fixture.name === 'vite-8-sri'))
    assert.deepEqual(loadFixtures(path.join(root, 'fixtures'), ['next-15'], ['browser']).map((fixture) => fixture.name), ['next-15'])
    assert.throws(() => loadFixtures(path.join(root, 'fixtures'), undefined, ['missing']), /Unknown fixture tag/)
    const next = loadFixtures(path.join(root, 'fixtures'), ['next-15', 'next-16-webpack'])
    const cases = loadCases(path.join(root, 'harness/cases'), 'next/baseline-event')
    const plugins = new Map(next.map((fixture) => [fixture.name, { name: fixture.plugin, version: '1.0.0' }]))
    const matrix = planMatrix({ fixtures: next, cases, clis: [cli], plugins })
    assert.equal(matrix.length, 2)
    assert.equal(matrix.filter((cell) => cell.skipped).length, 0) // no plugin-age skip
    assert.match(coverage(next, cases, matrix, [{ fixture: 'next-15', case: cases[0].name }])[0], /^next-16-webpack\/next\/baseline-event/)
    assert.equal(coverage(next, cases, matrix, []).length, 2)
    assert.equal(coverage(next, loadCases(path.join(root, 'harness/cases'), 'baseline/event'), [], []).length, 1)
})

test('applicability accepts new labels without a planner or driver switch', () => {
    const fixture = { name: 'shell-smoke', mode: 'shell-smoke', tags: ['shell'], plugin: 'example' }
    const kase = { name: 'shell-smoke/entry', mode: 'shell-smoke' }
    const plugins = new Map([[fixture.name, { name: 'example', version: '1.0.0' }]])
    const matrix = planMatrix({ fixtures: [fixture], cases: [kase], clis: [cli], plugins })
    assert.equal(matrix.length, 1)
    assert.deepEqual(coverage([fixture], [kase], matrix, [{ fixture: fixture.name, case: kase.name }]), [])
    validateCase({ mode: 'shell-smoke' }, kase.name)
    assert.throws(() => validateCase({ mode: 'Bad Label' }, 'bad'), /invalid applicability/)
    assert.match(coverage([fixture], [{ ...kase, mode: 'another-kind' }], [], [])[0], /no applicable case/)
})

function withDir(fn) {
    const dir = mkdtempSync(path.join(tmpdir(), 'harness-overrides-'))
    try { return fn(dir) } finally { rmSync(dir, { recursive: true, force: true }) }
}
function pack(dir, name, version, dependencies = {}) {
    const folder = path.join(dir, 'package')
    mkdirSync(folder, { recursive: true })
    writeFileSync(path.join(folder, 'package.json'), JSON.stringify({ name, version, dependencies }))
    const file = path.join(dir, `${name.replaceAll('/', '-')}.tgz`)
    execFileSync('tar', ['-czf', file, '-C', dir, 'package'])
    rmSync(folder, { recursive: true, force: true })
    return file
}

test('local overrides validate identity, version and executable', () => withDir((dir) => {
    const tarball = pack(dir, 'next', '15.6.0')
    const file = path.join(dir, 'overrides.json')
    writeFileSync(file, JSON.stringify({ packages: { next: tarball } }))
    assert.equal(loadOverrides(file).packages.get('next').manifest.version, '15.6.0')
    writeFileSync(file, JSON.stringify({ packages: { vite: tarball } }))
    assert.throws(() => loadOverrides(file), /expected package vite/)
    writeFileSync(file, JSON.stringify({ cli: '/missing/cli' }))
    assert.throws(() => loadOverrides(file), /not executable/)
    const binary = path.join(dir, 'posthog-cli')
    writeFileSync(binary, '#!/bin/sh\necho posthog-cli 0.18.13\n'); chmodSync(binary, 0o755)
    writeFileSync(file, JSON.stringify({ binaries: { 'posthog-cli': './posthog-cli' } }))
    assert.equal(loadOverrides(file).cli.reported, 'posthog-cli 0.18.13')
}))

test('plugin-only, framework-only and combined overrides retain other pinned packages', () => withDir((dir) => {
    const fixtureDir = path.join(dir, 'fixture'); const installed = path.join(fixtureDir, 'node_modules')
    for (const [name, version] of [['next', '15.5.0'], ['@posthog/nextjs-config', '1.11.3'], ['unrelated', '2.0.0']]) {
        const folder = path.join(installed, name); mkdirSync(folder, { recursive: true }); writeFileSync(path.join(folder, 'package.json'), JSON.stringify({ name, version }))
    }
    writeFileSync(path.join(fixtureDir, 'package.json'), JSON.stringify({ devDependencies: { next: '15.5.0', '@posthog/nextjs-config': '1.11.3', unrelated: '2.0.0' } }))
    const plugin = pack(dir, '@posthog/nextjs-config', '1.11.4', { next: '^15.0.0' })
    const framework = pack(dir, 'next', '15.6.0')
    const fixture = { name: 'test', plugin: '@posthog/nextjs-config' }
    for (const names of [['@posthog/nextjs-config'], ['next'], ['@posthog/nextjs-config', 'next']]) {
        const overrides = new Map(names.map((name) => [name, { tarball: name === 'next' ? framework : plugin,
            manifest: { name, version: name === 'next' ? '15.6.0' : '1.11.4', dependencies: name === 'next' ? {} : { next: '^15.0.0' } } }]))
        const work = path.join(dir, `work-${names.length}-${names[0] === 'next' ? 'next' : 'plugin'}`); mkdirSync(work)
        const selected = selectedPlugin({ ...fixture, dir: fixtureDir }, overrides)
        const result = prepareNodeModules({ fixtureDir, fixture, work, overrides })
        assert.equal(result.version, selected.version)
        assert.equal(JSON.parse(readFileSync(path.join(work, 'node_modules/unrelated/package.json'))).version, '2.0.0')
        assert.equal(result.framework.version, names.includes('next') ? '15.6.0' : '15.5.0')
        assert.equal(Object.keys(result.packages).length, names.length)
    }
    assert.throws(() => prepareNodeModules({ fixtureDir, fixture: { ...fixture, layout: 'pnpm-isolated' }, work: path.join(dir, 'not-used'), overrides: new Map([['next', { tarball: framework, manifest: { name: 'next', version: '15.6.0' } }]]) }), /unsupported override/)
}))

test('CLI list fails closed on all-skipped, unused overrides, and bad tag selections', () => withDir((dir) => {
    const run = (...args) => spawnSync(process.execPath, [path.join(root, 'harness/run.mjs'), '--list', '--cli', '0.18.0', ...args], { encoding: 'utf8' })
    const skipped = run('--fixtures', 'next-16-turbopack', '--cases', 'next/baseline-event')
    assert.equal(skipped.status, 1)
    assert.match(skipped.stdout, /uncovered: next-16-turbopack/)
    const tarball = pack(dir, 'next', '15.6.0')
    const file = path.join(dir, 'overrides.json')
    writeFileSync(file, JSON.stringify({ packages: { next: tarball } }))
    const unused = run('--fixtures', 'vite-8', '--cases', 'baseline/event', '--overrides', file)
    assert.equal(unused.status, 1)
    assert.match(unused.stderr, /Unused override next/)
    assert.equal(run('--tags', 'nonexistent').status, 1)
    const mixed = spawnSync(process.execPath, [path.join(root, 'harness/run.mjs'), '--list', '--cli', '0.18.0,0.18.11', '--fixtures', 'next-16-turbopack', '--cases', 'next/baseline-event'], { encoding: 'utf8' })
    assert.equal(mixed.status, 0)
    assert.match(mixed.stdout, /skipped: fixture needs posthog-cli/)
    assert.match(mixed.stdout, /1 cells; uncovered: none/)
    const plugin = pack(dir, '@posthog/nextjs-config', '1.99.0')
    writeFileSync(file, JSON.stringify({ packages: { '@posthog/nextjs-config': plugin } }))
    const selected = spawnSync(process.execPath, [path.join(root, 'harness/run.mjs'), '--list', '--cli', '0.18.11', '--cases', 'next/baseline-event', '--overrides', file], { encoding: 'utf8' })
    assert.equal(selected.status, 0)
    assert.match(selected.stdout, /next-15/)
    assert.doesNotMatch(selected.stdout, /vite-8/)
    assert.match(selected.stdout, /nextjs-config@1.99.0/)
}))
