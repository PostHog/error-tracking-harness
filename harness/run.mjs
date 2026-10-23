#!/usr/bin/env node
// Entry point. Plans the matrix, executes each cell, judges the evidence, writes the report.
//
//   node harness/run.mjs [--cli 0.18.11,0.18.12] [--cli-binary /path/to/posthog-cli]
//                        [--fixtures webpack-5.112,vite-8] [--cases 'baseline/*']
//                        [--plugins floor|latest|subject] [--subject /subject]
//                        [--artifacts dir] [--list] [--judge-only <run dir>]
// Inside the image, /subject and /artifacts are picked up when mounted; no arguments runs everything.
import { parseArgs } from 'node:util'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { loadCases, loadFixtures, planMatrix } from './plan.mjs'
import { loadSubject, selectedPlugin } from './subject.mjs'
import { executeCase, discardWork } from './execute.mjs'
import { judge } from './judge.mjs'
import { renderReport } from './report.mjs'

const root = path.resolve(import.meta.dirname, '..')
const { values: args } = parseArgs({
    options: {
        cli: { type: 'string' },
        'cli-binary': { type: 'string' },
        fixtures: { type: 'string' },
        cases: { type: 'string' },
        plugins: { type: 'string' },
        subject: { type: 'string', default: '/subject' },
        artifacts: { type: 'string' },
        list: { type: 'boolean', default: false },
        'judge-only': { type: 'string' },
        'keep-work': { type: 'boolean', default: false },
    },
})
const list = (value) => value?.split(',').map((item) => item.trim()).filter(Boolean)

// The judge is pure, so a saved run can be judged again after a case changes.
if (args['judge-only']) {
    const runDir = args['judge-only']
    const cases = new Map(loadCases(path.join(root, 'harness/cases')).map((kase) => [kase.name, kase]))
    let failed = 0
    for (const file of readdirSync(runDir, { recursive: true }).map(String).filter((file) => file.endsWith('evidence.json'))) {
        const evidence = JSON.parse(readFileSync(path.join(runDir, file), 'utf8'))
        const verdict = judge(evidence, cases.get(evidence.case))
        writeFileSync(path.join(runDir, path.dirname(file), 'verdict.json'), JSON.stringify(verdict, null, 2))
        console.log(`${verdict.ok ? 'PASS' : 'FAIL'} ${evidence.cli.label}/${evidence.fixture.name}/${evidence.case}${verdict.ok ? '' : ': ' + verdict.failures[0]}`)
        if (!verdict.ok) failed++
    }
    process.exit(failed ? 1 : 0)
}

// Baked binaries live in /opt/posthog-cli inside the image. Outside it, versions are fetched on
// demand into a cache, from the same GitHub release assets the image uses.
const cliDir = process.env.HARNESS_CLI_DIR ?? (existsSync('/opt/posthog-cli') ? '/opt/posthog-cli' : path.join(homedir(), '.cache/error-tracking-harness/cli'))
function triple() {
    const arch = { arm64: 'aarch64', x64: 'x86_64' }[process.arch]
    const os = { linux: 'unknown-linux-gnu', darwin: 'apple-darwin' }[process.platform]
    if (!arch || !os) throw new Error(`No posthog-cli build for ${process.platform}/${process.arch}`)
    return `${arch}-${os}`
}
function ensureCli(version) {
    const binary = path.join(cliDir, version, 'posthog-cli')
    if (!existsSync(binary)) {
        if (cliDir === '/opt/posthog-cli') throw new Error(`posthog-cli ${version} is not baked into this image (see cli-versions.txt)`)
        mkdirSync(path.dirname(binary), { recursive: true })
        const asset = `posthog-cli-${triple()}.tar.gz`
        const url = `https://github.com/PostHog/posthog/releases/download/posthog-cli/v${version}/${asset}`
        console.log(`fetching ${url}`)
        execFileSync('sh', ['-c', `curl -fsSL "${url}" | tar -xz --strip-components=1 -C "${path.dirname(binary)}"`], { stdio: 'inherit' })
    }
    const reported = execFileSync(binary, ['--version'], { encoding: 'utf8' }).trim()
    if (!reported.includes(version)) throw new Error(`${binary} reports "${reported}", expected ${version}`)
    return { label: version, version, path: binary }
}

