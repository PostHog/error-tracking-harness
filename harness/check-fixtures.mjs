#!/usr/bin/env node
// Keep all Docker fixtures installed and the two fixed smoke selections in sync.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { loadFixtures } from './plan.mjs'

const root = path.resolve(import.meta.dirname, '..')
const expected = loadFixtures(path.join(root, 'fixtures')).map((fixture) => fixture.name).sort()
const docker = readFileSync(path.join(root, 'Dockerfile'), 'utf8')
const workflow = readFileSync(path.join(root, '.github/workflows/run.yml'), 'utf8')
const smoke = readFileSync(path.join(root, '.github/workflows/subject-smoke.yml'), 'utf8')
const copied = [...docker.matchAll(/^COPY fixtures\/([^/]+)\/package\.json /gm)].map((match) => match[1]).sort()
if (JSON.stringify(copied) !== JSON.stringify(expected)) {
    throw new Error(`Dockerfile fixture list differs from fixture.json files: expected ${expected.join(', ')}, got ${copied.join(', ')}`)
}
const row = /fixture:\s*\[([^\]]+)\]/.exec(workflow)
const fixed = /^\s+FIXTURES: (.+)$/m.exec(smoke)
if (!row || !fixed) throw new Error('Smoke fixture selection not found')
const inCi = row[1].split(',').map((name) => name.trim()).sort()
const inSmoke = fixed[1].split(',').map((name) => name.trim()).sort()
if (JSON.stringify(inCi) !== JSON.stringify(inSmoke) || inCi.some((name) => !expected.includes(name))) {
    throw new Error(`CI smoke fixtures differ from reusable smoke fixtures: ${inCi.join(', ')} vs ${inSmoke.join(', ')}`)
}
console.log(`${expected.length} fixtures in Docker; ${inCi.length} selected for CI smoke`)
