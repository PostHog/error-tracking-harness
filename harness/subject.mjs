// Local, named package overrides replace only the requested installed dependencies. All other
// packages stay pinned to the fixture's offline node_modules tree.
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { satisfies } from './semver.mjs'

// @posthog/cli is an npm shim and must be checked independently of the selected CLI binary.
const manifestAt = (file) => JSON.parse(readFileSync(file, 'utf8'))
const preparedFile = process.env.HARNESS_PREPARED_SUBJECT ?? path.join(import.meta.dirname, '..', 'prepared-subject.json')
const prepared = existsSync(preparedFile) ? manifestAt(preparedFile) : { fixtures: {} }
export const preparedFixtures = prepared.fixtures
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
        ? (preparedFixtures[fixture.name]?.packages?.[fixture.plugin]?.version ?? (manifestAt(path.join(fixture.dir, 'package.json')).devDependencies ?? {})[fixture.plugin]?.replace(/^[^\d]*/, ''))
        : installedVersion(path.join(fixture.dir, 'node_modules'), fixture.plugin))
    if (!version) throw new Error(`${fixture.name}: ${fixture.plugin} is not ${metadataOnly ? 'declared' : 'installed'}`)
    return { name: fixture.plugin, version }
}

function copyTree(source, destination) {
    try {
        execFileSync('cp', [...(process.platform === 'darwin' ? ['-RPc'] : ['-RP', '--reflink=auto']), source, destination], { stdio: 'pipe' })
    } catch {
        rmSync(destination, { recursive: true, force: true })
        cpSync(source, destination, { recursive: true, verbatimSymlinks: true })
    }
}

