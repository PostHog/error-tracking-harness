// Coverage is derived from selected metadata, not from rows that happened to be planned.
// A skipped cell does not cover a fixture/case pair; report why every missing pair is uncovered.
export function coverage(fixtures, cases, matrix, results) {
    const pairs = fixtures.flatMap((fixture) => cases
        .filter((kase) => (kase.mode ?? 'plugin') === (fixture.mode ?? 'plugin'))
        .map((kase) => `${fixture.name}/${kase.name}`))
    if (!pairs.length) return [`no applicable case for selected fixtures ${fixtures.map((fixture) => fixture.name).join(', ')} and cases ${cases.map((kase) => kase.name).join(', ')}`]
    const executed = new Set(results.filter((result) => !result.skipped).map((result) => `${result.fixture}/${result.case}`))
    return pairs.filter((pair) => !executed.has(pair)).map((pair) => {
        const rows = matrix.filter(({ fixture, kase }) => `${fixture.name}/${kase.name}` === pair)
        return `${pair} (${rows.length ? `all cells skipped: ${[...new Set(rows.map((row) => row.skipped ?? 'not executed'))].join('; ')}` : 'no CLI cell planned'})`
    })
}
