import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { bindsPackage, prepareNodeModules } from '../subject.mjs'
import { renderReport } from '../report.mjs'

function pack(dir, name, version, dependencies = {}) {
    const folder = path.join(dir, 'package')
    mkdirSync(folder, { recursive: true })
    writeFileSync(path.join(folder, 'package.json'), JSON.stringify({ name, version, dependencies }))
    writeFileSync(path.join(folder, 'identity.txt'), `${name}@${version}\n`)
    const tarball = path.join(dir, `${name.replaceAll('/', '-')}-${version}.tgz`)
    execFileSync('tar', ['-czf', tarball, '-C', dir, 'package'])
    rmSync(folder, { recursive: true })
    return { tarball, manifest: { name, version, dependencies } }
}

function setup(dir) {
    const fixtureDir = path.join(dir, 'fixture')
    mkdirSync(fixtureDir)
    const coreOld = pack(dir, '@posthog/core', '1.59.1')
    const coreNew = pack(dir, '@posthog/core', '1.60.1')
    const pluginOld = pack(dir, '@posthog/webpack-plugin', '1.7.0', { '@posthog/core': '^1.59.1' })
    const pluginNew = pack(dir, '@posthog/webpack-plugin', '1.8.0', { '@posthog/core': '^1.60.1' })
    const extra = pack(dir, 'other', '2.0.0')
    const workspace = `nodeLinker: hoisted\nstoreDir: ${JSON.stringify(path.join(dir, 'store'))}\n`
    writeFileSync(path.join(fixtureDir, 'pnpm-workspace.yaml'), workspace + `overrides:\n  "@posthog/core": "file:${coreOld.tarball}"\n`)
    writeFileSync(path.join(fixtureDir, 'package.json'), JSON.stringify({ name: 'synthetic-fixture', private: true, packageManager: 'pnpm@11.7.0',
        devDependencies: { '@posthog/webpack-plugin': `file:${pluginOld.tarball}`, other: `file:${extra.tarball}`, '@posthog/core': `file:${coreOld.tarball}` } }))
    execFileSync('pnpm', ['install', '--offline', '--no-frozen-lockfile', '--ignore-scripts'], { cwd: fixtureDir, stdio: 'pipe' })
    execFileSync('pnpm', ['store', 'prune'], { cwd: fixtureDir, stdio: 'pipe' })
    writeFileSync(path.join(fixtureDir, 'pnpm-workspace.yaml'), workspace)
    const fixture = { name: 'synthetic', plugin: '@posthog/webpack-plugin', dir: fixtureDir }
    return { fixtureDir, fixture, coreOld, coreNew, pluginNew, extra }
}

function inDir(fn) {
    const dir = mkdtempSync(path.join(tmpdir(), 'harness-transitive-'))
    try { return fn(dir) } finally { rmSync(dir, { recursive: true, force: true }) }
}

test('pruned-store offline install binds transitive core alongside PR plugin and other overrides', () => inDir((dir) => {
    const { fixtureDir, fixture, coreNew, pluginNew, extra } = setup(dir)
    // Core is hoisted, but is not a direct dependency for this install scenario.
    const manifest = JSON.parse(readFileSync(path.join(fixtureDir, 'package.json')))
    delete manifest.devDependencies['@posthog/core']
    writeFileSync(path.join(fixtureDir, 'package.json'), JSON.stringify(manifest))
    const overrides = new Map([['@posthog/webpack-plugin', pluginNew], ['@posthog/core', coreNew], ['other', extra]])
    assert.equal(bindsPackage(fixture, '@posthog/core', overrides), true)
    const work = path.join(dir, 'work'); mkdirSync(work)
    for (const file of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml']) writeFileSync(path.join(work, file), readFileSync(path.join(fixtureDir, file)))
    const result = prepareNodeModules({ fixtureDir, fixture, work, overrides })
    assert.equal(result.version, '1.8.0')
    assert.deepEqual(Object.keys(result.packages), [...overrides.keys()])
    assert.equal(result.packages['@posthog/core'].version, '1.60.1')
    assert.equal(readFileSync(path.join(result.packages['@posthog/core'].installedPath, 'identity.txt'), 'utf8'), '@posthog/core@1.60.1\n')
    assert.ok(existsSync(result.packages['@posthog/core'].installedPath))
    const report = renderReport({ executed: 1, passed: 1, failed: 0, skipped: 0, uncovered: 0, seconds: 1,
        results: [{ cli: 'test', fixture: fixture.name, case: 'test', ok: true, plugin: `${result.name}@${result.version}`, packages: result.packages }] })
    assert.match(report, /installedPath/)
    assert.match(report, /1\.60\.1/)
}))

test('missing offline dependencies fail rather than using the baked version', () => inDir((dir) => {
    const { fixtureDir, fixture, coreNew } = setup(dir)
    const plugin = pack(dir, '@posthog/webpack-plugin', '1.9.0', { '@posthog/core': '^1.60.1', 'not-cached': '^9.0.0' })
    const work = path.join(dir, 'work'); mkdirSync(work)
    for (const file of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml']) writeFileSync(path.join(work, file), readFileSync(path.join(fixtureDir, file)))
    assert.throws(() => prepareNodeModules({ fixtureDir, fixture, work,
        overrides: new Map([['@posthog/webpack-plugin', plugin], ['@posthog/core', coreNew]]) }), /offline override install failed|needs not-cached/)
}))

test('a same-version tarball hidden by a baked nested dependency is not reported as applied', () => inDir((dir) => {
    const { fixtureDir, fixture, coreOld } = setup(dir)
    const nested = path.join(fixtureDir, 'node_modules/@posthog/webpack-plugin/node_modules/@posthog/core')
    mkdirSync(nested, { recursive: true })
    writeFileSync(path.join(nested, 'package.json'), JSON.stringify({ name: '@posthog/core', version: '1.59.1' }))
    writeFileSync(path.join(nested, 'identity.txt'), 'baked copy with the same version\n')
    const work = path.join(dir, 'work'); mkdirSync(work)
    assert.throws(() => prepareNodeModules({ fixtureDir, fixture, work,
        overrides: new Map([['@posthog/core', coreOld]]) }), /was not installed from/)
}))

test('unbound override is rejected and cannot appear in applied evidence', () => inDir((dir) => {
    const { fixtureDir, fixture } = setup(dir)
    const unrelated = pack(dir, 'unbound-package', '3.0.0')
    assert.equal(bindsPackage(fixture, 'unbound-package', new Map([['unbound-package', unrelated]])), false)
    const work = path.join(dir, 'work'); mkdirSync(work)
    assert.throws(() => prepareNodeModules({ fixtureDir, fixture, work,
        overrides: new Map([['unbound-package', unrelated]]) }), /unbound override/)
}))