// A lockfile lists transitive packages even when hoisted node_modules happens to expose them at
// the root. Do not confuse a hoisted dependency with a declared direct dependency.
export function bindsPackage(fixture, name, overrides = new Map()) {
    const file = path.join(fixture.dir, 'package.json')
    if (!existsSync(file)) return false
    const pkg = manifestAt(file)
    if (name in (pkg.dependencies ?? {}) || name in (pkg.devDependencies ?? {})) return true
    const lock = path.join(fixture.dir, 'pnpm-lock.yaml')
    if (existsSync(lock) && readFileSync(lock, 'utf8').split('\n').some((line) =>
        line.startsWith('  ') && line.trim().replace(/^['"]/, '').startsWith(`${name}@`))) return true
    return [...overrides].some(([other, entry]) => other !== name &&
        (other in (pkg.dependencies ?? {}) || other in (pkg.devDependencies ?? {})) &&
        name in (entry.manifest.dependencies ?? {}))
}

export function boundPackage(nodeModules, name, from) {
    let directory = realpathSync(from)
    while (true) {
        const candidate = path.join(directory, 'node_modules', name)
        if (existsSync(path.join(candidate, 'package.json'))) return candidate
        const parent = path.dirname(directory)
        if (parent === directory) return null
        directory = parent
    }
}

// Check the actual bytes, not just the declared version: a tarball can have the same version as
// the image's pinned package. Checking every packed file also detects an unchanged baked install.
export function verifyTarball(name, entry, destination, fixture) {
    if (!destination) throw new Error(`${fixture.name}: override ${name} was not bound in node_modules`)
    const installed = manifestAt(path.join(destination, 'package.json'))
    if (installed.name !== name || installed.version !== entry.manifest.version) throw new Error(`${fixture.name}: override ${name} resolved to ${installed.name}@${installed.version} at ${destination}, expected ${entry.manifest.version}`)
    const files = execFileSync('tar', ['-tzf', entry.tarball], { encoding: 'utf8' }).trim().split('\n')
    for (const file of files) {
        if (!file.startsWith('package/') || file.endsWith('/')) continue
        const relative = file.slice('package/'.length)
        if (!relative || relative.split('/').includes('..')) throw new Error(`${name}: invalid tarball member ${file}`)
        const unpacked = path.join(destination, relative)
        const packed = execFileSync('tar', ['-xzOf', entry.tarball, file], { maxBuffer: 64 * 1024 * 1024 })
        if (!existsSync(unpacked) || !readFileSync(unpacked).equals(packed)) throw new Error(`${fixture.name}: override ${name} was not installed from ${entry.tarball} at ${destination} (${relative} differs)`)
    }
    return { version: installed.version, path: entry.tarball, installedPath: realpathSync(destination) }
}

export function prepareNodeModules({ fixtureDir, fixture, work, overrides = new Map() }) {
    const installed = path.join(fixtureDir, 'node_modules')
    const nodeModules = path.join(work, 'node_modules')
    const declared = manifestAt(path.join(fixtureDir, 'package.json'))
    const applied = [...overrides].filter(([name]) => bindsPackage({ ...fixture, dir: fixtureDir }, name, overrides))
    if (overrides.size && !applied.length) throw new Error(`${fixture.name}: unbound override ${[...overrides.keys()].join(', ')}`)
    const transitive = applied.some(([name]) => !(name in (declared.dependencies ?? {}) || name in (declared.devDependencies ?? {})))
    for (const [name] of applied) if (!transitive && !installedVersion(installed, name)) throw new Error(`${fixture.name}: override ${name} is declared but not installed`)
    if (applied.length && fixture.layout === 'pnpm-isolated') throw new Error(`${fixture.name}: unsupported override binding in pnpm-isolated layout`)
    // A prepared image may contain PR-built code. Never expose its shared installation
    // to builds through symlinks: each cell must have its own writable copy.
    const preparedPackages = preparedFixtures[fixture.name]?.packages ?? {}
    if (fixture.nodeModules === 'copy' || applied.length || Object.keys(preparedPackages).length) copyTree(installed, nodeModules)
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
    if (transitive) {
        // pnpm rewires the *whole graph* (including a plugin's nested core), using only the
        // image's store and mounted tarballs. Never write the lockfile in the baked fixture.
        const config = path.join(work, 'pnpm-workspace.yaml')
        if (!existsSync(config)) throw new Error(`${fixture.name}: transitive overrides require pnpm-workspace.yaml`)
        writeFileSync(config, readFileSync(config, 'utf8') + '\noverrides:\n' +
            applied.map(([name, entry]) => `  ${JSON.stringify(name)}: ${JSON.stringify(`file:${entry.tarball}`)}`).join('\n') + '\n')
        // A direct dependency must also name its tarball: do not rely on pnpm override
        // precedence changing between pnpm releases.
        for (const [name, entry] of applied) {
            for (const section of ['dependencies', 'devDependencies']) {
                if (name in (declared[section] ?? {})) declared[section][name] = `file:${entry.tarball}`
            }
        }
        writeFileSync(path.join(work, 'package.json'), JSON.stringify(declared, null, 2) + '\n')
        try {
            execFileSync('pnpm', ['install', '--offline', '--no-frozen-lockfile', '--ignore-scripts'], {
                cwd: work, env: { ...process.env, CI: 'true' }, encoding: 'utf8', stdio: 'pipe', timeout: 180_000,
            })
        } catch (error) {
            throw new Error(`${fixture.name}: offline override install failed (${applied.map(([name]) => name).join(', ')}): ${String(error.stderr ?? error.message).trim().slice(-1500)}`)
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
            const range = declared.startsWith('npm:') ? declared.slice(declared.lastIndexOf('@') + 1) : declared
            const version = overrides.get(dependency)?.manifest.version ?? installedVersion(nodeModules, dependency)
            if (!version || !satisfies(version, range)) throw new Error(`${name} needs ${dependency}@${range}, but ${fixture.name} has ${version ?? 'nothing'}`)
        }
        if (!transitive) {
            const destination = path.join(nodeModules, name)
            rmSync(destination, { recursive: true, force: true })
            mkdirSync(destination, { recursive: true })
            execFileSync('tar', ['-xzf', tarball, '--strip-components=1', '-C', destination])
        }
    }
    const pluginDir = fixture.plugin ? path.join(nodeModules, fixture.plugin) : work
    const packages = Object.fromEntries(applied.map(([name, entry]) => {
        const dependent = applied.find(([parent, item]) => parent !== name && name in (item.manifest.dependencies ?? {}))?.[0]
        const destination = boundPackage(nodeModules, name, dependent ? path.join(nodeModules, dependent) : pluginDir)
            ?? boundPackage(nodeModules, name, work)
        return [name, verifyTarball(name, entry, destination, fixture)]
    }))
    for (const [parent, entry] of applied) {
        for (const name of Object.keys(entry.manifest.dependencies ?? {})) {
            if (!packages[name]) continue
            verifyTarball(name, overrides.get(name), boundPackage(nodeModules, name, path.join(nodeModules, parent)), fixture)
        }
    }
    for (const [name, entry] of Object.entries(preparedPackages)) {
        const destination = boundPackage(nodeModules, name, fixture.plugin ? path.join(nodeModules, fixture.plugin) : work)
        if (!destination || manifestAt(path.join(destination, 'package.json')).version !== entry.version) {
            throw new Error(`${fixture.name}: prepared ${name}@${entry.version} is not installed in this cell`)
        }
        packages[name] = { ...entry, installedPath: realpathSync(destination) }
    }
    const framework = ['next', 'nuxt', 'vite', 'webpack', 'rollup'].find((name) => installedVersion(nodeModules, name))
    const frameworkInfo = framework && { name: framework, version: installedVersion(nodeModules, framework), path: packages[framework]?.path ?? null, installedPath: realpathSync(path.join(nodeModules, framework)) }
    if (!fixture.plugin) return { name: 'posthog-cli', version: 'cli', source: 'pinned', packages, framework: frameworkInfo }
    const plugin = manifestAt(path.join(nodeModules, fixture.plugin, 'package.json'))
    return { name: plugin.name, version: plugin.version, source: packages[fixture.plugin]?.path ?? 'pinned', installedPath: realpathSync(path.join(nodeModules, fixture.plugin)), packages, framework: frameworkInfo }
}
