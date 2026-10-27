import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { loadCases, loadFixtures, planMatrix } from '../plan.mjs'
import { coverage } from '../coverage.mjs'

const root = path.resolve(import.meta.dirname, '../..')

test('reusable smoke workflow selects exactly six single-release cells at one CLI', () => {
    const workflow = readFileSync(path.join(root, '.github/workflows/subject-smoke.yml'), 'utf8')
    const fixtures = /^\s+FIXTURES: (.+)$/m.exec(workflow)?.[1].split(',')
    const cases = /^\s+CASES: (.+)$/m.exec(workflow)?.[1].split(',')
    assert.deepEqual(fixtures, ['rollup-4', 'vite-8-autocapture', 'webpack-5.112', 'next-14', 'next-15', 'nuxt-4'])
    assert.deepEqual(cases, ['baseline/smoke', 'next/smoke', 'nuxt/smoke', 'autoexception/baseline'])
    assert.match(workflow, /--cli 0\.18\.11 --cases "\$CASES"/)
    assert.match(workflow, /docker run --rm --network none/)
    assert.match(workflow, /harness-source-ref:/)
    assert.match(workflow, /docker build --platform linux\/amd64 -t error-tracking-harness:source harness-source/)
    assert.match(workflow, /Use only a 40-character harness-source-ref SHA, not both image and source/)
    const ci = readFileSync(path.join(root, '.github/workflows/run.yml'), 'utf8')
    assert.match(ci, /--cli 0\.18\.11/)
    assert.match(ci, /--cases baseline\/smoke,next\/smoke,nuxt\/smoke,autoexception\/baseline/)
    const selectedFixtures = loadFixtures(path.join(root, 'fixtures'), fixtures)
    const selectedCases = loadCases(path.join(root, 'harness/cases'), cases.join(','))
    assert.deepEqual(selectedCases.map(({ name }) => name).sort(), [...cases].sort())
    assert.ok(selectedCases.every(({ releases = 1 }) => releases === 1))
    const matrix = planMatrix({
        clis: [{ label: '0.18.11', version: '0.18.11' }],
        fixtures: selectedFixtures,
        cases: selectedCases,
        plugins: new Map(selectedFixtures.map((fixture) => [fixture.name, {}])),
    })
    assert.equal(matrix.length, 6)
    assert.equal(matrix.filter(({ skipped }) => skipped).length, 0)
    assert.deepEqual(coverage(selectedFixtures, selectedCases, matrix,
        matrix.map(({ fixture, kase }) => ({ fixture: fixture.name, case: kase.name }))), [])
})