const clis = list(args.cli)?.map(ensureCli) ?? []
if (args['cli-binary']) {
    const binary = path.resolve(args['cli-binary'])
    const reported = execFileSync(binary, ['--version'], { encoding: 'utf8' }).trim()
    clis.push({ label: 'custom', version: 'custom', reported, path: binary })
}
if (!clis.length) {
    const baked = existsSync(cliDir) ? readdirSync(cliDir).filter((name) => existsSync(path.join(cliDir, name, 'posthog-cli'))) : []
    const versions = baked.length ? baked : readFileSync(path.join(root, 'cli-versions.txt'), 'utf8').split(/\s+/).filter(Boolean)
    clis.push(...versions.map(ensureCli))
}

const fixtures = loadFixtures(path.join(root, 'fixtures'), list(args.fixtures))
const cases = loadCases(path.join(root, 'harness/cases'), args.cases)
const subject = loadSubject(args.subject)
const selection = args.plugins ?? (subject.size ? 'subject' : 'latest')
if (selection === 'subject' && !subject.size) throw new Error(`--plugins subject but no tarballs in ${args.subject}`)
const plugins = new Map(fixtures.map((fixture) => [fixture.name, selectedPlugin(fixture, selection, subject)]))
const matrix = planMatrix({ clis, fixtures, cases, plugins })

if (args.list) {
    for (const entry of matrix) {
        console.log(`${entry.cli.label}\t${entry.fixture.name} (${entry.plugin.name}@${entry.plugin.version})\t${entry.kase.name}${entry.skipped ? `\t(skipped: ${entry.skipped})` : ''}`)
    }
    console.log(`\n${matrix.filter((entry) => !entry.skipped).length} cells, plugins: ${selection}`)
    process.exit(0)
}


// Inside the image /artifacts is the caller's mount; outside, each run gets its own directory.
const mounted = args.artifacts ?? (existsSync('/artifacts') ? '/artifacts' : undefined)
const artifactRoot = mounted ?? path.join(root, 'test-results')
mkdirSync(artifactRoot, { recursive: true })
const artifacts = mounted ? artifactRoot : mkdtempSync(path.join(artifactRoot, 'run-'))
console.log(`artifacts: ${artifacts}\nplugins: ${selection}\ncli: ${clis.map((cli) => cli.label).join(', ')}`)
const started = Date.now()
const results = []
for (const entry of matrix) {
    const label = `${entry.cli.label}/${entry.fixture.name}/${entry.kase.name}`
    const base = { cli: entry.cli.label, fixture: entry.fixture.name, case: entry.kase.name, plugin: `${entry.plugin.name}@${entry.plugin.version}` }
    if (entry.skipped) {
        results.push({ ...base, ok: true, skipped: entry.skipped, failures: [] })
        console.log(`SKIP ${label}: ${entry.skipped}`)
        continue
    }
    const output = path.join(artifacts, entry.cli.label, entry.fixture.name, entry.kase.name)
    let result
    try {
        const { evidence, work } = await executeCase({ ...entry, selection, subject, output })
        const verdict = judge(evidence, entry.kase)
        writeFileSync(path.join(output, 'verdict.json'), JSON.stringify(verdict, null, 2))
        if (verdict.ok && !args['keep-work']) discardWork(work)
        else writeFileSync(path.join(output, 'workspace.txt'), work + '\n')
        result = {
            ...base,
            plugin: `${evidence.plugin.name}@${evidence.plugin.version}`,
            ok: verdict.ok,
            failures: verdict.failures,
            reuploads: evidence.releases[1]?.uploadedChunkIds.length,
        }
    } catch (error) {
        mkdirSync(output, { recursive: true })
        writeFileSync(path.join(output, 'error.txt'), error.stack + '\n')
        result = { ...base, ok: false, failures: [`harness error: ${error.message.split('\n')[0]}`] }
    }
    results.push(result)
    console.log(`${result.ok ? 'PASS' : 'FAIL'} ${label}${result.ok ? '' : ': ' + result.failures[0]}`)
}

const summary = {
    seconds: (Date.now() - started) / 1000,
    plugins: [...new Set(results.map((result) => result.plugin).filter(Boolean))].join(', ') || selection,
    total: results.filter((result) => !result.skipped).length,
    passed: results.filter((result) => result.ok && !result.skipped).length,
    skipped: results.filter((result) => result.skipped).length,
    results,
}
writeFileSync(path.join(artifacts, 'summary.json'), JSON.stringify(summary, null, 2))
writeFileSync(path.join(artifacts, 'report.md'), renderReport(summary))
console.log(`\n${summary.passed}/${summary.total} passed (${summary.skipped} skipped) in ${summary.seconds.toFixed(0)}s; report: ${path.join(artifacts, 'report.md')}`)
process.exit(summary.passed === summary.total ? 0 : 1)
