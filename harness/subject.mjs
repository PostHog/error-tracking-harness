// Which plugin a case runs against: the fixture's latest pin, its floor alias, or tarballs mounted
// at /subject. Each case works in a copy of the fixture whose node_modules holds symlinks into
// the installed tree, so swapping a package means replacing one top-level entry. Fixtures use
// pnpm's hoisted linker, which keeps every package at the top level where that swap works.
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import path from 'node:path'
import { satisfies } from './semver.mjs'

// Every case passes `cliBinaryPath`, so the npm package the plugins declare is never used and
// its range need not hold. The binaries baked into the image are the CLI dimension.
const UNCHECKED = new Set(['@posthog/cli'])

/** Reads the tarballs in `dir`: name → { tarball, manifest }. */
export function loadSubject(dir) {
    const subject = new Map()
    if (!dir || !existsSync(dir)) return subject
    for (const file of readdirSync(dir)) {
        if (!file.endsWith('.tgz')) continue
        const tarball = path.join(dir, file)
        const manifest = JSON.parse(execFileSync('tar', ['-xzOf', tarball, 'package/package.json'], { encoding: 'utf8' }))
        subject.set(manifest.name, { tarball, manifest })
    }
    return subject
}

function installedVersion(nodeModules, name) {
    const manifest = path.join(nodeModules, name, 'package.json')
    return existsSync(manifest) ? JSON.parse(readFileSync(manifest, 'utf8')).version : undefined
}

/** The plugin version a selection would put in place, known before anything is built. */
export function selectedPlugin(fixture, selection, subject) {
    // A cli-mode fixture has no plugin; the CLI under test is the matrix's own dimension.
    if (!fixture.plugin) return { name: 'posthog-cli', version: 'cli' }
    const installed = path.join(fixture.dir, 'node_modules')
    if (selection === 'subject') {
        const entry = subject.get(fixture.plugin)
        if (!entry) throw new Error(`subject has no tarball for ${fixture.plugin}`)
        return { name: fixture.plugin, version: entry.manifest.version }
    }
    const version = installedVersion(installed, selection === 'floor' ? fixture.floorAlias : fixture.plugin)
    if (!version) throw new Error(`${fixture.name}: ${fixture.plugin} is not installed; run pnpm install in fixtures/${fixture.name}`)
    return { name: fixture.plugin, version }
}

function copyTree(source, destination) {
    const attempts = process.platform === 'darwin' ? [['cp', ['-Rc', source, destination]]] : [['cp', ['-Rl', source, destination]]]
    for (const [command, args] of attempts) {
        try {
            execFileSync(command, args, { stdio: 'pipe' })
            return
        } catch {
            rmSync(destination, { recursive: true, force: true })
        }
    }
    cpSync(source, destination, { recursive: true, verbatimSymlinks: true })
}

function link(target, destination) {
    symlinkSync(target, destination, 'dir')
}

/**
 * Builds `<work>/node_modules` for one case and returns the plugin actually in use.
 * `selection` is 'latest' | 'floor' | 'subject'.
 */
export function prepareNodeModules({ fixtureDir, fixture, work, selection, subject }) {
    const installed = path.join(fixtureDir, 'node_modules')
    const nodeModules = path.join(work, 'node_modules')
    if (fixture.nodeModules === 'copy') {
        // Turbopack refuses packages whose real path lies outside the workspace, so symlinks
        // into the installed tree will not do. A clone (APFS) or hardlink copy costs nothing.
        copyTree(installed, nodeModules)
    } else {
        mkdirSync(nodeModules)
        for (const entry of readdirSync(installed, { withFileTypes: true })) {
            const source = path.join(installed, entry.name)
            if (entry.name.startsWith('@') && entry.isDirectory()) {
                mkdirSync(path.join(nodeModules, entry.name))
                for (const child of readdirSync(source)) {
                    link(path.join(source, child), path.join(nodeModules, entry.name, child))
                }
            } else {
                link(source, path.join(nodeModules, entry.name))
            }
        }
    }

    const pluginPath = fixture.plugin ? path.join(nodeModules, fixture.plugin) : null
    let source = 'latest'
    if (selection === 'floor' && pluginPath) {
        rmSync(pluginPath, { recursive: true, force: true })
        // Inside the copied tree when there is one, so Turbopack still sees it under the root.
        link(path.join(fixture.nodeModules === 'copy' ? nodeModules : installed, fixture.floorAlias), pluginPath)
        source = 'floor'
    } else if (selection === 'subject') {
        const overlaid = []
        for (const [name, { tarball, manifest }] of subject) {
            if (!installedVersion(installed, name)) continue // not part of this fixture
            for (const [dependency, declared] of Object.entries(manifest.dependencies ?? {})) {
                if (UNCHECKED.has(dependency) || subject.has(dependency)) continue
                // An alias (`name: npm:other@range`) is installed under `name` at `other`'s version.
                const range = declared.startsWith('npm:') ? declared.slice(declared.lastIndexOf('@') + 1) : declared
                const version = installedVersion(installed, dependency)
                if (!version || !satisfies(version, range)) {
                    throw new Error(
                        `${name} needs ${dependency}@${range}, but ${fixture.name} has ${version ?? 'nothing'}: pin it in fixtures/${fixture.name}/package.json`
                    )
                }
            }
            const destination = path.join(nodeModules, name)
            rmSync(destination, { recursive: true, force: true })
            mkdirSync(destination, { recursive: true })
            execFileSync('tar', ['-xzf', tarball, '--strip-components=1', '-C', destination])
            overlaid.push(`${name}@${manifest.version}`)
        }
        if (fixture.plugin && !overlaid.some((item) => item.startsWith(`${fixture.plugin}@`))) {
            throw new Error(`subject has no tarball for ${fixture.plugin}`)
        }
        source = `subject (${overlaid.join(', ')})`
    }

    if (!pluginPath) return { name: 'posthog-cli', version: 'cli', source }
    const manifest = JSON.parse(readFileSync(path.join(pluginPath, 'package.json'), 'utf8'))
    return { name: manifest.name, version: manifest.version, source }
}
