// Local, named package overrides replace only the requested installed dependencies. All other
// packages stay pinned to the fixture's offline node_modules tree.
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync } from 'node:fs'
import path from 'node:path'
import { satisfies } from './semver.mjs'

const UNCHECKED = new Set(['@posthog/cli'])
const manifestAt = (file) => JSON.parse(readFileSync(file, 'utf8'))
export function installedVersion(nodeModules, name) {
    const file = path.join(nodeModules, name, 'package.json')
    return existsSync(file) ? manifestAt(file).version : undefined
}

/** Manifest: { "packages": { "npm-name": "./local.tgz" }, "binaries": { "posthog-cli": "./posthog-cli" } }. */
export function loadOverrides(file) {
    if (!file) return { packages: new Map(), cli: null }
    const config = manifestAt(file)
    if (!config || Array.isArray(config) || typeof config !== 'object' || Object.keys(config).some((key) => !['packages', 'binaries', 'cli'].includes(key))) throw new Error(`Invalid overrides manifest ${file}`)
    if (config.packages && (typeof config.packages !== 'object' || Array.isArray(config.packages))) throw new Error(`Invalid packages in ${file}`)
    if (config.binaries && (typeof config.binaries !== 'object' || Array.isArray(config.binaries) || Object.keys(config.binaries).some((name) => name !== 'posthog-cli'))) throw new Error(`Invalid binaries in ${file}`)
    if (config.cli && config.binaries?.['posthog-cli']) throw new Error('Conflicting CLI overrides')
    const packages = new Map()
    for (const [name, location] of Object.entries(config.packages ?? {})) {
        if (typeof location !== 'string') throw new Error(`${name}: override must be a tarball path`)
        const tarball = path.resolve(path.dirname(file), location)
        if (!existsSync(tarball) || !statSync(tarball).isFile()) throw new Error(`${name}: missing override tarball ${tarball}`)
        const manifest = JSON.parse(execFileSync('tar', ['-xzOf', tarball, 'package/package.json'], { encoding: 'utf8' }))
        if (manifest.name !== name || !manifest.version) throw new Error(`${tarball}: expected package ${name}, found ${manifest.name}`)
        packages.set(name, { tarball, manifest })
    }
    let cli = null
    const cliLocation = config.binaries?.['posthog-cli'] ?? config.cli
    if (cliLocation) {
        if (typeof cliLocation !== 'string') throw new Error('CLI override must be a local executable path')
        const binary = path.resolve(path.dirname(file), cliLocation)
        if (!existsSync(binary) || !statSync(binary).isFile() || !(statSync(binary).mode & 0o111)) throw new Error(`CLI override is missing or not executable: ${binary}`)
        const reported = execFileSync(binary, ['--version'], { encoding: 'utf8' }).trim()
        if (!/posthog-cli\s+v?\d+\.\d+\.\d+/i.test(reported)) throw new Error(`CLI override ${binary} reported invalid version: ${reported}`)
        cli = { label: 'override', version: 'custom', reported, path: binary }
    }
    if (!packages.size && !cli) throw new Error(`No overrides in ${file}`)
    return { packages, cli }
}

export function selectedPlugin(fixture, overrides = new Map(), { metadataOnly = false } = {}) {
    if (!fixture.plugin) return fixture.mode === 'cli'
        ? { name: 'posthog-cli', version: 'cli' }
        : { name: 'command', version: 'none' }
    const override = overrides.get(fixture.plugin)
    const version = override?.manifest.version ?? (metadataOnly
        ? (manifestAt(path.join(fixture.dir, 'package.json')).devDependencies ?? {})[fixture.plugin]?.replace(/^[^\d]*/, '')
        : installedVersion(path.join(fixture.dir, 'node_modules'), fixture.plugin))
    if (!version) throw new Error(`${fixture.name}: ${fixture.plugin} is not ${metadataOnly ? 'declared' : 'installed'}`)
    return { name: fixture.plugin, version }
}

