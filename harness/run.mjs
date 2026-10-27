#!/usr/bin/env node
// Offline conformance matrix: node harness/run.mjs [--cli versions | --cli-binary path]
//   [--fixtures names] [--tags any,tag] [--cases glob] [--overrides manifest.json]
//   [--artifacts dir] [--list] [--judge-only run-dir]
import { parseArgs } from 'node:util'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { loadCases, loadFixtures, planMatrix } from './plan.mjs'
import { bindsPackage, loadOverrides, pluginCliRange, preparedFixtures, selectedPlugin } from './subject.mjs'
import { coverage } from './coverage.mjs'
import { executeCase, discardWork } from './execute.mjs'
import { judge } from './judge.mjs'
import { renderReport } from './report.mjs'

const root = path.resolve(import.meta.dirname, '..')
const { values: args } = parseArgs({ options: {
    cli: { type: 'string' }, 'cli-binary': { type: 'string' }, fixtures: { type: 'string' },
    tags: { type: 'string' }, cases: { type: 'string' }, overrides: { type: 'string' },
    artifacts: { type: 'string' }, list: { type: 'boolean', default: false },
    'judge-only': { type: 'string' }, 'keep-work': { type: 'boolean', default: false },
} })
const list = (value) => value?.split(',').map((item) => item.trim()).filter(Boolean)

function saveSummary(artifacts, results, { fixtures = [], overrides = {}, uncovered = [], seconds = 0 } = {}) {
    const executed = results.filter((result) => !result.skipped).length
    const passed = results.filter((result) => !result.skipped && result.ok).length
    const summary = {
        seconds, fixtures, overrides, executed, total: executed, passed,
        failed: executed - passed, skipped: results.filter((result) => result.skipped).length,
        uncovered: uncovered.length, uncoveredPairs: uncovered, results,
    }
    writeFileSync(path.join(artifacts, 'summary.json'), JSON.stringify(summary, null, 2))
    writeFileSync(path.join(artifacts, 'report.md'), renderReport(summary))
    console.log(`\n${passed}/${executed} passed (${summary.skipped} skipped, ${summary.uncovered} uncovered); report: ${path.join(artifacts, 'report.md')}`)
    return executed > 0 && summary.failed === 0 && summary.uncovered === 0
}

if (args['judge-only']) {
    const runDir = args['judge-only']
    const cases = new Map(loadCases(path.join(root, 'harness/cases')).map((kase) => [kase.name, kase]))
    const results = []
    for (const file of readdirSync(runDir, { recursive: true }).map(String).filter((file) => path.basename(file) === 'evidence.json')) {
        const evidence = JSON.parse(readFileSync(path.join(runDir, file), 'utf8'))
        const kase = cases.get(evidence.case)
        if (!kase) throw new Error(`No current case for saved evidence ${evidence.case}`)
        const verdict = judge(evidence, kase)
        writeFileSync(path.join(runDir, path.dirname(file), 'verdict.json'), JSON.stringify(verdict, null, 2))
        console.log(`${verdict.ok ? 'PASS' : 'FAIL'} ${evidence.cli.label}/${evidence.fixture.name}/${evidence.case}${verdict.ok ? '' : ': ' + verdict.failures[0]}`)
        results.push({ cli: evidence.cli.label, cliPath: evidence.cli.path, fixture: evidence.fixture.name, case: evidence.case,
            plugin: `${evidence.plugin.name}@${evidence.plugin.version}`, packages: evidence.plugin.packages, framework: evidence.plugin.framework,
            ...verdict, reuploads: evidence.releases[1]?.uploadedChunkIds.length })
    }
    if (!results.length) throw new Error(`No evidence.json found in ${runDir}`)
    process.exit(saveSummary(runDir, results, { fixtures: [...new Set(results.map((result) => result.fixture))] }) ? 0 : 1)
}

