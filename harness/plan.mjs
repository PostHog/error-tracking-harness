// Enumerates the matrix: cli × fixture × case, minus the cases a CLI is too old for.
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import path from 'node:path'

export function compareVersions(a, b) {
    const left = a.split('.').map(Number)
    const right = b.split('.').map(Number)
    for (let index = 0; index < 3; index++) {
        if ((left[index] ?? 0) !== (right[index] ?? 0)) return (left[index] ?? 0) - (right[index] ?? 0)
    }
    return 0
}

export function cliAtLeast(cli, floor) {
    // A custom binary has no version to compare; it is never skipped.
    return !floor || cli.version === 'custom' || compareVersions(cli.version, floor) >= 0
}

export function loadFixtures(root, filter) {
    const fixtures = []
    for (const name of readdirSync(root).sort()) {
        const file = path.join(root, name, 'fixture.json')
        if (!existsSync(file)) continue
        if (filter && !filter.includes(name)) continue
        fixtures.push({ name, dir: path.join(root, name), ...JSON.parse(readFileSync(file, 'utf8')) })
    }
    if (filter) {
        for (const name of filter) if (!fixtures.some((fixture) => fixture.name === name)) throw new Error(`Unknown fixture ${name}`)
    }
    return fixtures
}

export function loadCases(root, pattern) {
    const cases = []
    const visit = (dir) => {
        for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
            const file = path.join(dir, entry.name)
            if (entry.isDirectory()) visit(file)
            else if (entry.name.endsWith('.json')) {
                const name = path.relative(root, file).slice(0, -'.json'.length).split(path.sep).join('/')
                if (pattern && !path.matchesGlob(name, pattern)) continue
                cases.push({ name, ...JSON.parse(readFileSync(file, 'utf8')) })
            }
        }
    }
    visit(root)
    return cases
}

export function pluginAtLeast(plugin, floors) {
    const floor = floors?.[plugin.name]
    return !floor || compareVersions(plugin.version, floor) >= 0
}

/** `plugins` maps a fixture name to the plugin that selection puts in place. */
export function planMatrix({ clis, fixtures, cases, plugins }) {
    const entries = []
    for (const cli of clis) {
        for (const fixture of fixtures) {
            const plugin = plugins.get(fixture.name)
            for (const kase of cases) {
                let skipped
                if (!cliAtLeast(cli, kase.minCli)) skipped = `needs posthog-cli >= ${kase.minCli}`
                else if (!pluginAtLeast(plugin, kase.minPlugin)) skipped = `needs ${plugin.name} >= ${kase.minPlugin[plugin.name]}`
                entries.push({ cli, fixture, kase, plugin, skipped })
            }
        }
    }
    return entries
}
