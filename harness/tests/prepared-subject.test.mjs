import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { prepareSubject } from '../prepare-subject.mjs'

function pack(dir, name, version, dependencies = {}) {
    const folder = path.join(dir, 'package')
    mkdirSync(folder, { recursive: true })
    writeFileSync(path.join(folder, 'package.json'), JSON.stringify({ name, version, dependencies }))
    writeFileSync(path.join(folder, 'identity.txt'), `${name}@${version}\n`)
    const tarball = path.join(dir, `${name.replaceAll('/', '-')}-${version}.tgz`)
    execFileSync('tar', ['-czf', tarball, '-C', dir, 'package'])
    rmSync(folder, { recursive: true })
    return tarball
}

function setup(root) {
    const dir = path.join(root, 'fixtures', 'rollup-4')
    mkdirSync(dir, { recursive: true })
    cpSync(path.resolve(import.meta.dirname, '../../fixtures/rollup-4/fixture.json'), path.join(dir, 'fixture.json'))
    const oldCore = pack(root, '@posthog/core', '1.59.1')
    const oldPlugin = pack(root, '@posthog/rollup-plugin', '1.6.1', { '@posthog/core': '^1.59.1' })
    const newCore = pack(root, '@posthog/core', '1.60.1')
    const newPlugin = pack(root, '@posthog/rollup-plugin', '1.6.2', { '@posthog/core': '^1.60.1' })
    writeFileSync(path.join(dir, 'pnpm-workspace.yaml'), `nodeLinker: hoisted\nstoreDir: ${JSON.stringify(path.join(root, 'store'))}\n`)
    writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'harness-rollup-4', private: true,
        packageManager: 'pnpm@11.7.0', devDependencies: { '@posthog/rollup-plugin': `file:${oldPlugin}`, '@posthog/core': `file:${oldCore}` } }))
    execFileSync('pnpm', ['install', '--ignore-scripts', '--config.strict-dep-builds=false'], { cwd: dir, stdio: 'pipe' })
    const manifest = path.join(root, 'overrides.json')
    writeFileSync(manifest, JSON.stringify({ packages: { '@posthog/rollup-plugin': newPlugin, '@posthog/core': newCore } }))
    return { dir, manifest, newCore }
}

function inDir(fn) {
    const root = mkdtempSync(path.join(tmpdir(), 'harness-prepared-test-'))
    try { return fn(root) } finally { rmSync(root, { recursive: true, force: true }) }
}

test('image preparation installs tarballs once and cells copy the verified packages', () => inDir((root) => {
    const { dir, manifest } = setup(root)
    const result = prepareSubject({ root, manifestFile: manifest, names: ['rollup-4'] })
    assert.equal(result.fixtures['rollup-4'].packages['@posthog/core'].version, '1.60.1')
    assert.match(result.fixtures['rollup-4'].packages['@posthog/core'].sha256, /^[0-9a-f]{64}$/)
    const runner = new URL('../subject.mjs', import.meta.url).pathname
    // A later cell must neither install packages nor mutate the prepared fixture.
    const script = `import { prepareNodeModules } from ${JSON.stringify(runner)}; import { mkdirSync, writeFileSync, existsSync } from 'node:fs'; import path from 'node:path';
        const dir=${JSON.stringify(dir)}, work=path.join(${JSON.stringify(root)}, 'cell'); mkdirSync(work);
        const fixture={name:'rollup-4',plugin:'@posthog/rollup-plugin',dir};
        const result=prepareNodeModules({fixtureDir:dir,fixture,work});
        if(result.packages['@posthog/core'].version!=='1.60.1') throw Error('missing provenance');
        writeFileSync(path.join(work,'node_modules/@posthog/core/cell-marker'),'mutated');
        if(existsSync(path.join(dir,'node_modules/@posthog/core/cell-marker'))) throw Error('shared node_modules');`
    execFileSync(process.execPath, ['--input-type=module', '-e', script], {
        env: { ...process.env, HARNESS_PREPARED_SUBJECT: path.join(root, 'prepared-subject.json') }, stdio: 'pipe',
    })
    assert.equal(existsSync(path.join(dir, 'node_modules/@posthog/core/cell-marker')), false)
}))

test('preparation rejects a tarball unused by all selected fixtures', () => inDir((root) => {
    const { manifest } = setup(root)
    const config = JSON.parse(readFileSync(manifest, 'utf8'))
    config.packages.unused = pack(root, 'unused', '1.0.0')
    writeFileSync(manifest, JSON.stringify(config))
    assert.throws(() => prepareSubject({ root, manifestFile: manifest, names: ['rollup-4'] }), /Unused prepared tarball unused/)
}))

test('preparation rejects a manifest whose tarball has a different package identity', () => inDir((root) => {
    const { manifest, newCore } = setup(root)
    const config = JSON.parse(readFileSync(manifest, 'utf8'))
    config.packages.unused = newCore
    writeFileSync(manifest, JSON.stringify(config))
    assert.throws(() => prepareSubject({ root, manifestFile: manifest, names: ['rollup-4'] }), /expected package unused/)
}))
