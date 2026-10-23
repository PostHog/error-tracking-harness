// Enumerates the matrix: cli × fixture × case, minus the cases a CLI is too old for.
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import path from 'node:path'

/** The @posthog/cli package a fixture installed, which the plugins resolve when no path is given. */
export function fixtureCli(fixture) {
    for (const candidate of ['node_modules/@posthog/cli/package.json', 'node_modules/.pnpm/node_modules/@posthog/cli/package.json']) {
        const file = path.join(fixture.dir, candidate)
        if (existsSync(file)) return { label: 'fixture', version: JSON.parse(readFileSync(file, 'utf8')).version, path: null }
    }
    const nested = readdirSync(path.join(fixture.dir, 'node_modules/.pnpm'), { withFileTypes: true }).find((entry) => entry.name.startsWith('@posthog+cli@'))
    if (nested) return { label: 'fixture', version: nested.name.split('@').pop(), path: null }
    return { label: 'fixture', version: 'unknown', path: null }
}

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

/** Fixtures a tarball overlay cannot reach (pnpm-isolated layouts) are skipped under --plugins subject. */
export function overlayable(fixture) {
    return fixture.subject !== false
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

/** `patterns` is a comma-separated list of globs over case names, e.g. `baseline/*,upload/start-500`. */
export function loadCases(root, patterns) {
    const globs = patterns?.split(',').map((item) => item.trim()).filter(Boolean)
    const cases = []
    const visit = (dir) => {
        for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
            const file = path.join(dir, entry.name)
            if (entry.isDirectory()) visit(file)
            else if (entry.name.endsWith('.json')) {
                const name = path.relative(root, file).slice(0, -'.json'.length).split(path.sep).join('/')
                if (globs && !globs.some((glob) => path.matchesGlob(name, glob))) continue
                cases.push({ name, ...JSON.parse(readFileSync(file, 'utf8')) })
            }
        }
    }
    visit(root)
    if (!cases.length) throw new Error(`No case matches ${patterns}`)
    return cases
}

export function pluginAtLeast(plugin, floors) {
    const floor = floors?.[plugin.name]
    return !floor || plugin.version === 'cli' || compareVersions(plugin.version, floor) >= 0
}

/** `plugins` maps a fixture name to the plugin that selection puts in place. */
// Slow fixtures (framework builds) run against the oldest and newest CLI only.
function clisFor(fixture, clis) {
    if (fixture.cliSelection !== 'edges' || clis.length <= 2) return clis
    // Among the CLIs the fixture accepts, the oldest and the newest.
    const versioned = clis
        .filter((cli) => cli.version !== 'custom' && cliAtLeast(cli, fixture.minCli))
        .sort((a, b) => compareVersions(a.version, b.version))
    const custom = clis.filter((cli) => cli.version === 'custom')
    return [...new Set([versioned[0], versioned.at(-1), ...custom].filter(Boolean))]
}

export function planMatrix({ clis, fixtures, cases, plugins }) {
    const entries = []
    for (const cli of clis) {
        for (const fixture of fixtures) {
            if (!clisFor(fixture, clis).includes(cli)) continue
            const plugin = plugins.get(fixture.name)
            for (const kase of cases) {
                // A case is written for one kind of fixture: `plugin` (the bundler plugin injects and
                // uploads) or `cli` (the harness runs posthog-cli on the built files).
                if ((kase.mode ?? 'plugin') !== (fixture.mode ?? 'plugin')) continue
                // A case with `cliBinary: fixture` leaves cliBinaryPath unset, so the plugin resolves
                // the CLI the fixture installed. The matrix's CLI dimension does not apply: one cell.
                if (kase.cliBinary === 'fixture') {
                    if (cli !== clis[0]) continue
                    const own = fixtureCli(fixture)
                    const skipped = cliAtLeast(own, kase.minCli) ? undefined : `fixture ships posthog-cli ${own.version}, needs >= ${kase.minCli}`
                    entries.push({ cli: own, fixture, kase, plugin, skipped })
                    continue
                }
                let skipped
                if (!cliAtLeast(cli, kase.minCli)) skipped = `needs posthog-cli >= ${kase.minCli}`
                else if (fixture.minCli && !cliAtLeast(cli, fixture.minCli)) skipped = `fixture needs posthog-cli >= ${fixture.minCli}`
                else if (!pluginAtLeast(plugin, kase.minPlugin)) skipped = `needs ${plugin.name} >= ${kase.minPlugin[plugin.name]}`
                // A fixture can need a plugin version for every case (a published plugin mishandles it).
                else if (fixture.minPlugin && !pluginAtLeast(plugin, { [plugin.name]: fixture.minPlugin })) skipped = `fixture needs ${plugin.name} >= ${fixture.minPlugin}`
                entries.push({ cli, fixture, kase, plugin, skipped })
            }
        }
    }
    return entries
}
