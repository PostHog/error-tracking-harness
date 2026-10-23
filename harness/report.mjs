// Renders a run's summary as a markdown matrix: one row per fixture and case, one column per CLI.
export function renderReport(summary) {
    const clis = [...new Set(summary.results.map((result) => result.cli))]
    const rows = new Map()
    for (const result of summary.results) {
        const key = `${result.fixture} · ${result.case}`
        if (!rows.has(key)) rows.set(key, { fixture: result.fixture, case: result.case, plugin: result.plugin, cells: {} })
        rows.get(key).cells[result.cli] = result
    }
    const cell = (result) => {
        if (!result) return '–'
        if (result.skipped) return `⏭ ${result.skipped}`
        const detail = result.reuploads === undefined ? '' : ` (${result.reuploads} re-uploaded)`
        return result.ok ? `✅${detail}` : `❌ ${result.failures[0]}`
    }
    const lines = [
        `# Error tracking harness run`,
        '',
        `${summary.passed}/${summary.total} passed, ${summary.skipped} skipped, ${summary.seconds.toFixed(0)}s. Plugins: ${summary.plugins}.`,
        '',
        `| fixture | case | plugin | ${clis.join(' | ')} |`,
        `|---|---|---|${clis.map(() => '---').join('|')}|`,
    ]
    for (const row of rows.values()) {
        lines.push(`| ${row.fixture} | ${row.case} | ${row.plugin} | ${clis.map((cli) => cell(row.cells[cli])).join(' | ')} |`)
    }
    const failed = summary.results.filter((result) => !result.ok && !result.skipped)
    if (failed.length) {
        lines.push('', '## Failures', '')
        for (const result of failed) {
            lines.push(`### ${result.cli} · ${result.fixture} · ${result.case}`, '')
            for (const failure of result.failures) lines.push(`- ${failure}`)
            lines.push('')
        }
    }
    return lines.join('\n') + '\n'
}