if (args.overrides && Object.keys(preparedFixtures).length) throw new Error('Prepared images do not accept runtime package overrides')
const overrides = loadOverrides(args.overrides)
if (overrides.cli && (args.cli || args['cli-binary'])) throw new Error('CLI override conflicts with --cli or --cli-binary')
if (args.cli && args['cli-binary']) throw new Error('--cli conflicts with --cli-binary')
const cliDir = process.env.HARNESS_CLI_DIR ?? (existsSync('/opt/posthog-cli') ? '/opt/posthog-cli' : path.join(homedir(), '.cache/error-tracking-harness/cli'))
function ensureCli(version) {
    const binary = path.join(cliDir, version, 'posthog-cli')
    if (!existsSync(binary)) throw new Error(`Missing local posthog-cli ${version} at ${binary}; use a baked image or a CLI override`)
    const reported = execFileSync(binary, ['--version'], { encoding: 'utf8' }).trim()
    if (!reported.includes(version)) throw new Error(`${binary} reports "${reported}", expected ${version}`)
    return { label: version, version, reported, path: binary }
}
const cliEntry = (version) => args.list ? { label: version, version, path: null } : ensureCli(version)
const clis = overrides.cli ? [overrides.cli] : (list(args.cli)?.map(cliEntry) ?? [])
if (args['cli-binary']) {
    const binary = path.resolve(args['cli-binary'])
    const reported = execFileSync(binary, ['--version'], { encoding: 'utf8' }).trim()
    clis.push({ label: 'custom', version: 'custom', reported, path: binary })
}
if (!clis.length) {
    const baked = existsSync(cliDir) ? readdirSync(cliDir).filter((name) => existsSync(path.join(cliDir, name, 'posthog-cli'))) : []
    const versions = baked.length ? baked : readFileSync(path.join(root, 'cli-versions.txt'), 'utf8').split(/\s+/).filter(Boolean)
    clis.push(...versions.map(cliEntry))
}
const dependsOn = (fixture, name) => bindsPackage(fixture, name, overrides.packages)
let fixtures = loadFixtures(path.join(root, 'fixtures'), list(args.fixtures), list(args.tags))
if (overrides.packages.size && !args.fixtures && !args.tags) {
    fixtures = fixtures.filter((fixture) => [...overrides.packages.keys()].some((name) => dependsOn(fixture, name)))
}
if (!fixtures.length) throw new Error('No fixtures selected for overrides')
const cases = loadCases(path.join(root, 'harness/cases'), args.cases)
for (const [name] of overrides.packages) {
    if (!fixtures.some((fixture) => dependsOn(fixture, name))) throw new Error(`Unused override ${name}: selected fixtures ${fixtures.map((fixture) => fixture.name).join(', ')}`)
}
for (const fixture of fixtures) {
    if (!args.list && fixture.lifecycle.workspace.adapter === 'node-modules' && !existsSync(path.join(fixture.dir, 'node_modules'))) throw new Error(`${fixture.name}: dependencies are missing; run pnpm install:fixtures`)
    if (fixture.layout === 'pnpm-isolated' && [...overrides.packages.keys()].some((name) => dependsOn(fixture, name))) throw new Error(`${fixture.name}: unsupported override binding in pnpm-isolated layout`)
}
const plugins = new Map(fixtures.map((fixture) => [fixture.name, selectedPlugin(fixture, overrides.packages, { metadataOnly: args.list })]))
const cliRanges = new Map(fixtures.map((fixture) => [fixture.name, pluginCliRange(fixture, overrides.packages, { metadataOnly: args.list })]))
if (args.list) {
    const unknown = fixtures.filter((fixture) => fixture.plugin && !cliRanges.get(fixture.name))
    if (unknown.length) console.warn(`CLI compatibility unknown for ${unknown.map((fixture) => fixture.name).join(', ')}; install fixture dependencies to preview the filtered matrix`)
}
const matrix = planMatrix({ clis, fixtures, cases, plugins, cliRanges })
const selected = fixtures.map(({ name, tags }) => ({ name, tags }))
const provenance = { packages: Object.fromEntries([...overrides.packages].map(([name, entry]) => [name, { version: entry.manifest.version, path: entry.tarball }])), cli: overrides.cli,
    prepared: Object.fromEntries(fixtures.filter((fixture) => preparedFixtures[fixture.name]).map((fixture) => [fixture.name, preparedFixtures[fixture.name]])) }
