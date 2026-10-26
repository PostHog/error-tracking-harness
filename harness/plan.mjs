// Enumerates the matrix: cli × fixture × case, minus the cases a CLI is too old for.
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { compare } from './semver.mjs'
import { validateCase, validateFixture } from './validate.mjs'

export const compareVersions = compare

export function cliAtLeast(cli, floor) {
    // A custom binary has no version to compare; it is never skipped.
    return !floor || cli.version === 'custom' || (cli.version !== 'unknown' && compareVersions(cli.version, floor) >= 0)
}

export function loadFixtures(root, filter, tags) {
    const names = readdirSync(root).sort()
    if (filter) for (const name of filter) {
        if (!names.includes(name) || !existsSync(path.join(root, name, 'fixture.json'))) throw new Error(`Unknown fixture ${name}`)
    }
    if (tags) {
        const known = new Set()
        for (const name of names) {
            const file = path.join(root, name, 'fixture.json')
            if (!existsSync(file)) continue
            const config = JSON.parse(readFileSync(file, 'utf8'))
            const defaults = config.extends ? JSON.parse(readFileSync(path.join(root, '_defaults', `${config.extends}.json`), 'utf8')) : {}
            for (const tag of config.tags ?? defaults.tags ?? []) known.add(tag)
        }
        for (const tag of tags) if (!known.has(tag)) throw new Error(`Unknown fixture tag ${tag}`)
    }
    const fixtures = []
    for (const name of names) {
        const file = path.join(root, name, 'fixture.json')
        if (!existsSync(file)) continue
        if (filter && !filter.includes(name)) continue
        const config = JSON.parse(readFileSync(file, 'utf8'))
        const defaults = config.extends ? JSON.parse(readFileSync(path.join(root, '_defaults', `${config.extends}.json`), 'utf8')) : {}
        const { extends: _extends, ...fields } = config
        const fixture = { ...defaults, ...fields }
        validateFixture(fixture, name)
        if (!tags || tags.some((tag) => fixture.tags.includes(tag))) fixtures.push({ ...fixture, name, dir: path.join(root, name) })
    }
    if (!fixtures.length) throw new Error(`No fixture matches names ${filter?.join(',') ?? '*'} and tags ${tags?.join(',') ?? '*'}`)
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
                const config = JSON.parse(readFileSync(file, 'utf8'))
                validateCase(config, name)
                cases.push({ name, ...config })
            }
        }
    }
    visit(root)
    if (!cases.length) throw new Error(`No case matches ${patterns}`)
    return cases
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
                let skipped
                if (!cliAtLeast(cli, kase.minCli)) skipped = `needs posthog-cli >= ${kase.minCli}`
                else if (fixture.minCli && !cliAtLeast(cli, fixture.minCli)) skipped = `fixture needs posthog-cli >= ${fixture.minCli}`
                entries.push({ cli, fixture, kase, plugin, skipped })
            }
        }
    }
    return entries
}
