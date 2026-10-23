#!/usr/bin/env node
// Keep the Docker dependency layer and CI matrix in step with fixture.json files.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { loadFixtures } from './plan.mjs'

const root = path.resolve(import.meta.dirname, '..')
const expected = loadFixtures(path.join(root, 'fixtures')).map((fixture) => fixture.name).sort()
const docker = readFileSync(path.join(root, 'Dockerfile'), 'utf8')
const workflow = readFileSync(path.join(root, '.github/workflows/run.yml'), 'utf8')
const copied = [...docker.matchAll(/^COPY fixtures\/([^/]+)\/package\.json /gm)].map((match) => match[1]).sort()
const row = /fixture:\s*\[([^\]]+)\]/.exec(workflow)
if (!row) throw new Error('CI fixture matrix not found')
const inCi = row[1].split(',').map((name) => name.trim()).sort()
for (const [source, names] of [['Dockerfile', copied], ['run.yml', inCi]]) {
    if (JSON.stringify(names) !== JSON.stringify(expected)) {
        throw new Error(`${source} fixture list differs from fixture.json files: expected ${expected.join(', ')}, got ${names.join(', ')}`)
    }
}
console.log(`${expected.length} fixtures covered by Docker and CI`)