function frameworkFor(fixture) {
    const file = path.join(fixture.dir, 'package.json')
    if (!existsSync(file)) return null
    const pkg = JSON.parse(readFileSync(file, 'utf8'))
    const name = ['next', 'nuxt', 'vite', 'webpack', 'rollup'].find((candidate) => pkg.dependencies?.[candidate] || pkg.devDependencies?.[candidate])
    if (!name) return null
    const override = overrides.packages.get(name)
    return { name, version: override?.manifest.version ?? (pkg.dependencies?.[name] ?? pkg.devDependencies[name]), path: override?.tarball ?? null }
}
if (args.list) {
    for (const entry of matrix) {
        const framework = frameworkFor(entry.fixture)
        console.log(`${entry.cli.label} (${entry.cli.reported ?? 'baked'}; ${entry.cli.path ?? 'baked'})\t${entry.fixture.name} [${entry.fixture.tags.join(',')}] (${entry.plugin.name}@${entry.plugin.version}; ${framework ? `${framework.name}@${framework.version}` : 'no framework'})\t${entry.kase.name}${entry.skipped ? `\t(skipped: ${entry.skipped})` : ''}`)
    }
    if (overrides.packages.size) console.log(`Overrides: ${JSON.stringify(provenance.packages)}`)
    const uncovered = coverage(fixtures, cases, matrix, matrix.filter((entry) => !entry.skipped).map((entry) => ({ fixture: entry.fixture.name, case: entry.kase.name })))
    console.log(`\n${matrix.filter((entry) => !entry.skipped).length} cells; uncovered: ${uncovered.join(', ') || 'none'}`)
    process.exit(uncovered.length ? 1 : 0)
}
const mounted = args.artifacts ?? (existsSync('/artifacts') ? '/artifacts' : undefined)
const artifactRoot = mounted ?? path.join(root, 'test-results')
mkdirSync(artifactRoot, { recursive: true })
const artifacts = mounted ? artifactRoot : mkdtempSync(path.join(artifactRoot, 'run-'))
console.log(`artifacts: ${artifacts}\nfixtures: ${selected.map((fixture) => fixture.name).join(', ')}\ncli: ${clis.map((cli) => cli.label).join(', ')}`)
const started = Date.now()
const results = []
for (const entry of matrix) {
    const label = `${entry.cli.label}/${entry.fixture.name}/${entry.kase.name}`
    const base = { cli: entry.cli.label, cliPath: entry.cli.path, cliVersion: entry.cli.reported ?? entry.cli.version,
        fixture: entry.fixture.name, tags: entry.fixture.tags, case: entry.kase.name, plugin: `${entry.plugin.name}@${entry.plugin.version}`,
        framework: frameworkFor(entry.fixture), packages: {} }
    if (entry.skipped) {
        results.push({ ...base, ok: false, skipped: entry.skipped, failures: [] })
        console.log(`SKIP ${label}: ${entry.skipped}`)
        continue
    }
    const output = path.join(artifacts, entry.cli.label, entry.fixture.name, entry.kase.name)
    let result
    try {
        const { evidence, work } = await executeCase({ ...entry, overrides: overrides.packages, output })
        const verdict = judge(evidence, entry.kase)
        writeFileSync(path.join(output, 'verdict.json'), JSON.stringify(verdict, null, 2))
        if (verdict.ok && !args['keep-work']) discardWork(work)
        else writeFileSync(path.join(output, 'workspace.txt'), work + '\n')
        result = { ...base, plugin: `${evidence.plugin.name}@${evidence.plugin.version}`,
            packages: evidence.plugin.packages, framework: evidence.plugin.framework, ok: verdict.ok,
            failures: verdict.failures, reuploads: evidence.releases[1]?.uploadedChunkIds.length }
    } catch (error) {
        mkdirSync(output, { recursive: true })
        writeFileSync(path.join(output, 'error.txt'), error.stack + '\n')
        result = { ...base, plugin: null, framework: null, ok: false, failures: [`harness error: ${error.message.split('\n')[0]}`] }
    }
    results.push(result)
    console.log(`${result.ok ? 'PASS' : 'FAIL'} ${label}${result.ok ? '' : ': ' + result.failures[0]}`)
}
const uncovered = coverage(fixtures, cases, matrix, results)
process.exit(saveSummary(artifacts, results, { fixtures: selected, overrides: provenance, uncovered, seconds: (Date.now() - started) / 1000 }) ? 0 : 1)