function copyTree(source, destination) {
    try {
        execFileSync('cp', [process.platform === 'darwin' ? '-RPc' : '-RPl', source, destination], { stdio: 'pipe' })
    } catch {
        rmSync(destination, { recursive: true, force: true })
        cpSync(source, destination, { recursive: true, verbatimSymlinks: true })
    }
}

export function prepareNodeModules({ fixtureDir, fixture, work, overrides = new Map() }) {
    const installed = path.join(fixtureDir, 'node_modules')
    const nodeModules = path.join(work, 'node_modules')
    const declared = manifestAt(path.join(fixtureDir, 'package.json'))
    const required = [...overrides].filter(([name]) => name in (declared.dependencies ?? {}) || name in (declared.devDependencies ?? {}))
    for (const [name] of required) if (!installedVersion(installed, name)) throw new Error(`${fixture.name}: override ${name} is declared but not installed`)
    const applied = required
    if (applied.length && fixture.layout === 'pnpm-isolated') throw new Error(`${fixture.name}: unsupported override binding in pnpm-isolated layout`)
    if (fixture.nodeModules === 'copy') copyTree(installed, nodeModules)
    else {
        mkdirSync(nodeModules)
        for (const entry of readdirSync(installed, { withFileTypes: true })) {
            const source = path.join(installed, entry.name)
            if (entry.name.startsWith('@') && entry.isDirectory()) {
                mkdirSync(path.join(nodeModules, entry.name))
                for (const child of readdirSync(source)) symlinkSync(path.join(source, child), path.join(nodeModules, entry.name, child), 'dir')
            } else symlinkSync(source, path.join(nodeModules, entry.name), 'dir')
        }
    }
    if (fixture.plugin && !overrides.has(fixture.plugin)) {
        const plugin = manifestAt(path.join(installed, fixture.plugin, 'package.json'))
        for (const [name, { manifest }] of applied) {
            const range = plugin.dependencies?.[name] ?? plugin.peerDependencies?.[name]
            if (range && !satisfies(manifest.version, range)) throw new Error(`${fixture.plugin} needs ${name}@${range}, but ${fixture.name} overrides it with ${manifest.version}`)
        }
    }
    for (const [name, { tarball, manifest }] of applied) {
        for (const [dependency, declared] of Object.entries(manifest.dependencies ?? {})) {
            if (UNCHECKED.has(dependency)) continue
            const range = declared.startsWith('npm:') ? declared.slice(declared.lastIndexOf('@') + 1) : declared
            const version = overrides.get(dependency)?.manifest.version ?? installedVersion(installed, dependency)
            if (!version || !satisfies(version, range)) throw new Error(`${name} needs ${dependency}@${range}, but ${fixture.name} has ${version ?? 'nothing'}`)
        }
        const destination = path.join(nodeModules, name)
        rmSync(destination, { recursive: true, force: true })
        mkdirSync(destination, { recursive: true })
        execFileSync('tar', ['-xzf', tarball, '--strip-components=1', '-C', destination])
    }
    const packages = Object.fromEntries(applied.map(([name, entry]) => [name, { version: entry.manifest.version, path: entry.tarball }]))
    const framework = ['next', 'nuxt', 'vite', 'webpack', 'rollup'].find((name) => installedVersion(nodeModules, name))
    const frameworkInfo = framework && { name: framework, version: installedVersion(nodeModules, framework), path: packages[framework]?.path ?? null }
    if (!fixture.plugin) return { name: 'posthog-cli', version: 'cli', source: 'pinned', packages, framework: frameworkInfo }
    const plugin = manifestAt(path.join(nodeModules, fixture.plugin, 'package.json'))
    return { name: plugin.name, version: plugin.version, source: packages[fixture.plugin]?.path ?? 'pinned', packages, framework: frameworkInfo }
}
