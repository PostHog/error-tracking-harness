#!/usr/bin/env node
// Run once while building a PR-specific image; never during an offline test cell.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { loadFixtures } from './plan.mjs'
import { bindsPackage, boundPackage, loadOverrides, verifyTarball } from './subject.mjs'

export function prepareSubject({ root, manifestFile, names, install = true }) {
    if (!names?.length) throw new Error('At least one fixture is required for a prepared image')
    const { packages, cli } = loadOverrides(manifestFile)
    if (cli) throw new Error('CLI executables are selected at runtime, not installed in fixtures')
    const fixtures = loadFixtures(path.join(root, 'fixtures'), names)
    if (fixtures.length !== names.length) throw new Error(`Unknown or duplicate fixture in ${names.join(', ')}`)
    const used = new Set()
    const prepared = { fixtures: {} }
    for (const fixture of fixtures) {
        const applicable = new Map([...packages].filter(([name]) => bindsPackage(fixture, name, packages)))
        if (!applicable.size) throw new Error(`${fixture.name}: no selected tarball can be installed`)
        if (fixture.layout === 'pnpm-isolated') throw new Error(`${fixture.name}: isolated layout needs an explicit binding test`)
        for (const name of applicable.keys()) used.add(name)
        const config = path.join(fixture.dir, 'pnpm-workspace.yaml')
        if (!existsSync(config)) throw new Error(`${fixture.name}: missing pnpm-workspace.yaml`)
        const yaml = readFileSync(config, 'utf8')
        if (/^overrides:\s*$/m.test(yaml)) throw new Error(`${fixture.name}: merge existing pnpm overrides before preparing`)
        writeFileSync(config, yaml + '\noverrides:\n' +
            [...applicable].map(([name, entry]) => `  ${JSON.stringify(name)}: ${JSON.stringify(`file:${entry.tarball}`)}`).join('\n') + '\n')
        const file = path.join(fixture.dir, 'package.json')
        const declared = JSON.parse(readFileSync(file, 'utf8'))
        for (const [name, entry] of applicable) {
            for (const section of ['dependencies', 'devDependencies', 'optionalDependencies']) {
                if (name in (declared[section] ?? {})) declared[section][name] = `file:${entry.tarball}`
            }
        }
        writeFileSync(file, JSON.stringify(declared, null, 2) + '\n')
        if (install) {
            // No PR-authored lifecycle script runs while the builder has registry access.
            console.log(`Preparing ${fixture.name}: ${[...applicable.keys()].join(', ')}`)
            execFileSync('pnpm', ['install', '--no-frozen-lockfile', '--ignore-scripts', '--config.strict-dep-builds=false'], {
                cwd: fixture.dir, env: { ...process.env, CI: 'true' }, stdio: 'inherit', timeout: 600_000,
            })
        }
        const nodeModules = path.join(fixture.dir, 'node_modules')
        const pluginDir = fixture.plugin ? path.join(nodeModules, fixture.plugin) : fixture.dir
        const subjectPackages = {}
        for (const [name, entry] of applicable) {
            const parent = [...applicable].find(([other, item]) => other !== name && name in (item.manifest.dependencies ?? {}))?.[0]
            const destination = boundPackage(nodeModules, name, parent ? path.join(nodeModules, parent) : pluginDir)
                ?? boundPackage(nodeModules, name, fixture.dir)
            const verified = verifyTarball(name, entry, destination, fixture)
            subjectPackages[name] = { ...verified, sha256: createHash('sha256').update(readFileSync(entry.tarball)).digest('hex') }
        }
        for (const [parent, entry] of applicable) {
            for (const name of Object.keys(entry.manifest.dependencies ?? {})) {
                if (!subjectPackages[name]) continue
                verifyTarball(name, packages.get(name), boundPackage(nodeModules, name, path.join(nodeModules, parent)), fixture)
            }
        }
        prepared.fixtures[fixture.name] = { packages: subjectPackages }
    }
    for (const name of packages.keys()) if (!used.has(name)) throw new Error(`Unused prepared tarball ${name}`)
    writeFileSync(path.join(root, 'prepared-subject.json'), JSON.stringify(prepared, null, 2) + '\n')
    return prepared
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
    const [manifestFile, selected] = process.argv.slice(2)
    if (!manifestFile || !selected) throw new Error('Usage: prepare-subject.mjs <manifest.json> <fixture,fixture>')
    prepareSubject({ root: path.resolve(import.meta.dirname, '..'), manifestFile, names: selected.split(',') })
}
